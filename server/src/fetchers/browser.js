// fetchers/browser.js — browser-rendered fetching (Playwright)
//
// The engine is Firefox, and only Firefox. The Chromium half is **removed**, not defaulted away: a
// package that can silently fall back to "whatever browser happens to be installed" is a package whose
// behaviour nobody can state, and the payload it used to ship is what this round is about.
//
// Measured before the swap, with a throwaway probe against Playwright's `firefox-1543` (Firefox 155.0)
// installed to a non-system drive — the probe is gone, so the numbers that matter are written here and the
// parts that can be re-checked offline are pinned in tools/browser-engine-test.mjs:
//   • `firefox.launchPersistentContext(<profile dir>)` works, so **the login-reuse feature is intact**;
//     this was the load-bearing question, because the whole profile feature is built on it;
//   • cookies written inside that context survive `close()` and a reopen of the same profile dir:
//     `cookies.sqlite` is on disk afterwards and still holds them, in plaintext (see server/src/cookies.js);
//   • a profile directory named by the **installed** Firefox's own `profiles.ini` launches through the same
//     call, which is the case login reuse is actually for;
//   • `proxy: { server: 'socks5://127.0.0.1:<port>' }` really reaches the network stack: a local SOCKS5
//     recorder saw the CONNECT for the target host and the page content came back through it;
//   • and when that SOCKS port refuses, the navigation fails with `NS_ERROR_PROXY_CONNECTION_REFUSED`
//     rather than silently going direct — the honest signal the Tor arm below is built on.
//
// The other four points (all of them learned the hard way):
//  1) the browser engine is configurable: bundled (the Firefox shipped with the package) / system
//     (already installed) / custom (a user-given path)
//  2) reusing a login needs profileDir; at which point **the browser must be closed**, otherwise the
//     profile stays locked
//  3) SPA pages make close() hang — a bounded teardown + a hard watchdog, so the process is
//     guaranteed to exit
//  4) the egress is this project's own (server/src/net.js / egress.js): a browser-rendered source goes
//     out the same way every other fetch does — direct, the configured HTTP proxy, or **Tor** — and
//     Tor being down is a *reason*, never a crash: the SOCKS port is probed before the browser starts,
//     so "the SOCKS port refuses" is what the caller is told.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright';
import { APP_ROOT } from '../config.js';
import { resolveBrowserEgress, torSocksUrl } from '../net.js';
import { resolveProfileDir } from '../browser-target.js';
import { sourcePolicy } from '../sources.js';
import { validateRemoteUrl } from '../remote-url.js';

/**
 * The file that marks a **Playwright Firefox build**, as opposed to a Firefox a user installed.
 *
 * This distinction is not cosmetic, it is the difference between a browser that launches and one that does
 * not. Measured on this machine:
 *   • `firefox.launch({ executablePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' })` fails with
 *     "browserType.launch: Failed to launch the browser process" — Playwright drives its **own patched
 *     Firefox** (it speaks the Juggler protocol, which stock Firefox does not implement);
 *   • that build ships `playwright.cfg` next to `firefox.exe`, and a stock install does not.
 *
 * So "which browsers does this machine have" has to mean "which browsers Playwright can drive", or the
 * picker offers paths that fail the moment they are used.
 */
const PLAYWRIGHT_FIREFOX_MARKER = 'playwright.cfg';

/**
 * Where Playwright keeps the engines it installed, in the order it resolves them.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` wins because that is the switch this project already uses (launcher/launch.cjs
 * points it at the package's own `pw-browsers/`, and `config.paths.browsersDir` writes it at startup).
 *
 * Then the **repository's own `pw-browsers/`**, and this root has a reason of its own: the project's disk
 * discipline keeps multi-hundred-megabyte engines off the system drive, so in a source checkout the engine
 * lives inside the repository and no environment variable says so. Without this root a development run -
 * and every tool that resolves the engine the way the app does - would look only in the platform default
 * location and conclude that a machine with an engine has none. It sits **after** the configured switch,
 * so an explicit choice always wins, and **before** the platform defaults, so a checkout that carries its
 * own engine is not second-guessed by a stale install somewhere else.
 *
 * The platform defaults stay listed rather than assumed absent - including the C: drive one this project's
 * "never write to C:" rule exists to avoid, which is exactly why it is named rather than skipped.
 */
export function firefoxBuildRoots() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const out = [];
  const configured = String(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '').trim();
  if (configured) out.push(configured);
  out.push(path.join(APP_ROOT, 'pw-browsers'));
  if (process.platform === 'win32') out.push(path.join(local, 'ms-playwright'));
  else if (process.platform === 'darwin') out.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  else out.push(path.join(home, '.cache', 'ms-playwright'));
  return out;
}

/** Whether this executable is one Playwright can actually drive (see PLAYWRIGHT_FIREFOX_MARKER) */
export function isPlaywrightFirefox(executablePath) {
  if (!executablePath) return false;
  try {
    return fs.existsSync(path.join(path.dirname(executablePath), PLAYWRIGHT_FIREFOX_MARKER));
  } catch {
    return false;
  }
}

/**
 * Detect the Firefox builds Playwright can drive on this machine.
 *
 * `extraRoots` lets a caller add a root it knows about (the app passes `config.paths.browsersDir`, which is
 * the setting that decides where engines live when PLAYWRIGHT_BROWSERS_PATH is not already set).
 *
 * @returns {Array<{name:string, executablePath:string, playwright:boolean}>}
 */
export function detectBrowsers({ extraRoots = [] } = {}) {
  const exe = process.platform === 'win32' ? 'firefox.exe' : 'firefox';
  const roots = [...extraRoots.filter(Boolean), ...firefoxBuildRoots()];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Playwright names these directories `firefox-<build>`; requiring the prefix keeps a stray
      // "firefox" folder in the same root from being presented as an engine.
      if (!e.isDirectory() || !e.name.toLowerCase().startsWith('firefox')) continue;
      const candidate = path.join(root, e.name, 'firefox', exe);
      let abs;
      try {
        if (!fs.existsSync(candidate)) continue;
        abs = path.resolve(candidate);
      } catch {
        continue;
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ name: `Playwright Firefox (${e.name})`, executablePath: abs, playwright: isPlaywrightFirefox(abs) });
    }
  }
  return out;
}

/**
 * Resolve launch options from config.
 *
 * Nothing Chromium-shaped is left in here on purpose. `--no-sandbox` / `--disable-dev-shm-usage` were
 * Chromium process flags (a container without user namespaces needs the first one); Playwright hands
 * `args` straight to the browser process, and Firefox has no such switch — passing them would be
 * either ignored or mistaken for something else, and neither is a behaviour worth keeping.
 *
 * There is also **no user-agent override**: the old constant existed because Playwright's Chromium
 * announced itself as `HeadlessChrome`, which made sites serve a different page. Measured on this
 * engine, the headless Firefox context reports the same ordinary
 * `Mozilla/5.0 (…; rv:155.0) Gecko/20100101 Firefox/155.0` — so the truthful UA is already being sent
 * and a hard-coded string would only pin a version the engine is not.
 */
export function resolveLaunch(browserCfg = {}) {
  const opts = { headless: browserCfg.headless !== false };
  if (browserCfg.mode === 'system' || browserCfg.mode === 'custom') {
    if (!browserCfg.executablePath) {
      throw new Error(
        browserCfg.mode === 'system'
          ? '未选择系统浏览器 / no system browser selected'
          : '未填写浏览器路径 / custom browser path is empty'
      );
    }
    if (!fs.existsSync(browserCfg.executablePath)) {
      throw new Error(`浏览器不存在 / browser not found: ${browserCfg.executablePath}`);
    }
    // A stock Firefox is refused **here**, with the reason, rather than three seconds later as
    // "Failed to launch the browser process" (see PLAYWRIGHT_FIREFOX_MARKER for the measurement). This is
    // the single most likely mistake once the engine is Firefox — with Chromium, "point it at the Chrome
    // you already have" was correct advice, and it no longer is — so the message carries the fix.
    if (!isPlaywrightFirefox(browserCfg.executablePath)) {
      throw new Error(
        `这个 Firefox 不是 Playwright 的构建，Playwright 无法驱动它（缺少 ${PLAYWRIGHT_FIREFOX_MARKER}）/ ` +
          `this looks like a stock Firefox, which Playwright cannot drive (no ${PLAYWRIGHT_FIREFOX_MARKER} beside it): ${browserCfg.executablePath}\n` +
          `  装一个 Playwright 自带的内核 / install one: npx playwright install firefox（或用「随包」模式，或把 paths.browsersDir 指到已有的 pw-browsers）`
      );
    }
    opts.executablePath = browserCfg.executablePath;
  }
  // mode === 'bundled' hands the job to the Firefox Playwright ships with
  return opts;
}

/**
 * Turn a browser failure into a sentence the report can use, naming the egress when the egress is the
 * cause. Pure, and tested by tools/browser-engine-test.mjs with a control that must *not* be described
 * as a proxy problem.
 *
 * Why this exists: the Juggler message for a dead Tor (`NS_ERROR_PROXY_CONNECTION_REFUSED`) is accurate
 * and useless to someone reading the run log — it names a Mozilla error code rather than the thing they
 * configured, and "the SOCKS port refuses" is the sentence that tells them to start Tor.
 *
 * The egress *decision* itself is not here: it lives in server/src/net.js (resolveBrowserEgress), next to
 * the other Playwright egress helpers, because the browser is not the only thing in this project that
 * launches one — the thumbnail screenshot does too, and two copies of "how do we reach the network" is how
 * the two drift apart.
 */
export function describeEgressFailure(err, { mode = 'direct', socks = '' } = {}) {
  const msg = String(err?.message ?? err ?? '');
  const proxyish = /NS_ERROR_PROXY|proxy|SOCKS|socks5|ERR_PROXY|ECONNREFUSED/i.test(msg);
  if (mode === 'tor') {
    if (proxyish) return `Tor 出口不可用：SOCKS 端口拒绝连接或不可达（${socks || 'socks5://127.0.0.1:9150'}）—— Tor 没在跑？/ Tor egress unavailable: the SOCKS port refused (${socks || 'socks5://127.0.0.1:9150'}) — is Tor running? :: ${msg}`;
    return `Tor 出口失败 / Tor egress failed: ${msg}`;
  }
  if (mode === 'proxy' && proxyish) return `代理出口失败 / proxy egress failed: ${msg}`;
  return msg;
}

/**
 * The error a render that ran out of time answers with.
 *
 * It is a class of its own, and a `code` on the returned object, because the caller has to be able to tell
 * "this page never finished" from "the page came back and here it is": the previous version returned the
 * ordinary shape and set `process.exitCode = 3` instead, which is not a result at all — it is a
 * process-wide side effect a library call has no business setting, and it is invisible to the caller (the
 * run report would show whatever the caller made of `undefined`).
 */
export class RenderTimeoutError extends Error {
  constructor(ms) {
    super(`render exceeded the hard timeout of ${ms}ms and was aborted`);
    this.name = 'RenderTimeoutError';
    this.code = 'render-timeout';
    this.timeoutMs = ms;
  }
}

/**
 * The sleep a render does after navigation, cancellable by the hard-timeout controller.
 *
 * Exported for `tools/render-timeout-test.mjs`, which pins the cancellation itself (an abort during the
 * sleep must reject with the timeout error, and a sleep nothing aborts must resolve). The end-to-end check
 * needs a real engine and is the expensive half; this is the half that can be checked anywhere.
 */
export function cancellableSleep(ms, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RenderTimeoutError(timeoutMs));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * render a URL and return its text
 *
 * The hard timeout is a **deadline for the work**, not a flag for the process. It started life as
 * `setTimeout(() => { log.error(…); process.exitCode = 3 }, hardMs)`, which did neither of the two things
 * the name promises: nothing was cancelled or closed — the page, its context, the browser process and (for
 * a temporary profile) a directory under `paths.tempDir` all survived the "timeout" for the rest of the
 * process's life, one hung navigation at a time — and `process.exitCode` was a global side effect that made
 * a *library call* decide the eventual exit status of the whole program.
 *
 * So the deadline now aborts the work through an `AbortController`, and the existing `finally` — which
 * already closes the context and the browser, and already tolerates an SPA that makes `close()` hang — is
 * what cleans up. The caller is told with a `RenderTimeoutError` (`code: 'render-timeout'`) instead of a
 * value that looks like a result.
 *
 * What deliberately did **not** change: a refused egress is still a reason (`ok:false` with the sentence
 * naming the SOCKS port or the proxy), and a page hop refused by the URL policy is still reported rather
 * than thrown. `process.exitCode` is not touched anywhere in this file any more.
 */
export async function renderUrl(url, cfg, { log, waitMs, mode = 'text', subject = null, policy = null } = {}) {
  const bcfg = cfg?.browser ?? {};
  const hardMs = bcfg.hardTimeoutMs ?? 90000;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new RenderTimeoutError(hardMs)), hardMs);
  controller.signal.addEventListener('abort', () => {
    log?.error(`hard timeout after ${hardMs}ms — aborting the render and closing the browser (${url})`);
  }, { once: true });

  let browser = null;
  let context = null;
  let egressMode = 'direct';
  let socks = '';
  try {
    const launchOpts = resolveLaunch(bcfg);
    // The browser needs the egress as well (measured: in an environment where direct is blocked, the
    // browser cannot reach the target site either) — and it is the *same* decision the rest of the
    // project makes, so a source pinned to Tor renders through Tor rather than through the global mode.
    const egress = await resolveBrowserEgress(cfg, subject);
    egressMode = egress.mode;
    socks = torSocksUrl(cfg);
    if (!egress.ok) {
      log?.error(egress.error);
      return { ok: false, error: egress.error, egress: egressMode, url };
    }
    const proxy = egress.proxy;
    // The profile dir comes from the one shared resolver (server/src/browser-target.js): empty means a clean
    // temporary profile, and in anonymous mode it is always empty, whatever the setting says.
    const profileDir = resolveProfileDir(cfg);
    if (profileDir) {
      // reuse an existing login: this requires the browser to be closed
      if (!fs.existsSync(profileDir)) throw new Error(`profileDir 不存在 / not found: ${profileDir}`);
      context = await firefox.launchPersistentContext(profileDir, {
        ...launchOpts,
        ...(proxy ? { proxy } : {}),
        viewport: { width: 1280, height: 900 },
      });
    } else {
      browser = await firefox.launch(launchOpts);
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ...(proxy ? { proxy } : {}),
      });
    }

    const page = context.pages()?.[0] ?? (await context.newPage());
    // ── redirects, in the browser
    //
    // The egress switch above only says *where* the browser goes out; it says nothing about *which addresses*
    // the page may reach, and a browser fetches far more than the one URL it was handed: the document
    // redirects, and everything the page then pulls in. A check on the starting URL is therefore a check on
    // the first hop of a chain the page controls — the same hole net.js closes for HTTP fetches, one layer
    // down. Playwright's route interception is the seam that exists for this: every request the browser is
    // about to make is offered here first, including each redirect hop and each subresource, so the same
    // policy is applied to all of them and a refused one is aborted before a socket is opened.
    //
    // Measured on this engine (Playwright 1.63 / Firefox 155): the handler may be async — the request is held
    // until the promise settles — which matters because resolving a name is I/O.
    const refusals = [];
    const activePolicy = { ...(policy ?? {}), ...(egressMode !== 'direct' ? { skipDns: true } : {}) };
    await page.route('**/*', async (route) => {
      const target = route.request().url();
      if (!/^https?:/i.test(target)) return route.continue(); // about:blank / data: — no address to judge
      const check = await validateRemoteUrl(target, activePolicy);
      if (check.ok) return route.continue();
      refusals.push({ url: target, code: check.code, reason: check.reason });
      log?.warn(`browser request refused (${check.code}): ${target} — ${check.reason}`);
      return route.abort('addressunreachable').catch(() => {});
    });
    // The deadline reaches the navigation as well as the sleep after it. `page.goto` has its own
    // (shorter) timeout, and it is kept: it is what turns an unreachable host into a reason in ~45s
    // instead of waiting for the hard deadline, which is meant for work that is *making progress*.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, signal: controller.signal });
    await cancellableSleep(waitMs ?? bcfg.waitMs ?? 6000, controller.signal, hardMs);
    // A refused hop is the answer, not a footnote: the page content that did come back was fetched *around*
    // the refusal, so reporting it as a successful render would describe a page that was never fully loaded.
    if (refusals.length) {
      const first = refusals[0];
      return {
        ok: false,
        error: `页面要求的地址被拒绝 / the page asked for a refused address (${first.code}): ${first.url} — ${first.reason}`,
        url,
        egress: egressMode,
        refused: refusals,
      };
    }
    const content =
      mode === 'html'
        ? await page.content()
        : await page.evaluate(() => (document.body ? document.body.innerText : ''));

    // site-level error detection (login wall / anti-bot block), so the layer above can report it to the user explicitly
    const blocked = /login|sign in|登录|安全验证|blocked by network security|verify you are human/i.test(
      content.slice(0, 400)
    );
    log?.info(`render ok ${content.length}B${blocked ? ' (possible wall/login page)' : ''} — ${url}`);
    return { ok: true, content, ext: mode === 'html' ? 'html' : 'txt', blocked, url, egress: egressMode };
  } catch (err) {
    // The deadline is checked **first**, and on the signal rather than on the error: an abort surfaces on
    // this engine as `page.goto: Target page, context or browser has been closed` (Playwright closes what
    // the abort touches), which says nothing about a deadline and would otherwise be reported as a page
    // that vanished. The signal is the fact; the message is not.
    if (controller.signal.aborted) {
      const e = new RenderTimeoutError(hardMs);
      log?.error(`render timed out — ${url} :: ${e.message}`);
      // The caller gets a result with a distinguishable `code`, so "the page never finished" cannot be
      // mistaken for a page that came back empty, and `error` stays a sentence for the report.
      return { ok: false, code: e.code, error: e.message, timedOut: true, timeoutMs: hardMs, egress: egressMode, url };
    }
    // A proxy failure that got past the port check (Tor up but not bootstrapped, say) is reported as the
    // egress being at fault instead of as a Mozilla error code
    const reason = describeEgressFailure(err, { mode: egressMode, socks });
    log?.error(`render failed — ${url} :: ${reason}`);
    return { ok: false, error: reason, egress: egressMode, url };
  } finally {
    // bounded teardown: SPA pages make close() hang forever, so never wait without a limit
    //
    // This is also the half that makes the timeout mean something. It runs on every path — a normal render,
    // a refusal, a throw, the deadline — and it is what gives back the page, the context, the browser
    // process and (when the profile was temporary) the profile directory Playwright made under the temp
    // dir. Before this, a timed-out render skipped none of this *except* that the process had been told to
    // keep going with a browser still attached: the cleanup was already here, but the deadline returned a
    // value before ever reaching it.
    //
    // The `allSettled` shape is deliberate. The previous `Promise.race([teardown, 6s])` **returned after 6
    // seconds even when the teardown had not finished**, leaving the close promises running while the
    // caller thought the browser was gone — a leak that only shows up on exactly the hang this is for. Two
    // things are kept from it: the wait is still bounded (the racing sleep is not what ends the function
    // any more — this awaits the real closes), and a teardown that does not finish in time is *reported*
    // rather than passed over in silence, so "the browser refused to close" stops being invisible.
    const closedInTime = await Promise.race([
      Promise.allSettled([
        (async () => {
          try {
            await context?.close();
          } catch {
            /* a context that cannot be closed is reported by the timeout below, not thrown from here */
          }
        })(),
        (async () => {
          try {
            await browser?.close();
          } catch {
            /* same */
          }
        })(),
      ]).then(() => true),
      new Promise((r) => setTimeout(r, 6000)),
    ]);
    if (closedInTime !== true) {
      log?.error(`teardown did not finish within 6000ms — the browser may still be running for ${url}`);
    }
    clearTimeout(deadline);
  }
}

export async function fetchBrowser(source, ctx) {
  return renderUrl(source.url, ctx.cfg, {
    log: ctx.log,
    waitMs: ctx.cfg?.browser?.waitMs,
    subject: source,
    // The source's own allowance, read in the one place it is defined (sources.js). The default (no
    // allowance, no policy object at all) refuses loopback, so a source cannot reach this machine by
    // accident.
    policy: sourcePolicy(source),
  });
}
