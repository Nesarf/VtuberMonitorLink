// config-fault-banner-test.mjs — the banner's **fault-appearance path**, with a control in the passing
// direction and a control that can fail.
//
// Why this file exists at all, in the release notes' own words: "The banner's fault-appearance path has no
// test of its own. It is exercised by the build, by the fast gate and by the UI walk, and that is not the
// same claim as a test." Measured later, that sentence was wrong twice over: the *build* had already dropped
// the component (the shipped bundle carried no `config-fault` string at all), and neither the fast gate nor
// the UI walk asserts that a band is on screen anywhere - so the path was exercised by nothing.
//
// The header of this file used to add a third claim of its own - that `web/src/config-fault.js`, the decision
// half, "is covered by the pure decision functions". It was not: `grep -rn 'config-fault|decideConfigFaultBanner'
// tools/` matched this file and nothing else. That gap is closed by `tools/config-fault-test.mjs`, which holds
// the five pure functions with a control on every assertion and runs in the same gate as this file, before it -
// cheap first, browser second. What does not move: this file is still the only harness that can say the band is
// on screen, which is the claim the release notes got wrong.
//
// What this file does hold is the one thing none of the others could see: that the band appears in the shell
// chrome, that it states the server's own condition, and that its recovery button is disabled with a reason
// when there is no usable backup - each with a control, and the passing-direction control (a healthy config
// shows no band) being the one that keeps "the banner is visible" from being satisfied by a banner that is
// always visible.
//
// Why a **real browser** is the only harness that can make that claim - measured, not assumed:
//
//   · The decision half is pure and already reachable from Node, so a Node-only case would re-test what
//     exists and would still pass on a shell where the decision is computed and then *never rendered*. That
//     is not hypothetical: `web/src/App.jsx` held `const [configHealth, setConfigHealth] = useState(null)`
//     and `setConfigHealth(await api.getConfigHealth())` while its JSX never mentioned `<ConfigFaultBanner>` -
//     the state was filled and thrown away, and the bundle the packaged app shipped contained no
//     `config-fault` string at all. The fact "the banner is on screen" is only observable from a rendered
//     document, which is why this file pays for an engine.
//   · What the browser costs is one already-installed engine and two page loads; the app itself is the
//     packaged exe this repo already builds for the UI walk, so no second build is required to run it.
//
// How the fault is made real, and why `VML_CONFIG_PATH` rather than a hand-made health payload: the point is
// to reach the banner through the whole chain a user's machine has - a config file the server cannot parse,
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
//     cannot go red is not a control. Measured: with the banner's own render path removed from App.jsx (the
//     import, the state and the poll all left in place) check 1 went red with "the banner did not appear",
//     and restoring the file byte-for-byte returned it to green.
//
// Readiness, not navigation, is what gates the assertions: `tools/lib/app-ready.cjs` waits for the
// `html[data-vml-ready="1"]` attribute the shell sets after a real `/api/state` answer. Measured on this
// machine, the navigation *completion events* are not a fact this app guarantees a harness - against the same
// packaged exe, `domcontentloaded` hung for 12 s three times and resolved in 8.2 s on another run, while
// `load` hung once and resolved in 5.8 s another time, with the app log in the hung runs showing its 3 s
// `/api/config/health` poll arriving the whole time (the document had loaded and React was running). That is
// the same measurement that got rid of `networkidle`; so the navigation here is fired and *not* waited on -
// `commit` (the response arrived) is the wait, its failure is recorded rather than thrown, and readiness
// decides. A dead app still fails, with the readiness reason plus the navigation error.
//
//   node tools/config-fault-banner-test.mjs
//
// Requires `playwright` in the repo's node_modules, one usable engine (PLAYWRIGHT_BROWSERS_PATH), and the
// packaged app at dist/VtuberMonitorLink (the same artefact `npm run traverse:ui` drives).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { waitForAppReady } = require('./lib/app-ready.cjs');
const { resolveLaunch, launchCandidates } = require('./launch-target.cjs');

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
 * The ports this file asks for, in a range nothing else in this repo uses (the UI walk takes 43195-43198).
 *
 * Asked for, not reserved - see `readBoundPort`: the app may bind somewhere else entirely, and it is the
 * app's own line that this file believes. One fixed number per direction rather than `:0`, so the port stays
 * out of the ephemeral range, where the OS hands the same number to something else between probe and bind.
 */
const PORT_FAULTY = 43211;
const PORT_HEALTHY = 43212;

/**
 * `PLAYWRIGHT_BROWSERS_PATH` is set **before** the import, because Playwright reads it once at load: setting
 * it afterwards - the obvious way to write this - has no effect, and the engine is looked up in the platform
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
// How to start that package is resolved, not assumed: the shipped layout has no launcher binary at
// all (launcher/ plus runtime/node.exe instead), and a walk that only knew about the exe would call
// a perfectly runnable package "no packaged app" (tools/launch-target.cjs).
const LAUNCH = resolveLaunch(APP_DIR);
// Scratch goes under the OS temp directory, and `VML_TEST_TMP` overrides it.
//
// This line used to hard-code one machine's cache drive, which the repository's own sanitize check refused
// (correctly: a hard-coded `E:\...` in a published tool is a machine path in a public repository, and it was
// the only thing that made `npm run sanitize-check` fail - the check job of CI was red on it while the two
// matrix legs passed). The location policy for *my* machine is "scratch under the cache drive, never the
// system one", and that is what the environment variable is for: the policy belongs to the machine that runs
// it, not to the file that ships. The fixture itself is a config file and a log, kilobytes, short-lived.
const TMP_ROOT = process.env.VML_TEST_TMP || path.join(os.tmpdir(), 'vml-config-fault');
const TMP_PREFIX = 'vml-config-fault-';

/**
 * Remove scratch directories this file left in earlier runs.
 *
 * Only its own prefix is touched, and only directories: one per pid, never reused, so they accumulate - 17 of
 * them had piled up here before this existed. Deletion happens at the start rather than the end on purpose: a
 * run that is interrupted (Ctrl-C, a killed gate) never reaches its cleanup, and the *next* run then sweeps
 * what the failed one left. The current run's own directories do not exist yet at this point, so nothing that
 * is in use can be removed.
 */
function cleanStaleScratch() {
  let names = [];
  try {
    names = fs.readdirSync(TMP_ROOT).filter((n) => n.startsWith(TMP_PREFIX));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true });
      removed++;
    } catch {
      /* a directory held open by a still-running stray is not this run's problem to solve */
    }
  }
  return removed;
}

/**
 * Is this port bindable right now?
 *
 * The app treats a taken port as a preference and moves to another one - reasonable for a desktop tool, and a
 * trap for a test: a leftover instance from an earlier run turns the next run into a *phantom*, where the app
 * this file started listens somewhere else, `page.goto` waits out its whole timeout against the port that was
 * asked for, and the run ends with the browser and the app still up, poisoning the run after it. That
 * happened here twice before this check existed. Failing in the first second with the reason beats waiting for
 * a symptom.
 *
 * It is a *bind attempt* rather than a connection: a bind asks the OS the question the app's own bind will
 * ask, while a connection would be answered by anything listening, app or not.
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const sock = net.createServer();
    sock.once('error', () => resolve(false));
    sock.listen(port, '127.0.0.1', () => sock.close(() => resolve(true)));
  });
}

/**
 * The port the app **actually bound**, read from its own startup line.
 *
 * Asking the OS for a free port and then handing that number over is a race, and it lost here once: the app
 * was started with `--port 12936` and reported `listening on http://127.0.0.1:7702`, so the fixture polled a
 * number nothing was listening on until its wait ran out. The app has a fallback - it moves to another port
 * when the one it was given is taken - which is the right behaviour for a desktop tool and the wrong thing
 * for a test to assume away. The app's own line is the source of truth; the number this file asked for is
 * only ever a request.
 */
async function readBoundPort(logPath, requested) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch {
      /* the file appears with the first line of output */
    }
    // A hand-off, not a bind: the app has single-instance behaviour, so an instance already serving makes this
    // one announce the running copy and exit instead of listening. Nothing downstream would work - there is no
    // process of ours to drive - and the honest failure is this sentence rather than a navigation timeout.
    const handoff = /already running[^\n]*/.exec(text);
    if (handoff) {
      throw new Error(
        `the app did not start a second instance: its own log says "${handoff[0].trim()}" - another copy is ` +
          'already serving, so this run would have measured that one instead',
      );
    }
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
    if (m) {
      if (Number(m[1]) !== requested) {
        process.stdout.write(`         the app moved off the requested port ${requested} (taken) and bound ${m[1]}\n`);
      }
      return Number(m[1]);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the app never reported a listening port in its log (asked for 127.0.0.1:${requested})`);
}

/** Poll a URL until it answers 200: the app prints its URL a moment before it serves. */
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
 * Returns the process, the port and the paths, so the caller can assert against the very files the server is
 * describing. `VML_CONFIG_PATH` is the whole isolation: the app's real `app/config.json` is not read, not
 * written, and not restorable-to by this file.
 */
async function startApp({ marker, configBytes, port }) {
  if (!(await portIsFree(port))) {
    throw new Error(
      `port ${port} is already in use before this test starts anything - almost always a leftover instance ` +
        'from an interrupted run. The app would silently bind elsewhere and every navigation below would time ' +
        'out against the port that was asked for, so this stops here: close the stray process and run again.',
    );
  }
  const dir = path.join(TMP_ROOT, `${TMP_PREFIX}${marker}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, configBytes, 'utf8');
  const logPath = path.join(dir, 'app.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn(LAUNCH.cmd, LAUNCH.args.concat(['--no-open', '--port', String(port)]), {
    cwd: APP_DIR,
    // The override travels to the child here and nowhere else: a process started without it resolves the
    // config path exactly as it always did.
    env: { ...process.env, VML_CONFIG_PATH: cfgPath },
    stdio: ['ignore', log, log],
  });
  // The parent's copy of the descriptor is not needed once the child owns it; keeping it open would leak one
  // per run for the life of the process.
  fs.closeSync(log);
  const bound = await readBoundPort(logPath, port);
  if (child.exitCode !== null) {
    throw new Error(`the app exited with code ${child.exitCode} before answering on port ${bound}`);
  }
  await waitHttp(`http://127.0.0.1:${bound}/api/state`, 30000);
  return {
    child,
    port: bound,
    dir,
    cfgPath,
    logPath,
    base: `http://127.0.0.1:${bound}`,
    stop: async () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 600));
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
/** The same content, made unparseable by one missing close brace - the bytes a text editor leaves behind. */
const CORRUPT_CONFIG = '{ "ui": { "theme": "dark", "layout": { "cols": 3 }';

// Two preconditions, and they are not the same kind of thing as a failed check.
//
// The banner can only be observed against a *packaged* app, and `verify:fast` is also run in places that never
// build one (`ci.yml`'s fast job, which exists to give fast feedback on the source). That was measured the hard
// way: this test failed CI's fast job on both Node legs with "no packaged app ... run npm run build:portable
// first" - a gate turning red over something the gate's own job does not do, which teaches people to ignore it.
// So a missing package is a **statement**, in the same words the live direction of tools/readiness-test.mjs
// already uses, and the appearance is still held where it matters: `release.yml` builds the package before it
// runs this same gate, and locally `npm run build:portable` is one command away.
//
// A missing *engine* stays a failure, because that one is fixable in place (one `npx playwright install
// firefox`, or the cache the fast job keeps) and because an engine that is absent would otherwise let a
// misconfigured machine report "nothing to see here" as if it were the product's answer.
if (!LAUNCH) {
  const why = launchCandidates(APP_DIR)
    .map((c) => (c.present ? 'present ' : 'missing ') + c.what)
    .join('; ');
  process.stdout.write(`         no runnable package at ${APP_DIR} (${why}): the banner's appearance is stated, not run\n`);
  process.stdout.write('         (build one with: npm run build:portable - the release workflow does this before the same gate)\n');
  process.exit(0);
}
if (!enginePresent) {
  process.stdout.write(`         no browser engine (PLAYWRIGHT_BROWSERS_PATH=${browsersPath}): the banner cannot be observed\n`);
  process.stdout.write('\n1 failed, 0 passed.\n');
  process.exit(1);
}

const swept = cleanStaleScratch();
if (swept) process.stdout.write(`         swept ${swept} scratch director${swept === 1 ? 'y' : 'ies'} from earlier runs\n`);

// One browser for both directions: the engine's cold start is the expensive part and neither direction
// depends on a fresh profile.
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();
// Every locator gets the same bound, so a failure is one sentence naming the selector rather than Playwright's
// default per-call timeouts spread across the file.
page.setDefaultTimeout(30000);

/**
 * Navigate and then wait for the fact that actually matters.
 *
 * The navigation is fire-and-record rather than awaited: `commit` (the response arrived) is the wait, and its
 * failure is kept instead of thrown, because a document that arrived but whose completion event never fired is
 * a state this app is *measured* to produce (see the header). The readiness attribute decides - it is set by
 * the shell only after a real `/api/state` answer, so an app that never rendered still fails here, with the
 * navigation error attached when there is one.
 */
async function gotoAndAwaitReady(base) {
  let navError = null;
  await page
    .goto(base + '/', { waitUntil: 'commit', timeout: 15000 })
    .catch((e) => {
      navError = e;
    });
  try {
    // 45 s rather than the walk's 30: measured here, the *first* navigation of a freshly launched engine is
    // the slow one (2.3 s to readiness on a warm page, but one run took the 30 s and gave up while the page
    // was fine). The budget is for a cold engine, and a genuinely dead app still fails - just later.
    await waitForAppReady(page, 45000);
  } catch (e) {
    const nav = navError ? ' | navigation: ' + String(navError.message).split('\n')[0] : ' | navigation: ok';
    throw new Error(e.message + nav);
  }
}

try {
  // ───────────────────────────────────── direction 1: a real fault makes the banner appear
  //
  // The condition is created on disk before the app starts, so the fault is the *first* thing the server ever
  // reports - there is no "it would have appeared if something else had happened first" in this run.
  const faulty = await startApp({ marker: 'corrupt', configBytes: CORRUPT_CONFIG, port: PORT_FAULTY });
  try {
    process.stdout.write('a config file whose bytes do not parse\n');

    const health = await (await fetch(faulty.base + '/api/config/health')).json();
    // The precondition, asserted rather than assumed: if the server did not call this a fault, the checks
    // below would be about a page that is correct to stay quiet, and every one of them would be vacuous.
    assert.equal(health.fault, true, `the server did not report a fault for an unparseable config (state=${health.state})`);
    assert.equal(health.state, 'corrupt', `the server reported state=${health.state} for an unparseable config`);
    assert.equal(health.backupExists, false, `a config.json.bak appeared beside the temp config (${health.backupPath})`);
    assert.equal(health.backupUsable, false, 'the server called an absent backup usable');

    await gotoAndAwaitReady(faulty.base);

    await ta('the config-fault banner appears for a config whose bytes do not parse', async () => {
      const banner = page.locator('[data-testid="config-fault"]');
      // The banner is fed by the shell's 3 s poll, so it may legitimately be absent at the instant readiness
      // is reached. Waiting for the element is the event-shaped way to bound that - and the poll that carries
      // it is observed, so this is not a sleep dressed up as a wait.
      await page
        .waitForResponse((r) => r.url() === faulty.base + '/api/config/health', { timeout: 10000 })
        .catch(() => {});
      await banner.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      assert.equal(await banner.count(), 1, 'the banner did not appear - the app log says: ' + faulty.tail());
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
      // And the route agrees rather than merely the button: a disabled control the server would have honoured
      // is a different bug from a control that is correctly refused.
      assert.equal(health.backupError, 'no config.json.bak to recover from', `the route's refusal text changed: ${health.backupError}`);
    });
  } finally {
    await faulty.stop();
  }

  // ───────────────────────────────────── the control: a healthy config shows nothing at all
  //
  // Same binary, same run shape, one difference: the config parses. Without this, every check above is
  // satisfied by a band that is rendered unconditionally.
  const healthy = await startApp({ marker: 'ok', configBytes: HEALTHY_CONFIG, port: PORT_HEALTHY });
  try {
    process.stdout.write('\na healthy config, as the control\n');

    const health = await (await fetch(healthy.base + '/api/config/health')).json();
    assert.equal(health.fault, false, `the control's config was called a fault (state=${health.state})`);

    await gotoAndAwaitReady(healthy.base);
    // Then the same bound as above, in the other direction: the poll's response is awaited and the element is
    // given its chance to *detach*, which is a state Playwright reports rather than a sleep.
    const banner = page.locator('[data-testid="config-fault"]');
    await page
      .waitForResponse((r) => r.url() === healthy.base + '/api/config/health' && r.status() === 200, { timeout: 10000 })
      .catch(() => {});
    await banner.waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});

    await ta('no banner at all when the config is healthy (the control in the passing direction)', async () => {
      assert.equal(await banner.count(), 0, "the banner is visible although the config parsed: it is not gated on the server's verdict");
      assert.equal(
        await page.locator('html').getAttribute('data-vml-ready'),
        '1',
        'the control page never reached readiness, so this check would pass for the wrong reason',
      );
    });
  } finally {
    await healthy.stop();
  }
} catch (e) {
  // A precondition or startup failure (a port held by a stray, a hand-off, a dead child) is not an assertion
  // result, so it is reported as its own line and counted - an interruption must never look like a pass.
  fail++;
  process.stdout.write('  [FAIL] the fixture could not reach the banner: ' + e.message + '\n');
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

process.stdout.write('\n' + (fail ? `${fail} failed, ${pass} passed.` : `all ${pass} config-fault banner checks passed.`) + '\n');
process.exit(fail ? 1 : 0);
