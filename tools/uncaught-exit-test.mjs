// ---------------------------------------------------------------------------------------------------
// tools/uncaught-exit-test.mjs — an uncaught exception ends the process; a failed request does not.
//
// The defect, as measured: server/src/index.js installed
//
//     process.on('uncaughtException', (err) => {
//       log.error(`uncaughtException — ${err?.stack ?? err}`);
//       if (/EADDRINUSE/.test(String(err?.code ?? ''))) process.exit(1);
//     });
//
// so **every** uncaught exception except a port conflict was logged and then ignored. The process kept
// the port, kept the scheduler, and kept answering — the dashboard reloads, the pages look fine, and the
// state behind them is whatever the half-finished stack left behind. "Looks alive" is the failure mode
// this file exists to make impossible.
//
// What is asserted, and the two halves of it:
//   A. an uncaught exception produces a **non-zero exit** and the **reason is in the log** (the log line
//      is written before the exit, so "the reason survives" is a real assertion, not a timing accident);
//   B. a request that throws produces **500 and the process is still serving afterwards**.
// B is not decoration. Without it, "make uncaughtException exit" is satisfied by exiting on *any* error,
// which would take the whole site down over one bad route — the exact regression the old comment was
// written to prevent. B is the control on A's shape, and section D is the control on A itself: the
// pre-fix handler is restored in a copy of index.js, the same scenario is run against it, and it must
// FAIL (the process is still alive after the throw, so the exit assertion cannot pass).
//
// How the throw is delivered: node's `--import` loads a tiny loader from a temp directory **before** the
// application module is evaluated, and that loader schedules a `setTimeout` that throws. Nothing in
// server/src knows the test exists, so what is exercised is the real entry point, loaded the real way,
// with a real stack. The throw is deliberately scheduled off the app's own call stack: that is the only
// shape `uncaughtException` is for.
//
// The temp directory is the whole sandbox: VML_CONFIG_PATH points the real config module at a file of
// its own, and every configured path (logs/feeds/reports/watch) is an absolute path inside it. The
// repository's own config.json is never read or written, and the port is one this test owns.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const ENTRY = path.join(ROOT, 'server', 'src', 'index.js');

let pass = 0;
let fail = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' - ' + e.message);
    process.stdout.write('  [FAIL] ' + name + ' - ' + e.message + '\n');
  }
};
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    failures.push(name + ' - ' + e.message);
    process.stdout.write('  [FAIL] ' + name + ' - ' + e.message + '\n');
  }
};
const section = (s) => process.stdout.write('\n' + s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The module's text with **LF line endings**, for the two things a control does with it: matching an anchor
 * and writing the mutated copy.
 *
 * This is not cosmetic. git checks these files out with CRLF on Windows (core.autocrlf), while the anchors in
 * this test are template literals written with LF - so on a Windows checkout an LF anchor never matches the
 * source, and the control reports "the mutation anchor is gone" while the code it names is plainly still
 * there. Measured: it is exactly how the first version of this section failed.
 */
const CR = String.fromCharCode(13);
const asLf = (text) => String(text).split(CR).join('');

const MODE = process.env.VML_UNCAUGHT_MODE ?? 'main';
const WORK = process.env.VML_UNCAUGHT_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vml-uncaught-'));
fs.mkdirSync(WORK, { recursive: true });

const MARKER = 'uncaught-exit-probe-marker';

/**
 * The config this run is driven with.
 *
 * Every directory is absolute and inside WORK: `paths.*` are resolved against APP_ROOT when relative
 * (see resolveDir in config.js), so a relative value would write into the repository. `proxy` is off and
 * `schedule` holds no task, so the run touches nothing but its own folder and its own loopback port.
 */
const cfgFor = () => ({
  proxy: { enabled: false, mode: 'http', url: '' },
  schedule: { enabled: false, tasks: [] },
  run: { watchWithRun: false, diagnoseFailed: false, extractFeatures: false, defaultGapSeconds: 1 },
  llm: { activeId: '', providers: [] },
  paths: {
    reportsDir: path.join(WORK, 'reports'),
    feedsDir: path.join(WORK, 'feeds'),
    logsDir: path.join(WORK, 'logs'),
    watchDir: path.join(WORK, 'watch'),
    tempDir: path.join(WORK, 'tmp'),
    browsersDir: path.join(WORK, 'browsers'),
  },
  browser: { mode: 'bundled', headless: true, waitMs: 200, hardTimeoutMs: 5000 },
});

const CONFIG_FILE = path.join(WORK, 'config.json');
const LOG_FILE = path.join(WORK, 'logs', 'server.log');

/** A port this test owns: bind ephemeral, read the number, close. */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * The preload module. A module given to `--import` is **evaluated** before the application module is, and
 * that is all this needs: the timer is armed during that evaluation, so by the time index.js installs its
 * handlers the throw is already scheduled. (An `initialize` export is *not* used: on this runtime a
 * preload hook module's `initialize` is never called, which was measured while writing this file — the
 * process simply stayed alive, and the first version of the check passed against the pre-fix handler for
 * the wrong reason. Top-level evaluation is the documented part, so it is the part that is relied on.)
 *
 * 2500ms is long enough for the server to bind and for the parent to see it answering, and short enough
 * that the parent's own waits stay short. Nothing about the product depends on this number: the file
 * exists only inside WORK.
 */
function preloadSource({ armed = true } = {}) {
  if (!armed) {
    return `// unarmed: the boundary control needs an app that is not scheduled to die\n`;
  }
  return `// armed by the test, evaluated before server/src/index.js\nsetTimeout(() => {\n  throw new Error(${JSON.stringify(MARKER)});\n}, 2500);\n`;
}

/** Poll `<base>/api/config/health` until it answers 200, or give up. */
async function waitServing(base, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(base + '/api/config/health', { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) return false;
    await sleep(200);
  }
}

async function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(ms).then(() => null),
  ]);
}

/**
 * Start the real entry point with a throwing preload, wait until it is *serving*, and hand the running
 * child to the caller. Returns `{ child, base, port, stderr }` — stderr is filled in as it arrives so a
 * failing assertion can show what the process said.
 */
async function startWithPreload({ entry = ENTRY, port, armed = true }) {
  const cfg = cfgFor();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  const preload = path.join(WORK, 'preload.mjs');
  fs.writeFileSync(preload, preloadSource({ armed }), 'utf8');
  let stderr = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      NO_OPEN: '1',
      VML_CONFIG_PATH: CONFIG_FILE,
      // The engine location is irrelevant for this file (no browser is launched), but leaving the
      // variable unset in a child that inherits the repository's would make this test depend on the
      // machine; the app resolves it the same way either way.
      PLAYWRIGHT_BROWSERS_PATH: path.join(ROOT, 'pw-browsers'),
    },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const base = `http://127.0.0.1:${port}`;
  const up = await waitServing(base);
  return { child, base, port, cfg, up, stderrNow: () => stderr };
}

// ---------------------------------------------------------------------------------------------------
// A. an uncaught exception: logged, then a non-zero exit
// ---------------------------------------------------------------------------------------------------
async function caseUncaughtExit() {
  fs.rmSync(LOG_FILE, { force: true });
  const port = await freePort();
  const run = await startWithPreload({ port });
  try {
    await ta('the app is serving before the throw (so the exit is about the throw, not about failing to start)', () => {
      assert.equal(run.up, true, `the app never answered on ${run.base}\n${run.stderrNow().slice(-600)}`);
    });

    const exited = await waitExit(run.child, 25000);
    t('the uncaught exception ends the process', () => {
      assert.ok(exited, `the process was still running 25s after an uncaught exception\n${run.stderrNow().slice(-800)}`);
    });
    t('the exit code is non-zero', () => {
      assert.ok(exited.code !== 0 && exited.code !== null, `exit code was ${exited.code} (signal ${exited.signal})`);
    });

    const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    t('the reason is in the log, written before the exit', () => {
      assert.ok(log.includes('uncaughtException'), `no uncaughtException line in ${LOG_FILE}\n${log.slice(-600)}`);
      assert.ok(log.includes(MARKER), `the log does not carry the thrown reason (${MARKER})\n${log.slice(-600)}`);
    });
    t('the shutdown is ordered and says so, rather than vanishing', () => {
      assert.ok(/shutting down \(exit \d+\)/.test(log), `no ordered-shutdown line in the log\n${log.slice(-600)}`);
    });
    await ta('the port is released by the time the process is gone (a real close, not a detached corpse)', async () => {
      const probe = net.createServer();
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((r) => probe.close(r));
    });
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      try {
        run.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// B. a request that throws is contained: 500, and the process keeps serving
//
// The boundary itself is exercised in-process, so the assertion is about *this* middleware and not
// about a route's own behaviour: the app is built with a config whose `paths.feedsDir` is not a string,
// which makes `resolveDir` throw a TypeError inside a synchronous route. Control: the same request is
// fired at an app built **without** the boundary (the same source with the JSON fallback removed), where
// Express's own default handler answers 500 with an HTML page — the JSON shape is what the check pins,
// so the check can tell "contained" from "answered by accident".
// ---------------------------------------------------------------------------------------------------
async function caseRouteError() {
  const express = (await import('express')).default;
  const http = await import('node:http');
  const { DEFAULT_CONFIG, mergeDefaults } = await import(pathToFileURL(path.join(ROOT, 'server/src/config.js')).href);
  // In a control run the app under test is the **mutated** copy, so the boundary this section exercises
  // has to be the mutated one — otherwise the control would test the real file and pass, proving nothing.
  const serverPath = process.env.VML_UNCAUGHT_SERVER ?? path.join(ROOT, 'server/src/server.js');
  const { createApp } = await import(pathToFileURL(serverPath).href);

  const badCfg = mergeDefaults({ ...structuredClone(DEFAULT_CONFIG), paths: { ...DEFAULT_CONFIG.paths, feedsDir: 12345 } });
  const app = createApp({
    getConfig: () => badCfg,
    setConfig: (next) => next,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onConfigChanged: () => {},
  });
  // A route of this test's own, which must sit **in front of** the boundary: `next(err)` is the same
  // path a synchronous throw inside a route takes (Express 4 catches it and calls the error middleware).
  //
  // Why it is spliced into the router's stack rather than added with `app.get`: `createApp` registers the
  // JSON error fallback *before* the static/SPA handlers at its end, so anything added afterwards is
  // behind the boundary and Express — which walks forward only — never comes back to it. Measured while
  // writing this file: an `app.get('/__throw', …)` added after `createApp` answered **200 with the SPA
  // index.html**, which is exactly the "silently not the thing you think you are testing" failure the
  // check would have papered over. A real `express.Router()` layer is used rather than a hand-written
  // object because the stack calls `layer.match()`.
  const stack = app._router?.stack ?? [];
  const boundaryAt = stack.findIndex((l) => typeof l.handle === 'function' && l.handle.length === 4);
  assert.notEqual(boundaryAt, -1, 'the JSON error fallback is not registered: there is no route-level boundary to test');
  const probeRouter = express.Router();
  probeRouter.get('/__throw', (_req, _res, next) => {
    next(new Error('route-throw-marker'));
  });
  stack.splice(boundaryAt, 0, probeRouter.stack[0]);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await ta('a route that throws answers 500 in JSON, naming the route', async () => {
      const r = await fetch(base + '/__throw');
      assert.equal(r.status, 500, `expected 500, got ${r.status}`);
      assert.match(r.headers.get('content-type') ?? '', /application\/json/, 'the boundary did not answer JSON');
      const body = await r.json();
      assert.equal(body.error, 'route-throw-marker');
      assert.equal(body.route, '/__throw');
    });
    await ta('a route that throws deeper in the stack is contained too (the real route, real config damage)', async () => {
      // `paths.feedsDir` is not a string, so `resolveDir` throws inside the route's own call chain.
      const r = await fetch(base + '/api/people/feed');
      assert.equal(r.status, 500, `expected 500 from /api/people/feed, got ${r.status}`);
      const body = await r.json();
      assert.ok(body.error, 'a 500 with no reason');
      assert.equal(body.route, '/api/people/feed');
    });
    await ta('the process is still serving afterwards (this is the control that stops the fix from becoming "any error kills the app")', async () => {
      // A route that reads no path from the config, so "still serving" is not confused with "the next
      // request hit the same damaged setting".
      const r = await fetch(base + '/api/state');
      assert.equal(r.status, 200, `the app stopped answering after a route error: ${r.status}`);
      const again = await fetch(base + '/__throw');
      assert.equal(again.status, 500, 'the boundary stopped working after the first error');
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------------------------------
// C. the packaged entry point has the same contract (index.js is what the SEA build and the launcher run)
//
// This one is a **text** check on purpose: section A proves the behaviour end to end, and what is left
// to pin is that the file the launcher/SEA path executes (server/src/index.js) is the file that
// installs it — a refactor that moved the handler into a module nobody loads would leave every other
// check green.
// ---------------------------------------------------------------------------------------------------
function caseEntrySurface() {
  const src = fs.readFileSync(ENTRY, 'utf8');
  t('the exit code is a named constant, not a bare number at the call site', () => {
    assert.match(src, /const EXIT_UNCAUGHT = \d+;/, 'no named exit code for an uncaught exception');
    assert.match(src, /shutdown\(EXIT_UNCAUGHT/, 'the uncaught handler does not use the ordered shutdown');
  });
  t('both ideas are still separate: the route boundary is named, and the uncaught path exits', () => {
    assert.match(src, /uncaughtException/, 'the uncaught handler is gone entirely');
    assert.ok(!/if \(\/EADDRINUSE\/\.test\(String\(err\?\.code/.test(src), 'the old "only EADDRINUSE exits" shape is back');
  });
  t('the shutdown stops the scheduler and closes the server before exiting', () => {
    assert.match(src, /function shutdown\(exitCode, why\)/, 'no shared ordered shutdown');
    assert.match(src, /scheduler\.stop\(\);[\s\S]{0,400}server\.close\(\(\) => process\.exit\(exitCode\)\)/, 'the shutdown does not close the server before exiting');
  });
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  t('the route-level error boundary is still installed, and still says what it is', () => {
    assert.match(serverSrc, /res\.status\(err\.status \?\? 500\)\.json\(/, 'the JSON error fallback is gone: every route bug now escapes');
    assert.match(serverSrc, /the route-level error boundary/i, 'the boundary no longer states that it is the thing uncaught hangs on');
  });
}

// ---------------------------------------------------------------------------------------------------
// D. the control: restore the pre-fix handler and section A must fail
//
// The mutation is the finding itself, verbatim: log and keep running for everything but EADDRINUSE. If
// section A still passed against that, then section A is not measuring the exit at all.
// ---------------------------------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: 'legacy-uncaught',
    what: 'the pre-fix handler: an uncaught exception is logged and the process keeps serving',
    from: `  shuttingDown = true;
  shutdown(EXIT_UNCAUGHT, 'the process state can no longer be vouched for');`,
    to: `  shuttingDown = false; // MUTATION`,
    expectFail: 'the uncaught exception ends the process',
  },
  {
    name: 'no-boundary',
    what: 'the route boundary removed, so every route error is Express\u2019s own HTML 500',
    from: `    res.status(err.status ?? 500).json({ error: err.message ?? 'internal error', route: req.originalUrl });`,
    to: `    res.status(err.status ?? 500).send('<html><body>error</body></html>'); // MUTATION`,
    expectFail: 'a route that throws answers 500 in JSON, naming the route',
    file: 'server/src/server.js',
  },
];

function runControls() {
  section('D. the controls: the pre-fix handler is restored and section A must fail');
  // The mutant tree lives **inside the repository**, not in the OS temp directory, and that is a
  // requirement rather than a preference: node resolves `express` and the other bare specifiers by walking
  // up from the importing file, so a copy outside the repository dies of ERR_MODULE_NOT_FOUND — measured,
  // and it made the first version of this section "fail the check" for a reason that had nothing to do
  // with the defect. The prefix is distinctive and the directory is removed in the `finally`; a leftover
  // is asserted against at the end of this section, because a leftover would be picked up by the next
  // run's scans.
  const dir = fs.mkdtempSync(path.join(ROOT, '.uncaught-mutants-'));
  const originals = new Map();
  for (const rel of ['server/src/index.js', 'server/src/server.js']) {
    originals.set(rel, fs.readFileSync(path.join(ROOT, rel)));
  }
  try {
    for (const m of MUTATIONS) {
      const rel = m.file ?? 'server/src/index.js';
      const src = asLf(originals.get(rel));
      if (!src.includes(m.from)) {
        t(`control "${m.name}" is applicable (its anchor is still in the source)`, () => {
          throw new Error(`the mutation anchor is gone from ${rel}: the check it backs no longer exists`);
        });
        continue;
      }
      // The mutated copy keeps the whole module it needs. It is handed to node as the *entry path*, so the
      // copy has to resolve `./config.js` and every other relative import from its own directory — a
      // mutant that dies of ERR_MODULE_NOT_FOUND would "fail the check" for a reason that has nothing to
      // do with the defect (measured: the first version of this section did exactly that, and the failure
      // it produced was indistinguishable from a real one). So the whole of server/src is copied, the one
      // named file is mutated inside that copy, and `dependencies` is the only thing that has to resolve
      // outwards — node finds node_modules by walking up from the copy.
      const mutantRoot = path.join(dir, m.name);
      const mutantFile = path.join(mutantRoot, rel);
      fs.mkdirSync(path.dirname(mutantFile), { recursive: true });
      fs.cpSync(path.join(ROOT, 'server', 'src'), path.join(mutantRoot, 'server', 'src'), { recursive: true });
      fs.writeFileSync(mutantFile, src.replace(m.from, m.to), 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          VML_UNCAUGHT_MODE: 'control',
          VML_UNCAUGHT_CONTROL: m.name,
          VML_UNCAUGHT_WORK: path.join(mutantRoot, 'work'),
          VML_UNCAUGHT_ENTRY: m.entry ?? path.join(mutantRoot, rel),
          VML_UNCAUGHT_SERVER: path.join(mutantRoot, 'server/src/server.js'),
          VML_UNCAUGHT_EXPECT: m.expectFail,
        },
        encoding: 'utf8',
        timeout: 240000,
      });
      const out = String(child.stdout ?? '');
      const listed = (out.match(/\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace('[FAIL] ', '').split(' - ')[0].trim());
      t(`control "${m.name}" (${m.what}) makes its check fail`, () => {
        assert.equal(child.status, 1, `the mutant exited ${child.status}; it was supposed to fail a check\n${out.slice(-900)}`);
        assert.ok(listed.length > 0, `the mutant reported no [FAIL], so it proves nothing\n${out.slice(-900)}`);
      });
      t(`control "${m.name}" breaks exactly the check it is meant to: ${m.expectFail}`, () => {
        assert.ok(
          listed.includes(m.expectFail),
          `the mutant failed for another reason (${JSON.stringify(listed)}), so it does not control this check\n${out.slice(-900)}`
        );
      });
      fs.rmSync(mutantRoot, { recursive: true, force: true });
    }
    t('no source file was modified by the controls', () => {
      for (const [rel, before] of originals) {
        assert.deepEqual(fs.readFileSync(path.join(ROOT, rel)), before, `${rel} changed while the controls ran`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  t('no mutation marker is left in the tree', () => {
    for (const rel of ['server/src/index.js', 'server/src/server.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/MUTATION/.test(src), `a mutation marker is in ${rel}`);
    }
    const leftovers = fs.readdirSync(ROOT).filter((n) => n.startsWith('.uncaught-mutants-'));
    assert.deepEqual(leftovers, [], `a mutant tree survived the run: ${leftovers.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------
if (MODE === 'control') {
  // The child of a control run: only the assertion named by VML_UNCAUGHT_EXPECT is run, against the
  // mutated entry point. Its own exit code is the answer the parent reads. The process is always ended
  // from here (`process.exit`) so that a mutant which *keeps serving* — the pre-fix behaviour this whole
  // file is about — cannot outlive the run as an orphan holding the port.
  const entry = process.env.VML_UNCAUGHT_ENTRY;
  const only = process.env.VML_UNCAUGHT_EXPECT;
  process.stdout.write(`  (control "${process.env.VML_UNCAUGHT_CONTROL}" against a mutated copy)\n`);
  const finish = () => {
    process.stdout.write(`\ncontrol: ${pass} ok, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  };
  if (only === 'the uncaught exception ends the process') {
    fs.rmSync(LOG_FILE, { force: true });
    const port = await freePort();
    const run = await startWithPreload({ entry, port });
    const exited = await waitExit(run.child, 25000);
    try {
      t('the uncaught exception ends the process', () => {
        assert.ok(exited, 'the process was still running 25s after an uncaught exception');
      });
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        try {
          run.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    finish();
  }
  // The boundary mutant needs an app that is not scheduled to die: the preload fires unarmed here, and
  // the route-error checks run in this process exactly as they do in the parent.
  fs.rmSync(LOG_FILE, { force: true });
  await startWithPreload({ entry, port: await freePort(), armed: false });
  await caseRouteError();
  finish();
}

process.stdout.write('\nuncaught exception: the process ends, a failed request does not\n');
section('A. an uncaught exception is logged and ends the process with a non-zero code');
await caseUncaughtExit();
section('B. a request that throws is contained: 500, and the process keeps serving');
await caseRouteError();
section('C. the entry point the launcher and the SEA build run still installs both');
caseEntrySurface();
runControls();

fs.rmSync(WORK, { recursive: true, force: true });
process.stdout.write(`\nuncaught exception: ${pass} ok, ${fail} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
process.exit(fail ? 1 : 0);
