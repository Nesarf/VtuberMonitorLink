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
import { socksAgent, socksForPlaywright } from './socks.js';
import { decision as autoDecision } from './egress.js';

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

/** proxy option for Playwright's launch/newContext */
export function playwrightProxy(cfg, mode) {
  if (mode === 'direct') return undefined;
  if (mode === 'tor' || (mode === undefined && cfg?.proxy?.mode === 'tor')) return socksForPlaywright(torSocksUrl(cfg));
  const want = httpProxyUrl(cfg);
  return want ? { server: want } : undefined;
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
 * A fetch with an explicitly chosen egress.
 * @param {string} url
 * @param {object} opts  fetch options (the dispatcher gets overridden)
 * @param {{cfg?:object, subject?:object, mode?:'direct'|'proxy'|'tor'}} sel
 */
export async function netFetch(url, opts = {}, sel = {}) {
  const mode = isLoopback(url) ? 'direct' : sel.mode ?? resolveProxyMode(sel.cfg, sel.subject);
  // subject is passed down for exit rotation in observation mode (one source stays on one
  // circuit, different sources spread across different exits - neither "one exit serves
  // everything" nor a new connection every time, which would cost reconnects)
  return undiciFetch(url, { ...opts, dispatcher: dispatcherFor(sel.cfg, mode, sel.subject) });
}

/** For callers that need their own Agent (e.g. probing port by port) */
export function makeProxyAgent(url) {
  return new ProxyAgent(url);
}

export { directAgent };
