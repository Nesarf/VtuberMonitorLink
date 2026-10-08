// ---------------------------------------------------------------------------------------------------
// tools/render-timeout-test.mjs — the render hard timeout has to abort and clean up, not set an exit code.
//
// The defect, as measured (server/src/fetchers/browser.js before this round):
//
//     const watchdog = setTimeout(() => {
//       log?.error(`hard timeout after ${hardMs}ms, forcing exit`);
//       process.exitCode = 3;                      // and that is all it did
//     }, hardMs);
//
// Two separate things are wrong with that, and both are asserted here:
//
//   1) **Nothing was cancelled.** A page that accepts the connection and never answers held a browser
//      process, its context and (with a temporary profile) a directory of its own for the remaining life
//      of the process — the `finally` that closes them was never reached, because the render *did* return:
//      `page.goto` resolves on its own 45s timeout and everything after it ran normally. One hung page
//      therefore cost one permanent browser, and a run with several cost several.
//   2) **`process.exitCode` is a process-wide side effect.** A library call decided the eventual exit
//      status of the whole program, and the caller received an ordinary-looking result — so the run that
//      rendered nothing would exit 3 for a reason nothing in its own report could name.
//
// What is asserted now:
//   A. a page that never answers ends at the **hard timeout**, with `code: 'render-timeout'`, and the
//      browser process and the temporary profile are **gone** afterwards;
//   B. `process.exitCode` is untouched by a timed-out render (it is `undefined` before and after);
//   C. a normal render still renders — the timeout must not have broken the ordinary path;
//   D. a refused egress is still a **reason**, not a crash (the behaviour that was already there and had
//      to survive);
//   E. the controls: the pre-fix watchdog is restored in a copy of the module and each of A/B must fail
//      against it, so the checks cannot pass on the old behaviour.
//
// The "never answers" server is a raw `net` server this test owns: it accepts and then says nothing at
// all, not even headers. That is deliberately not an HTTP server that never completes a body (which the
// browser eventually gives up on by itself): the point is a page that is genuinely still in flight when
// the deadline arrives, so the abort is what ends it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const MODULE_REL = 'server/src/fetchers/browser.js';
const MODULE_URL = pathToFileURL(path.join(ROOT, MODULE_REL)).href;

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

const MODE = process.env.VML_RENDER_MODE ?? 'main';
const WORK = process.env.VML_RENDER_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vml-render-timeout-'));
fs.mkdirSync(WORK, { recursive: true });

// The engine is resolved the way the application resolves it. Setting this in *this* process is enough
// because the browser module is imported dynamically, after this line runs: Playwright reads its browser
// path at module load, which is why the import below is a function and not a top-level `import`.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(ROOT, 'pw-browsers');
/**
 * Import a module of the product.
 *
 * In a control run the module under test is the **mutated copy** (`VML_RENDER_MODULE`), and every scenario
 * resolves through here, so a control cannot accidentally exercise the real file and pass. The copy is
 * imported by dynamic `import()` for the same reason the application's own checks do it: Playwright reads
 * its browser path at module load, so setting the variable above has to happen first.
 */
const mod = async (rel) => {
  const target = process.env.VML_RENDER_MODULE && rel === MODULE_REL ? process.env.VML_RENDER_MODULE : path.join(ROOT, rel);
  return import(new URL('file:///' + target.replace(/\\/g, '/')).href);
};

/** A server that accepts connections and then never answers. Owned by this test, closed by it. */
async function neverAnsweringServer() {
  const held = new Set();
  const srv = net.createServer((sock) => {
    held.add(sock);
    sock.on('close', () => held.delete(sock));
    sock.on('error', () => {});
    // Nothing is written, not even a status line: the page is in flight, forever.
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${srv.address().port}/hang`,
    close: async () => {
      for (const s of held) s.destroy();
      await new Promise((r) => srv.close(r));
    },
  };
}

/** A server that answers one small page. */
async function answeringServer(body = '<html><body>render-timeout-fixture</body></html>') {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}/`,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/**
 * Every firefox process whose command line mentions one of the paths this render used.
 *
 * `launchPersistentContext` is not used here (the profile is temporary), so the profile directory is one
 * Playwright creates under the temp dir. Both facts are read from the process list rather than assumed:
 * the runner is PowerShell's CIM query, and a machine where it is unavailable is reported as "cannot
 * tell" — never as "nothing is running", which would make the check pass by accident.
 */
function firefoxProcessesMatching(needles) {
  if (process.platform !== 'win32') {
    const out = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    if (out.status !== 0) return { ok: false, reason: 'ps is unavailable' };
    const hits = String(out.stdout ?? '')
      .split('\n')
      .filter((l) => needles.some((n) => l.includes(n)));
    return { ok: true, hits };
  }
  const script =
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*firefox*" } | ' +
    'Select-Object -ExpandProperty CommandLine';
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (out.status !== 0) return { ok: false, reason: `powershell query failed (${out.status})` };
  const hits = String(out.stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => needles.some((n) => l.includes(n)));
  return { ok: true, hits };
}

/** Every directory under the temp dir that looks like a Playwright/Firefox profile for this render. */
function profileDirsMatching(needles) {
  const roots = [process.env.TEMP, process.env.TMP, os.tmpdir()].filter(Boolean);
  const out = [];
  for (const root of new Set(roots)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Playwright's own names: `playwright_firefoxdev_profile-XXXX`, and the `rust_mozprofile…` Firefox
      // itself makes. Matching on the prefix keeps this from listing unrelated temp folders.
      if (!/^(playwright_.*profile|rust_mozprofile)/i.test(e.name)) continue;
      const full = path.join(root, e.name);
      if (needles.some((n) => full.includes(n))) out.push(full);
    }
  }
  return out;
}

/**
 * The config a render is driven with. `waitMs` and `hardTimeoutMs` are the two numbers that decide what
 * each scenario measures, so every scenario states them rather than inheriting them.
 */
function renderCfg({ waitMs, hardTimeoutMs, proxy = { enabled: false, mode: 'http', url: '' } }) {
  return {
    browser: { mode: 'bundled', headless: true, waitMs, hardTimeoutMs },
    proxy,
    // A temp dir of this test's own, so "the profile is gone" is a statement about a directory this run
    // created. It is also what makes the leftover assertion precise.
    paths: { tempDir: path.join(WORK, 'tmp') },
    privacy: {},
  };
}

// ---------------------------------------------------------------------------------------------------
// A/B/C. the timeout, the exit code, and the ordinary render
// ---------------------------------------------------------------------------------------------------
async function caseTimeout() {
  const engine = await mod(MODULE_REL);
  const hang = await neverAnsweringServer();
  const logs = [];
  const log = {
    info: (m) => logs.push('INFO ' + m),
    warn: (m) => logs.push('WARN ' + m),
    error: (m) => logs.push('ERROR ' + m),
  };
  // `waitMs` is far beyond the deadline so the *post-navigation* sleep is what the deadline interrupts;
  // the browser launch and the navigation happen inside the 4s, which was measured to be enough.
  const cfg = renderCfg({ waitMs: 60000, hardTimeoutMs: 4000 });
  fs.mkdirSync(cfg.paths.tempDir, { recursive: true });

  try {
    const before = process.exitCode;
    const started = Date.now();
    const r = await engine.renderUrl(hang.url, cfg, { log, policy: { allowLoopback: true } });
    const ms = Date.now() - started;

    t('a page that never answers ends at the hard timeout', () => {
      assert.equal(r.ok, false, `the render reported success: ${JSON.stringify(r).slice(0, 200)}`);
      assert.equal(r.code, 'render-timeout', `the answer is not distinguishable as a timeout: ${JSON.stringify(r).slice(0, 300)}`);
      assert.equal(r.timedOut, true);
      assert.equal(r.timeoutMs, 4000);
    });
    t('the timeout is the deadline, not the navigation timeout (so the abort is what ended it)', () => {
      assert.ok(ms < 45000, `the render took ${ms}ms, which is the navigation timeout, not the 4000ms deadline`);
      assert.ok(ms >= 4000, `the render returned after ${ms}ms, before its own deadline`);
    });
    t('the caller gets a sentence, and the reason is in the log', () => {
      assert.match(String(r.error), /hard timeout of 4000ms/);
      assert.ok(logs.some((l) => /hard timeout after 4000ms/.test(l)), `no timeout line in the log: ${JSON.stringify(logs)}`);
    });
    t('a timed-out render does not decide the process exit code (the side effect is gone)', () => {
      assert.equal(process.exitCode, before, `process.exitCode moved from ${before} to ${process.exitCode}`);
      assert.equal(process.exitCode, undefined, 'process.exitCode was set by a library call');
    });

    await ta('the browser process is gone when the render returns', async () => {
      // The profile root is the needle: it belongs to this run, and any firefox whose command line names it
      // is this render's browser rather than one from something else running at the same time.
      await sleep(1500); // a process that was just killed can linger for a moment in the process list
      const live = firefoxProcessesMatching([cfg.paths.tempDir]);
      assert.equal(live.ok, true, `could not read the process list: ${live.reason}`);
      assert.deepEqual(live.hits, [], `a browser from this render is still running:\n${live.hits.join('\n')}`);
    });
    t('the temporary profile is gone too', () => {
      const left = profileDirsMatching([cfg.paths.tempDir]);
      assert.deepEqual(left, [], `a profile directory survived the timeout:\n${left.join('\n')}`);
    });
  } finally {
    await hang.close();
  }
}

async function caseNormalRender() {
  const engine = await mod(MODULE_REL);
  const good = await answeringServer();
  // The ordinary path, with numbers a person would actually configure: a short settle wait and a deadline
  // that this render never approaches (the point is that the deadline machinery does not fire).
  const cfg = renderCfg({ waitMs: 1200, hardTimeoutMs: 60000 });
  fs.mkdirSync(cfg.paths.tempDir, { recursive: true });
  try {
    const r = await engine.renderUrl(good.url, cfg, { log: undefined, policy: { allowLoopback: true } });
    t('a normal render still renders (the abort must not have broken the ordinary path)', () => {
      assert.equal(r.ok, true, `the ordinary render failed: ${JSON.stringify(r).slice(0, 300)}`);
      assert.match(String(r.content), /render-timeout-fixture/);
      assert.equal(r.code, undefined, 'a successful render carries a timeout code');
      assert.equal(r.timedOut, undefined);
    });
    t('the ordinary path still cleans up its browser and profile', () => {
      const live = firefoxProcessesMatching([cfg.paths.tempDir]);
      assert.equal(live.ok, true, `could not read the process list: ${live.reason}`);
      assert.deepEqual(live.hits, [], `a browser survived a normal render:\n${live.hits.join('\n')}`);
      assert.deepEqual(profileDirsMatching([cfg.paths.tempDir]), [], 'a profile survived a normal render');
    });
  } finally {
    await good.close();
  }
}

/**
 * The deadline has to interrupt the **post-navigation wait**, not only the navigation.
 *
 * This is the scenario the pre-fix bug lived in: `page.goto` succeeds (the fixture answers at once) and the
 * render then settles for `waitMs` — an SPA that paints for ten minutes, a page whose load event never
 * fires. The old code spent that whole time with a browser attached and no deadline that could interrupt
 * it; the abort has to end it at `hardTimeoutMs`, and the timeout has to be what the caller is told.
 *
 * The fixture therefore *answers*, which is the difference from the never-answering case: there, the abort
 * could have been delivered to `page.goto`'s own signal and the check would still pass. Here the only thing
 * the deadline can interrupt is the sleep, so this is the check the `no-abort` control breaks.
 */
async function caseSlowSettlingPage() {
  const engine = await mod(MODULE_REL);
  const good = await answeringServer();
  const cfg = renderCfg({ waitMs: 60000, hardTimeoutMs: 4000 });
  fs.mkdirSync(cfg.paths.tempDir, { recursive: true });
  try {
    const started = Date.now();
    const r = await engine.renderUrl(good.url, cfg, { log: undefined, policy: { allowLoopback: true } });
    const ms = Date.now() - started;
    t('a page that answers but settles forever is ended by the deadline, not by the settle time', () => {
      assert.equal(r.ok, false, `a 60s settle finished inside a 4s deadline: ${JSON.stringify(r).slice(0, 300)}`);
      assert.equal(r.code, 'render-timeout', `the answer is not a timeout: ${JSON.stringify(r).slice(0, 300)}`);
      assert.ok(ms < 30000, `the render took ${ms}ms: the deadline did not interrupt the settle`);
    });
    t('and that timeout also cleans up after itself', () => {
      const live = firefoxProcessesMatching([cfg.paths.tempDir]);
      assert.equal(live.ok, true, `could not read the process list: ${live.reason}`);
      assert.deepEqual(live.hits, [], `a browser survived the deadline:\n${live.hits.join('\n')}`);
      assert.deepEqual(profileDirsMatching([cfg.paths.tempDir]), [], 'a profile survived the deadline');
    });
  } finally {
    await good.close();
  }
}

async function caseRefusedEgress() {
  const engine = await mod(MODULE_REL);
  // A port this test owned a moment ago and has closed: it refuses for the length of the run, without
  // asserting anything about whether Tor is running on this machine.
  const sock = net.createServer();
  const refusedPort = await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.listen(0, '127.0.0.1', () => resolve(sock.address().port));
  });
  await new Promise((r) => sock.close(r));
  const cfg = renderCfg({
    waitMs: 200,
    hardTimeoutMs: 20000,
    proxy: { enabled: true, mode: 'tor', torSocks: `socks5://127.0.0.1:${refusedPort}` },
  });
  const r = await engine.renderUrl('http://example.invalid/', cfg, { log: undefined, policy: { allowLoopback: true } });
  t('a refused egress is still a reason, not a crash', () => {
    assert.equal(r.ok, false);
    assert.equal(r.code, undefined, 'a refused egress was reported as a render timeout');
    assert.match(String(r.error), /SOCKS 端口拒绝连接|SOCKS port refuses/);
    assert.ok(String(r.error).includes(String(refusedPort)), 'the sentence does not name the port that refused');
  });
}

// ---------------------------------------------------------------------------------------------------
// D. the cancellation primitive, without a browser
// ---------------------------------------------------------------------------------------------------
async function caseCancellableSleep() {
  const engine = await mod(MODULE_REL);
  await ta('the post-navigation sleep resolves when nothing aborts it', async () => {
    const slept = await engine.cancellableSleep(50, new AbortController().signal, 4000);
    assert.equal(slept, undefined);
  });
  await ta('an abort during that sleep rejects with the timeout error, immediately', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = engine.cancellableSleep(60000, controller.signal, 4000);
    setTimeout(() => controller.abort(new Error('deadline')), 60);
    await assert.rejects(p, (e) => e.name === 'RenderTimeoutError' && e.code === 'render-timeout' && e.timeoutMs === 4000);
    assert.ok(Date.now() - started < 5000, 'the sleep was not actually cancelled');
  });
  t('the timeout error is exported and carries its own code', () => {
    const e = new engine.RenderTimeoutError(1234);
    assert.equal(e.name, 'RenderTimeoutError');
    assert.equal(e.code, 'render-timeout');
    assert.equal(e.timeoutMs, 1234);
    assert.ok(e instanceof Error);
  });
  t('this module no longer touches process.exitCode anywhere', () => {
    // Comments are stripped first, on purpose: this file explains the defect it fixes, so the *prose* names
    // `process.exitCode`, and a check that could not tell prose from code would either fail on the
    // explanation or have to abandon it. `--` and `/*` are handled so a trailing comment cannot hide a
    // statement either.
    const src = fs
      .readFileSync(path.join(ROOT, MODULE_REL), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/process\s*\.\s*exitCode\s*=/.test(src), 'the watchdog side effect is back');
    assert.ok(!/process\.exit\s*\(/.test(src), 'a library call exits the process');
    // Control on the stripper itself: the same detector, run over a line that is a real statement, must
    // find it — otherwise "no hit" could just mean "the stripper ate everything".
    const planted = 'const watchdog = setTimeout(() => { process.exitCode = 3; }, 1000);';
    assert.match(planted.replace(/(^|[^:])\/\/[^\n]*/g, '$1'), /process\s*\.\s*exitCode\s*=/, 'the detector does not detect');
  });
  t('the timeout is reported as an abort, not as a value that looks like a result', () => {
    const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
    assert.match(src, /controller\.abort\(new RenderTimeoutError\(hardMs\)\)/, 'the deadline does not abort anything');
    assert.match(src, /code: e\.code, error: e\.message, timedOut: true, timeoutMs: hardMs/, 'the timeout answer does not carry its own code');
  });
}

// ---------------------------------------------------------------------------------------------------
// E. the control: the pre-fix watchdog restored, and its checks must fail
//
// The mutation is the measured pre-fix code, character for character in shape: a timer that only logs and
// sets `process.exitCode`. It is applied to the **never-answering** scenario, which shows both halves of the
// defect at once - the deadline cannot end the render (no timeout is reported; the render only ends much
// later on its own navigation timeout), and the exit status of the whole program is changed by a library
// call. Both checks below are therefore required to fail under it.
//
// A second mutation was written and then dropped, deliberately: putting the old uncancellable wait back in
// place of `cancellableSleep` while keeping the deadline. It does not break this scenario - the navigation
// is still in flight when the deadline arrives, and the abort reaches it through `page.goto`'s own signal -
// so the check passed under it, and a control that passes under the defect it is meant to catch is worse
// than no control at all. The settle is covered instead by the "settles forever" assertion in section C,
// which is a check on the real code rather than a mutation of it.
// ---------------------------------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: 'legacy-watchdog',
    scenario: 'hang',
    what: 'the pre-fix watchdog: log and set process.exitCode, cancel nothing',
    from: `  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new RenderTimeoutError(hardMs)), hardMs);`,
    to: `  const controller = new AbortController();
  const deadline = setTimeout(() => {
    log?.error(\`hard timeout after \${hardMs}ms, forcing exit\`);
    process.exitCode = 3; // MUTATION
  }, hardMs);`,
    expectFail: ['a page that never answers ends at the hard timeout', 'a timed-out render does not decide the process exit code (the side effect is gone)'],
  },
];

function runControls() {
  section('E. the controls: the pre-fix watchdog is restored and the checks must fail');
  // Inside the repository: node resolves `playwright` by walking up from the importing file, so a copy in
  // the OS temp directory cannot even be imported (it dies of ERR_MODULE_NOT_FOUND, which would make the
  // control "fail" for a reason unrelated to the defect). Removed in the `finally`, asserted gone at the end.
  const dir = fs.mkdtempSync(path.join(ROOT, '.render-mutants-'));
  const original = fs.readFileSync(path.join(ROOT, MODULE_REL));
  try {
    for (const m of MUTATIONS) {
      const src = asLf(original);
      if (!src.includes(m.from)) {
        t(`control "${m.name}" is applicable (its anchor is still in the source)`, () => {
          throw new Error('the mutation anchor is gone: the check it backs no longer exists');
        });
        continue;
      }
      const mutantRoot = path.join(dir, m.name);
      fs.mkdirSync(path.join(mutantRoot, 'server', 'src', 'fetchers'), { recursive: true });
      // The whole of server/src is copied, not just the one file: the module imports its siblings
      // (`../config.js`, `../net.js`, …) by relative path, so a lone copy dies of ERR_MODULE_NOT_FOUND —
      // measured, and it made the first version of this section "fail the check" for a reason that had
      // nothing to do with the defect.
      fs.cpSync(path.join(ROOT, 'server', 'src'), path.join(mutantRoot, 'server', 'src'), { recursive: true });
      fs.writeFileSync(path.join(mutantRoot, MODULE_REL), src.replace(m.from, m.to), 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          VML_RENDER_MODE: 'control',
          VML_RENDER_CONTROL: m.name,
          VML_RENDER_WORK: path.join(mutantRoot, 'work'),
          VML_RENDER_MODULE: path.join(mutantRoot, MODULE_REL),
          VML_RENDER_SCENARIO: m.scenario,
          VML_RENDER_EXPECT: JSON.stringify(m.expectFail),
        },
        encoding: 'utf8',
        timeout: 300000,
      });
      const out = String(child.stdout ?? '');
      const listed = (out.match(/\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace('[FAIL] ', '').split(' - ')[0].trim());
      t(`control "${m.name}" (${m.what}) makes its check fail`, () => {
        assert.equal(child.status, 1, `the mutant exited ${child.status}; it was supposed to fail a check\n${out.slice(-1200)}`);
        assert.ok(listed.length > 0, `the mutant reported no [FAIL], so it proves nothing\n${out.slice(-1200)}`);
      });
      for (const expected of m.expectFail) {
        t(`control "${m.name}" breaks exactly: ${expected}`, () => {
          assert.ok(
            listed.includes(expected),
            `the mutant failed for other reasons (${JSON.stringify(listed)}), so it does not control this check\n${out.slice(-1200)}`
          );
        });
      }
      fs.rmSync(mutantRoot, { recursive: true, force: true });
    }
    t('the real module was never modified by the controls', () => {
      assert.deepEqual(fs.readFileSync(path.join(ROOT, MODULE_REL)), original, 'the source changed while the controls ran');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  t('no mutation marker and no mutant tree are left behind', () => {
    const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
    assert.ok(!/MUTATION/.test(src), 'a mutation marker is in the real source');
    const leftovers = fs.readdirSync(ROOT).filter((n) => n.startsWith('.render-mutants-'));
    assert.deepEqual(leftovers, [], `a mutant tree survived the run: ${leftovers.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------
if (MODE === 'control') {
  // The child of a control run: the scenario named by VML_RENDER_SCENARIO, run against the **mutated**
  // module (the `mod()` helper above resolves to it). The check names are the same as the parent's, so the
  // parent can match the exact failure it expects. This process always ends itself, so a mutant that keeps
  // a browser alive cannot outlive the run as an orphan holding a profile.
  process.stdout.write(`  (control "${process.env.VML_RENDER_CONTROL}" against a mutated browser.js)
`);
  const scenario = process.env.VML_RENDER_SCENARIO ?? 'hang';
  if (scenario === 'hang') await caseTimeout();
  else if (scenario === 'settle') await caseSlowSettlingPage();
  else await caseNormalRender();
  process.stdout.write(`
control: ${pass} ok, ${fail} failed
`);
  process.exit(fail ? 1 : 0);
}

process.stdout.write('\nrender timeout: the deadline aborts and cleans up, and sets nothing global\n');
section('A/B. a page that never answers: the hard timeout, and no exit-code side effect');
await caseTimeout();
section('C. a normal render still renders');
await caseNormalRender();
await caseSlowSettlingPage();
section('D. a refused egress is still a reason; the cancellation primitive itself');
await caseRefusedEgress();
await caseCancellableSleep();
runControls();

fs.rmSync(WORK, { recursive: true, force: true });
process.stdout.write(`\nrender timeout: ${pass} ok, ${fail} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
process.exit(fail ? 1 : 0);
