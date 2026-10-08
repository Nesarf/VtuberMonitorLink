// ---------------------------------------------------------------------------------------------------
// tools/readiness-test.mjs — what "wait for the app to be ready" means, and the two ways it can lie.
//
// `tools/traverse-ui.cjs` used to open the app with `goto(..., { waitUntil: 'networkidle' })`. That was
// not a badly tuned number, it was a false premise about this application: the shell polls `/api/state`
// on a 3 s interval, so the network is never quiet and the wait was really measuring how loaded the
// machine was. Measured when it was found: 13 `/api/state` requests inside a 20 s `goto`, the page fully
// rendered, `networkidle` never reached — the walk passed on a quiet machine and timed out at 30 s while
// other work was competing for the CPU.
//
// The replacement is a fact the application states about itself: `<html data-vml-ready="1">`, set by the
// shell once a real answer to `/api/state` has arrived. A wait is only worth having if it can fail, so
// this file pins it in **both** directions:
//
//   (a) against a real, running application it must reach readiness — otherwise the walk would be
//       waiting for something that never happens and the gate would be permanently red;
//   (b) against a server that never renders the shell it must **time out with its own reason** — this is
//       the control, and it is the half that stops the new wait from degenerating into "wait for
//       nothing", which is what a readiness check quietly becomes when its failure path is untested.
//       The wrong input here is deliberately the exact shape that used to pass: a listening HTTP server
//       that answers 200 to everything while the page never reaches the service. Under the old wait that
//       server was *indistinguishable from a working app* — it counts as "no more connections in
//       flight", so `networkidle` resolves against it. The control asserts the new wait is not fooled.
//
// The wait itself is not re-implemented here: the walk and this file both use tools/lib/app-ready.cjs, so
// the thing under test is the thing the gate runs. That is also why the static half below reads the walk
// and fails if `networkidle` comes back — a lib nobody calls would pin nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { READY_SELECTOR, waitForAppReady } = require('./lib/app-ready.cjs');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};
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

process.stdout.write('\nreadiness: waiting for the app instead of for a quiet network\n');

// ───────────────────────────────────────────── the signal, and the gate that has to use it

const GATE = path.join(ROOT, 'tools', 'traverse-ui.cjs');
const SHELL = path.join(ROOT, 'web', 'src', 'App.jsx');

t('the shell publishes the readiness attribute the wait watches for', () => {
  const src = fs.readFileSync(SHELL, 'utf8');
  const setter = /setAttribute\(\s*'data-vml-ready'\s*,\s*'1'\s*\)/.exec(src);
  assert.ok(setter, `web/src/App.jsx no longer sets data-vml-ready="1", so the wait below can never succeed: ${READY_SELECTOR}`);
  // …and it is set from state that only a **successful** /api/state answer can produce. The control for
  // this check is that same reading run over the string that would make it vacuous.
  const vacuous = "document.documentElement.setAttribute('data-vml-ready', '1');";
  const guarded = /setStateOk\(true\)[\s\S]*?\}, \[stateOk\]\)/.exec(src);
  assert.ok(guarded, 'the attribute exists but nothing ties it to a successful state read, which is the shape that would make it meaningless');
  assert.ok(!/catch\s*\([^)]*\)\s*\{[^}]*data-vml-ready/.test(src), `the attribute must not be set on the failure path (${vacuous.length} chars of it would still match a bare check)`);
});

t('control: that reading rejects a shell whose attribute is not tied to a state answer', () => {
  const misbehaving = `
    useEffect(() => {
      document.documentElement.setAttribute('data-vml-ready', '1');
    }, []);`;
  const guarded = /setStateOk\(true\)[\s\S]*?\}, \[stateOk\]\)/.exec(misbehaving);
  assert.equal(guarded, null, 'the check would accept an attribute set unconditionally, so it proves nothing about readiness');
  const tied = `
        setStateOk(true);
      } catch { /* stay silent */ }
    };
    const timer = setInterval(tick, 3000);
    return () => {};
  }, []);

  useEffect(() => {
    if (stateOk) document.documentElement.setAttribute('data-vml-ready', '1');
  }, [stateOk]);`;
  assert.ok(/setStateOk\(true\)[\s\S]*?\}, \[stateOk\]\)/.exec(tied), 'the check rejects the shape the shell actually has, so it would fail for the wrong reason');
});

t('the UI walk waits for that signal and no longer for a quiet network', () => {
  const src = fs.readFileSync(GATE, 'utf8');
  assert.ok(/waitForAppReady\s*\(/.test(src), 'tools/traverse-ui.cjs no longer calls the readiness wait');
  assert.ok(!/waitUntil:\s*'networkidle'/.test(src), "tools/traverse-ui.cjs waits for 'networkidle' again: this app polls /api/state every 3 s, so that wait is decided by machine load");
  assert.ok(fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'app-ready.cjs'), 'utf8').includes("html[data-vml-ready=\"1\"]"), 'the shared wait no longer watches the attribute the shell sets');
});

// ───────────────────────────────────────────── the two directions, against real pages

/**
 * Which engine this file will drive, and where it is.
 *
 * `PLAYWRIGHT_BROWSERS_PATH` is set **before the module is imported** on purpose: Playwright reads that
 * variable once, at load, so setting it afterwards — the obvious way to write this — would silently have
 * no effect and the browser would be looked up in the platform default location instead. That is the same
 * trap `tools/browser-engine-test.mjs` records, and this machine has no platform-default engine at all.
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
let browser = null;

/** A server that accepts connections, answers 200, and never runs the application. */
async function startStrayServer() {
  const stray = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="root"></div><h1>not the app</h1></body></html>');
  });
  await new Promise((r) => stray.listen(0, '127.0.0.1', r));
  return { server: stray, port: stray.address().port };
}

if (!enginePresent) {
  // An environment statement rather than a failure, the same rule the browser-engine checks follow: a
  // machine with no engine can say that, and a check that called it a product failure would teach people
  // to ignore the colour.
  process.stdout.write(`         no browser engine at ${browsersPath}: the two live directions are stated, not run\n`);
} else {
  browser = await firefox.launch({ headless: true });

  // (b) the control, first because it is the one that can fail for the reason worth knowing about: a
  // server that answers everything and drives nothing must NOT satisfy the wait.
  const stray = await startStrayServer();
  await ta('control: a server that answers but never reaches the app does not satisfy the wait', async () => {
    const page = await browser.newPage();
    try {
      await page.goto('http://127.0.0.1:' + stray.port + '/', { waitUntil: 'load', timeout: 15000 });
      // The old wait resolves here — that is the whole point of the control, and it is asserted rather
      // than assumed so this file would go red if `networkidle` ever came back as the gate's wait.
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await assert.rejects(
        () => waitForAppReady(page, 2500),
        (e) => /READY_FAILED/.test(e.message) && e.message.includes('data-vml-ready'),
        'the readiness wait was satisfied by a server that never renders the shell',
      );
    } finally {
      await page.close();
    }
  });
  stray.server.close();

  // (a) the real direction, against the exe this walk drives. Skipped with a statement when the package
  // is not built, because the walk itself cannot run then either.
  const dir = path.join(ROOT, 'dist', 'VtuberMonitorLink');
  const exe = path.join(dir, process.platform === 'win32' ? 'VtuberMonitorLink.exe' : 'VtuberMonitorLink');
  if (!fs.existsSync(exe)) {
    process.stdout.write('         no packaged exe at dist/VtuberMonitorLink: the live direction is stated, not run\n');
  } else {
    const port = await freePort();
    const app = spawn(exe, ['--no-open', '--port', String(port)], { cwd: dir, stdio: 'ignore' });
    try {
      await waitHttp('http://127.0.0.1:' + port + '/api/state', 30000);
      await ta('a running app reaches readiness, and it is the app (the direction that keeps the gate usable)', async () => {
        const page = await browser.newPage();
        try {
          await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
          await waitForAppReady(page, 30000);
          assert.equal(await page.getAttribute('html', 'data-vml-ready'), '1');
          const title = (await page.locator('h1').first().innerText()).trim();
          assert.equal(title, "Vtuber's Monitor Link", 'the attribute appeared on a page that is not the app');
        } finally {
          await page.close();
        }
      });
    } finally {
      app.kill();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

if (browser) await browser.close();

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.\n` : `all ${pass} readiness checks passed.\n`));
process.exit(fail ? 1 : 0);

// ── helpers

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

/** Poll a URL until it answers 200, or give up: the app takes a moment to bind. */
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
