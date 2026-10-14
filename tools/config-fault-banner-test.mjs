// config-fault-banner-test.mjs — the banner's **fault-appearance path**, with a control in the passing
// direction and a control that can fail.
//
// Why this file exists at all, in the release notes' own words: "The banner's fault-appearance path has no
// test of its own. It is exercised by the build, by the fast gate and by the UI walk, and that is not the
// same claim as a test." Those three exercise the *words* (`web/src/config-fault.js` is covered by the pure
// decision functions) and they exercise the *server* (the durability test drives the config states). None of
// them can see the thing the user is promised, which is that a band appears in the shell chrome.
//
// Why a **real browser** is the only harness that can make that claim - measured, not assumed:
//
//   · The decision half is pure and already reachable from Node, so a Node-only case would re-test what
//     exists and would pass on a shell where the decision is computed and then *never rendered*. That is not
//     hypothetical: App.jsx held `const [configHealth, setConfigHealth] = useState(null)` and
//     `setConfigHealth(await api.getConfigHealth())` while the JSX never mentioned `<ConfigFaultBanner>` -
//     the state was filled and thrown away, and the shipped bundle contained no `config-fault` string. The
//     fact "the banner is on screen" can only be observed from the rendered document.
//   · What the browser costs here is one already-installed engine and one page load; the app itself is the
//     packaged exe this repo already builds for the UI walk, and no second build is required to run it.
//
// How the fault is made real, and why `VML_CONFIG_PATH` rather than a hand-made health payload: the point is
// to reach the banner through the whole chain the user's machine has - a config file the server cannot parse,
// the server's own state, the shell's own poll, the banner's own decision - and never by mounting the shell
// against a stubbed answer. `VML_CONFIG_PATH` is the injection point `server/src/config.js` already provides
// for exactly this (`config.json.bak` follows the config, so both live in the temp directory and the user's
// real config is never read or written).
//
// The two controls, both required:
//
//   · passing direction - the same run with a *healthy* config must show no banner at all. Without it, "the
//     banner is visible" is satisfied by a banner that is always visible.
//   · failing direction - observed by hand against a deliberately wrong product, because a control that
//     cannot go red is not a control. The transcript is in the change that added this file; the mutation was
//     removing the banner's own render path, and check 1 went red with "the banner did not appear".
//
// Readiness is `tools/lib/app-ready.cjs` (the attribute the shell sets), never a sleep and never
// `networkidle`: the shell polls `/api/state` every 3 s, so the page is never quiet by design.
//
//   node tools/config-fault-banner-test.mjs
//
// Requires `playwright` in the repo's node_modules, one usable engine (PLAYWRIGHT_BROWSERS_PATH), and the
// packaged app at dist/VtuberMonitorLink (the same artefact `npm run traverse:ui` drives).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { waitForAppReady } = require('./lib/app-ready.cjs');

let pass = 0;
let fail = 0;
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

process.stdout.write('\nconfig-fault banner: a damaged config is visible without reading the log\n\n');

/**
 * `PLAYWRIGHT_BROWSERS_PATH` is set **before** the import, because Playwright reads it once at load: setting
 * it afterwards - the obvious way to write this - has no effect and the engine is looked up in the platform
 * default location instead. Same trap and same reason as `tools/readiness-test.mjs`.
 */
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(ROOT, 'pw-browsers');
if (browsersPath && fs.existsSync(browsersPath)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
const firefox = (await import('playwright')).firefox;

const enginePath = (() => {
  try {
    return firefox.executablePath();
  } catch {
    return null;
  }
})();
const enginePresent = !!enginePath && fs.existsSync(enginePath);

const APP_DIR = path.join(ROOT, 'dist', 'VtuberMonitorLink');
const EXE = path.join(APP_DIR, process.platform === 'win32' ? 'VtuberMonitorLink.exe' : 'VtuberMonitorLink');
// Scratch goes to the machine's cache drive, never the system one: an app writes logs and reports beside
// itself, and this fixture is deliberately short-lived.
const TMP_ROOT = process.env.VML_TEST_TMP || 'E:\\DaShaoHuo\\cache\\tmp';

/** An ephemeral port this process owned a moment ago and therefore knows is free. */
function freePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.once('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const port = sock.address().port;
      sock.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Poll a URL until it answers 200: the app takes a moment to bind. */
async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the app under test never answered ${url}`);
}

/**
 * Start the packaged app with its config pointed into a temp directory of its own.
 *
 * Returns the process, the port and the paths, so the caller can assert against the very files the server
 * is describing. `VML_CONFIG_PATH` is the whole isolation: the app's real `app/config.json` is not read,
 * not written, and not restorable-to by this file.
 */
async function startApp({ marker, configBytes }) {
  const dir = path.join(TMP_ROOT, `vml-config-fault-${marker}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  if (configBytes !== null) fs.writeFileSync(cfgPath, configBytes, 'utf8');
  const logPath = path.join(dir, 'app.log');
  const log = fs.openSync(logPath, 'w');
  const port = await freePort();
  const child = spawn(EXE, ['--no-open', '--port', String(port)], {
    cwd: APP_DIR,
    // The override travels to the child here and nowhere else: a process started without it resolves the
    // config path exactly as it always did.
    env: { ...process.env, VML_CONFIG_PATH: cfgPath },
    stdio: ['ignore', log, log],
  });
  await waitHttp(`http://127.0.0.1:${port}/api/state`, 30000);
  return {
    child,
    port,
    dir,
    cfgPath,
    logPath,
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill();
      await new Promise((r) => setTimeout(r, 600));
      try {
        fs.closeSync(log);
      } catch {
        /* the descriptor may already be gone with the child */
      }
    },
    /** The app's own log, for a failure message that says what the app thought rather than only what we saw. */
    tail: () => {
      try {
        return fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-6).join(' | ');
      } catch {
        return '(no app log)';
      }
    },
  };
}

/** A config file that is valid JSON, so the server's own verdict for it is `ok`. */
const HEALTHY_CONFIG = JSON.stringify({ ui: { theme: 'dark' }, llm: { providers: [] } }, null, 2);
/** The same file, made unparseable by one missing close brace - the bytes a text editor leaves behind. */
const CORRUPT_CONFIG = '{ "ui": { "theme": "dark", "layout": { "cols": 3 }';

if (!fs.existsSync(EXE)) {
  process.stdout.write(`         no packaged app at ${EXE}: run npm run build:portable first\n`);
  process.stdout.write('\n1 failed, 0 passed.\n');
  process.exit(1);
}
if (!enginePresent) {
  process.stdout.write(`         no browser engine (PLAYWRIGHT_BROWSERS_PATH=${browsersPath}): the banner cannot be observed\n`);
  process.stdout.write('\n1 failed, 0 passed.\n');
  process.exit(1);
}

const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();

try {
  // ───────────────────────────────────── direction 1: a real fault makes the banner appear
  //
  // The condition is created on disk before the app starts, so the fault is the *first* thing the server
  // ever reports - there is no "it would have appeared if something else had happened first" in this run.
  const faulty = await startApp({ marker: 'corrupt', configBytes: CORRUPT_CONFIG });
  try {
    process.stdout.write('a config file whose bytes do not parse\n');

    const health = await (await fetch(faulty.base + '/api/config/health')).json();
    // The precondition, asserted rather than assumed: if the server did not call this a fault, the checks
    // below would be about a page that is correct to stay quiet, and every one of them would be vacuous.
    assert.equal(health.fault, true, `the server did not report a fault for an unparseable config (state=${health.state})`);
    assert.equal(health.state, 'corrupt', `the server reported state=${health.state} for an unparseable config`);
    assert.equal(health.backupExists, false, `a config.json.bak appeared beside the temp config (${health.backupPath})`);
    assert.equal(health.backupUsable, false, 'the server called an absent backup usable');

    await page.goto(faulty.base + '/', { waitUntil: 'load', timeout: 30000 });
    await waitForAppReady(page, 30000);

    await ta('the config-fault banner appears for a config whose bytes do not parse', async () => {
      const banner = page.locator('[data-testid="config-fault"]');
      await banner.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      assert.equal(
        await banner.count(),
        1,
        'the banner did not appear — the app log says: ' + faulty.tail(),
      );
    });

    await ta('the banner states the condition the server reported', async () => {
      const body = await page.locator('[data-testid="config-fault"]').innerText();
      // The server's own sentence, passed through verbatim (the health route is written outside the i18n
      // layer on purpose): this is the assertion that the banner is about *this* fault and not a generic
      // "something is wrong" band.
      const code = health.lastProblem?.code;
      assert.ok(code && body.includes(String(code)), `the banner does not name the condition "${code}": ${body}`);
      assert.ok(body.includes('corrupt'), `the banner does not state the fault state: ${body}`);
      // The preserved copy is named, so the reader has something to act on rather than a claim.
      const preserved = (health.events.at(-1)?.movedTo ?? '').split(/[\\/]/).pop();
      assert.ok(preserved && body.includes(preserved), `the banner does not name the preserved file "${preserved}": ${body}`);
    });

    await ta('the recovery button is disabled, and says why, when there is no usable backup', async () => {
      const btn = page.locator('[data-testid="config-fault-recover"]');
      assert.equal(await btn.isDisabled(), true, 'the recovery button is enabled although no config.json.bak exists');
      // A disabled control has to carry its reason (the project's rule). Playwright's `title` is the title
      // attribute, so this reads the same text the user is shown on hover and in the accessibility tree.
      const reason = await btn.getAttribute('title');
      assert.ok(reason && reason.length > 0, 'the disabled recovery button carries no reason');
      const body = await page.locator('[data-testid="config-fault"]').innerText();
      assert.ok(body.includes(reason), `the refusal reason "${reason}" is not shown next to the control: ${body}`);
      // And the route agrees rather than merely the button: a disabled control that the server would have
      // honoured is a different bug from a control that is correctly refused.
      assert.equal(health.backupError, 'no config.json.bak to recover from', `the route's refusal text changed: ${health.backupError}`);
    });
  } finally {
    await faulty.stop();
  }

  // ───────────────────────────────────── the control: a healthy config shows nothing at all
  //
  // Same binary, same run shape, one difference: the config parses. Without this, every check above is
  // satisfied by a band that is rendered unconditionally.
  const healthy = await startApp({ marker: 'ok', configBytes: HEALTHY_CONFIG });
  try {
    process.stdout.write('\na healthy config, as the control\n');

    const health = await (await fetch(healthy.base + '/api/config/health')).json();
    assert.equal(health.fault, false, `the control's config was called a fault (state=${health.state})`);

    await page.goto(healthy.base + '/', { waitUntil: 'load', timeout: 30000 });
    await waitForAppReady(page, 30000);
    // The banner is fed by the shell's 3 s poll, so "not there yet" and "never" look alike at load time.
    // This waits out one full poll interval rather than asserting at first paint - and it is the *only*
    // place in this file that waits on time, because absence is the one fact that has no event to hang on.
    // It is bounded by a network fact instead: the poll itself is observable, so a request is awaited.
    const polled = page.waitForResponse(
      (r) => r.url() === healthy.base + '/api/config/health' && r.status() === 200,
      { timeout: 10000 },
    );
    await polled.catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    await ta('no banner at all when the config is healthy (the control in the passing direction)', async () => {
      const banner = page.locator('[data-testid="config-fault"]');
      assert.equal(await banner.count(), 0, 'the banner is visible although the config parsed: it is not gated on the server\'s verdict');
      assert.equal(await page.locator('html').getAttribute('data-vml-ready'), '1', 'the control page never reached readiness, so this check would pass for the wrong reason');
    });
  } finally {
    await healthy.stop();
  }
} finally {
  await page.close();
  await browser.close();
}

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.` : `all ${pass} config-fault banner checks passed.`) + '\n');
process.exit(fail ? 1 : 0);
