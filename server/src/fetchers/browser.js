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
import { resolveBrowserEgress, torSocksUrl } from '../net.js';
import { resolveProfileDir } from '../browser-target.js';

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
 * points it at the package's own `pw-browsers/`, and `config.paths.browsersDir` writes it at startup), and
 * the rest are the platform defaults Playwright falls back to — including the C: drive one this project's
 * "never write to C:" rule exists to avoid, which is exactly why it is listed rather than assumed absent.
 */
export function firefoxBuildRoots() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const out = [];
  const configured = String(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '').trim();
  if (configured) out.push(configured);
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

/** render a URL and return its text */
export async function renderUrl(url, cfg, { log, waitMs, mode = 'text', subject = null } = {}) {
  const bcfg = cfg?.browser ?? {};
  const hardMs = bcfg.hardTimeoutMs ?? 90000;
  const watchdog = setTimeout(() => {
    log?.error(`hard timeout after ${hardMs}ms, forcing exit`);
    process.exitCode = 3;
  }, hardMs);

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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(waitMs ?? bcfg.waitMs ?? 6000);
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
    // A proxy failure that got past the port check (Tor up but not bootstrapped, say) is reported as the
    // egress being at fault instead of as a Mozilla error code
    const reason = describeEgressFailure(err, { mode: egressMode, socks });
    log?.error(`render failed — ${url} :: ${reason}`);
    return { ok: false, error: reason, egress: egressMode, url };
  } finally {
    // bounded teardown: SPA pages make close() hang forever, so never wait without a limit
    await Promise.race([
      (async () => {
        try {
          await context?.close();
        } catch {}
        try {
          await browser?.close();
        } catch {}
      })(),
      new Promise((r) => setTimeout(r, 6000)),
    ]);
    clearTimeout(watchdog);
  }
}

export async function fetchBrowser(source, ctx) {
  return renderUrl(source.url, ctx.cfg, {
    log: ctx.log,
    waitMs: ctx.cfg?.browser?.waitMs,
    subject: source,
  });
}
