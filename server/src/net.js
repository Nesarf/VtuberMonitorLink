// net.js - networking layer
// Background (measured):
//  1) Node's fetch uses undici and **does not read the system proxy by default**; wherever
//     direct connections are blocked, every fetch ends in ECONNRESET / a connect timeout, so
//     the proxy has to be configured explicitly.
//  2) Conversely, **some sites get blocked precisely when going through a proxy**: measured, one such
//     site answers a bare 4xx through a proxy (risk control) and only works direct. So the
//     proxy cannot be an all-or-nothing global switch; it must support per-source overrides.
//
// So this module provides all three:
//   - applyProxy()      the global default (undici's global dispatcher)
//   - netFetch()        a fetch with explicit direct / proxy egress
//   - playwrightProxy() the browser-side proxy (can be turned off per source)
import crypto from 'node:crypto';
import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { socksAgent, socksForPlaywright, torPortOpen } from './socks.js';
import { decision as autoDecision } from './egress.js';
import { urlClearedFor, validateRemoteUrl } from './remote-url.js';

/**
 * How many redirect hops netFetch will walk before refusing. Eight is the usual browser limit; the number
 * matters less than the fact that there *is* one, because "follow until it stops" lets a server hold this
 * process in a loop of its own making.
 */
const MAX_REDIRECT_HOPS = 8;

let appliedUrl = null;
let appliedMode = null;
let proxyAgent = null;
const directAgent = new Agent();

/** the currently applied global egress (null = direct) */
export function currentProxy() {
  return appliedUrl;
}

export function currentMode() {
  return appliedMode;
}

/** the Tor SOCKS endpoint from config */
export function torSocksUrl(cfg) {
  return String(cfg?.proxy?.torSocks ?? '').trim() || 'socks5://127.0.0.1:9150';
}

/**
 * The Tor egress URL, optionally **on a fresh circuit every time**.
 *
 * How it works: Tor's IsolateSOCKSAuth (on by default) isolates circuits by SOCKS username:
 * different username → different circuit → different exit IP. Measured (2026-09-12):
 *   obs1:x → 192.42.116.48   obs2:x → 193.189.100.201   obs3:x → 45.84.107.174
 * while repeated requests without a username all landed on the same exit (199.195.253.124) -
 * meaning **by default a whole patrol round wears one face**, which is what makes rotation
 * meaningful.
 *
 * Note: rotating the exit does not change the more important signal, the request content; it
 * only stops a single observation round from riding entirely on one exit (together with
 * sampling, a single observation no longer points at "someone watching the whole box").
 */
export function torEgressUrl(cfg, { rotate = null, tag = null } = {}) {
  const base = torSocksUrl(cfg);
  const on = rotate ?? cfg?.observation?.rotateExit ?? false;
  if (!on) return base;
  const name = tag || `obs-${crypto.randomBytes(4).toString('hex')}`;
  // The username is embedded in the URL: socksConnector then takes the username/password auth
  // path (Tor only uses it for isolation)
  return base.replace(/^socks5:\/\//, `socks5://${name}:x@`);
}

function httpProxyUrl(cfg) {
  return cfg?.proxy?.enabled ? String(cfg.proxy.url ?? '').trim() : '';
}

/**
 * Apply the global egress from config; calling it again with the same value is a no-op.
 * @returns {{applied: string|null, mode:'direct'|'http'|'tor', changed: boolean}}
 */
export async function applyProxy(cfg) {
  const mode = cfg?.proxy?.mode === 'tor' ? 'tor' : cfg?.proxy?.enabled ? 'http' : 'direct';
  const want = mode === 'http' ? httpProxyUrl(cfg) : mode === 'tor' ? torSocksUrl(cfg) : '';
  if (want === appliedUrl && mode === appliedMode) {
    return { applied: appliedUrl, mode, changed: false };
  }

  if (mode === 'tor') {
    setGlobalDispatcher(socksAgent(want));
  } else if (mode === 'http') {
    proxyAgent = new ProxyAgent(want);
    setGlobalDispatcher(proxyAgent);
  } else {
    setGlobalDispatcher(directAgent);
  }
  appliedUrl = mode === 'direct' ? null : want;
  appliedMode = mode;
  return { applied: appliedUrl, mode, changed: true };
}

/**
 * proxy option for Playwright's launch/newContext.
 *
 * A measured limit is recorded here because it is a **property of the browser**, not of this function, and
 * the next person to reach for stream isolation will look in this place:
 *
 *   Playwright's Firefox cannot authenticate to a SOCKS5 proxy. Given `socks5://user:pass@host:port` it
 *   offers only the "no authentication" method on the wire (a recording SOCKS5 server saw method 0), and
 *   given the explicit `proxy: { server, username, password }` fields it refuses the launch outright with
 *   "Browser does not support socks5 proxy authentication". Setting Firefox's own
 *   `network.proxy.socks_username` / `socks_password` prefs changes nothing (also measured).
 *
 *   Consequence, stated rather than hidden: a browser fetch through Tor lands on the **default circuit**
 *   (empty SOCKS username), while every non-browser fetch still rotates per subject through
 *   dispatcherFor()'s IsolateSOCKSAuth username. The username is therefore not put on the browser's proxy
 *   at all — putting it there would only look like isolation while the wire carried none.
 */
export function playwrightProxy(cfg, mode) {
  if (mode === 'direct') return undefined;
  if (mode === 'tor' || (mode === undefined && cfg?.proxy?.mode === 'tor')) return socksForPlaywright(torSocksUrl(cfg));
  const want = httpProxyUrl(cfg);
  return want ? { server: want } : undefined;
}

/**
 * The egress one browser launch must use, or a reason it cannot be used.
 *
 * This is the seam between "which door" (egress.js / resolveProxyMode, shared with every other fetch) and
 * "start a browser" — and it exists because of one specific failure the owner will otherwise meet on a
 * machine where Tor is simply not running: a raw Juggler `NS_ERROR_PROXY_CONNECTION_REFUSED` is accurate
 * and tells nobody anything. The SOCKS port is therefore probed with a plain TCP connect **before** a
 * browser is started (measured: a browser launched against a refusing SOCKS port fails the navigation
 * rather than falling back to a direct connection, so the probe is not hiding a working path — it only
 * replaces a confusing error with the actual reason).
 *
 * `probePort` is injectable so the decision can be pinned offline, with a control that must not be
 * described as a proxy problem.
 *
 * @returns {Promise<{ok:true, mode:string, proxy:object|undefined}|{ok:false, mode:string, error:string}>}
 */
export async function resolveBrowserEgress(cfg, subject = null, { probePort = torPortOpen } = {}) {
  const mode = resolveProxyMode(cfg, subject);
  if (mode === 'tor') {
    const socks = torSocksUrl(cfg);
    const open = await probePort(socks).catch(() => false);
    if (!open) {
      return {
        ok: false,
        mode,
        error: `Tor 出口不可用：SOCKS 端口拒绝连接（${socks}）—— Tor 没在跑 / Tor egress unavailable: the SOCKS port refuses (${socks}) — Tor is not running`,
      };
    }
  }
  return { ok: true, mode, proxy: playwrightProxy(cfg, mode) };
}

/**
 * Resolve which route a source / watch target actually takes.
 * source.proxy: 'direct' | 'proxy' | 'tor' | 'auto' | undefined (auto: follow the global until probed)
 *
 * Auto mode (the default): scores by "effective latency = avg × (1 + packet loss × 4)" and is
 * sticky - see egress.js. A source with an explicit egress always wins (a source measured worse through
 * the proxy pins its own egress to 'direct', and auto mode is not allowed to overrule that measured
 * conclusion).
 * @returns {'direct'|'proxy'|'tor'}
 */
export function resolveProxyMode(cfg, subject) {
  const want = subject?.proxy;
  if (want === 'direct') return 'direct';
  if (want === 'tor') return 'tor';
  if (want === 'proxy') return 'proxy';

  // auto (or unspecified): first look for a probe verdict, otherwise follow the global config
  if (want === 'auto' || want === undefined || want === null || want === '') {
    const d = autoDecision(cfg, subject);
    if (d && d.mode) return d.mode;
  }
  if (cfg?.proxy?.mode === 'tor') return 'tor';
  return cfg?.proxy?.enabled ? 'proxy' : 'direct';
}

/** Loopback addresses always go direct: handing 127.0.0.1 to a proxy only fails (local Ollama / mock both behave this way) */
function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/** the dispatcher for an egress mode */
export function dispatcherFor(cfg, mode, subject = null) {
  if (mode === 'tor') {
    // In observation mode every call uses a different SOCKS username → a different circuit →
    // a different exit. socksForPlaywright gets the same URL, so browser fetching benefits too.
    const rotate = !!cfg?.observation?.enabled && cfg?.observation?.rotateExit !== false;
    return socksAgent(torEgressUrl(cfg, { rotate, tag: subject ? `obs-${String(subject.id ?? subject.uid ?? 'x')}` : null }));
  }
  if (mode === 'proxy') {
    const want = httpProxyUrl(cfg);
    if (!want) throw new Error('该来源要求走代理，但代理未启用 / proxy required but not enabled');
    if (!proxyAgent || appliedUrl !== want || appliedMode !== 'http') {
      proxyAgent = new ProxyAgent(want);
      appliedUrl = want;
      appliedMode = 'http';
    }
    return proxyAgent;
  }
  return directAgent;
}

/**
 * A fetch with an explicitly chosen egress, where **every redirect hop is checked**.
 *
 * Why this is a loop rather than one call. Measured while this was written (a local server answering 302 to
 * /final, Node 24 / undici 7): `fetch(url)` with no `redirect` option answers `status=200 redirected=true`
 * and the server log shows *both* requests - undici follows the chain internally, so this process never sees
 * the intermediate address. That makes the obvious policy ("check the URL") a hole exactly the size of a
 * redirect: a URL that passes can answer `Location: http://127.0.0.1:43110/api/config`, and the fetch lands
 * on this app's own config route with no check in between. Measured in the same run: `redirect: 'manual'`
 * returns the 302 itself (the server log shows one request), which is what makes a per-hop check possible.
 *
 * So `redirect` is forced to `'manual'` **here**, for every caller, and the chain is walked by hand:
 *   1) each hop's URL goes through validateRemoteUrl (server/src/remote-url.js) before a request is made;
 *   2) the next URL is resolved against the current one (`new URL(location, current)`) so a relative
 *      `Location: /admin` is checked as the absolute address it actually is;
 *   3) a 303, or a 301/302 answering a non-GET/HEAD, switches the method to GET and drops the body - the
 *      fetch spec's rule, and skipping it would send a POST body to a redirect target that was just accepted
 *      as a *different* address (watch.js POSTs a wiki password; that is the request this protects);
 *   4) the allowance travels with the chain: the caller's `allowLoopback` rides along, so a loopback fixture
 *      that redirects within loopback still works, and nothing else gains the allowance by being redirected.
 *
 * Two options are deliberately **not** honoured.
 *   - `redirect: 'follow'` cannot mean what it says: following is implemented here, hop by hop, because a
 *     fetch that follows a hop without telling us is the hole this code exists to close. Passing undici's
 *     default is therefore the same as saying nothing.
 *   - `dispatcher` is overridden, as it always was in this function: the egress is this project's decision
 *     (net.js / egress.js), not the caller's.
 *
 * `sel.redirect: false` (or `opts.redirect: 'manual'`) returns the 3xx to the caller untouched - used by the
 * test to watch a hop boundary directly, and the honest way to say "do not follow".
 *
 * @param {string} url
 * @param {object} opts  fetch options (the dispatcher and redirect get overridden)
 * @param {{cfg?:object, subject?:object, mode?:'direct'|'proxy'|'tor', policy?:object, redirect?:boolean}} sel
 */
export async function netFetch(url, opts = {}, sel = {}) {
  const mode = isLoopback(url) ? 'direct' : sel.mode ?? resolveProxyMode(sel.cfg, sel.subject);
  const dispatcher = dispatcherFor(sel.cfg, mode, sel.subject);
  // On a proxy/Tor egress the *exit* resolves and connects, so asking whether this machine can resolve the
  // name is a statement about the wrong machine (see the header of remote-url.js). The caller's own policy
  // wins over this default, so a caller may still force the check.
  const policy = { skipDns: mode !== 'direct', ...(sel.policy ?? {}) };
  const follow = opts.redirect !== 'manual' && sel.redirect !== false;

  let current = String(url);
  let method = String(opts.method ?? 'GET').toUpperCase();
  let bodyOpt = opts.body;
  let headers = opts.headers;

  // A URL a caller already judged (llm.js's request builder hands its checked address on) carries that verdict
  // beside it (see urlClearedFor in remote-url.js). It is honoured **only for the first hop, and only when the
  // verdict was reached under a policy at least as strict as the one in force here** — a redirect target is
  // never marked, so every hop after the first is checked in full.
  const markedFirstHop = hop0 => hop0 === 0 && urlClearedFor(current, policy);

  for (let hop = 0; ; hop++) {
    const check = markedFirstHop(hop) ? { ok: true, url: current } : await validateRemoteUrl(current, policy);
    if (!check.ok) {
      // The refusal is thrown, not returned: every existing caller already catches a failed fetch and turns
      // it into `{ok:false, error}` (that is what a network error does today), so a refusal surfaces through
      // the same path with the one thing the caller did not have before - a reason that says *why* the
      // address was refused rather than a socket error.
      const err = new Error(`${check.message} [hop ${hop}]`);
      err.code = check.code;
      err.urlRefused = true;
      err.host = check.host;
      err.hop = hop;
      throw err;
    }
    const res = await undiciFetch(check.url, { ...opts, method, body: bodyOpt, headers, redirect: 'manual', dispatcher });
    const status = res.status;
    const location = res.headers.get('location');
    if (!follow || ![301, 302, 303, 307, 308].includes(status) || !location) return res;
    const next = (() => {
      try {
        return new URL(location, check.url).href;
      } catch {
        return null;
      }
    })();
    // Cancel the hop's body before deciding: every path from here either starts a new request or throws, and
    // a 3xx body that is never read holds a socket open.
    await res.body?.cancel?.().catch(() => {});
    if (next === null || next === check.url) {
      const err = new Error(
        next === null ? `the redirect target is not a usable URL: ${location}` : `the redirect points back at itself: ${check.url}`
      );
      err.code = next === null ? 'redirect-hop' : 'redirect-loop';
      err.urlRefused = true;
      err.hop = hop;
      throw err;
    }
    if (hop + 1 >= MAX_REDIRECT_HOPS) {
      const err = new Error(`too many redirects (${MAX_REDIRECT_HOPS}) starting at ${url}`);
      err.code = 'too-many-redirects';
      err.urlRefused = true;
      err.hop = hop;
      throw err;
    }
    if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      bodyOpt = undefined;
      // Content-length/type belong to the body that was just dropped; keeping them would describe a request
      // that is no longer being made.
      if (headers && typeof headers === 'object') {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(length|type)$/i.test(k)));
      }
    }
    current = next;
  }
}

/** For callers that need their own Agent (e.g. probing port by port) */
export function makeProxyAgent(url) {
  return new ProxyAgent(url);
}

export { directAgent };
