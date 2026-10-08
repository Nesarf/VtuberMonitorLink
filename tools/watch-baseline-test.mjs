// ---------------------------------------------------------------------------------------------------
// tools/watch-baseline-test.mjs — a damaged watch baseline is a condition, not an absent one.
//
// The defect, as measured (server/src/watch.js before this round):
//
//     export function getBaseline(cfg, id) {
//       const f = baselinesPath(cfg, id);
//       try {
//         if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
//       } catch {
//         /* corrupt file: treat as absent */
//       }
//       return null;
//     }
//
// One `catch` covering "there is no file yet" and "the file is unreadable or not JSON", with the second
// written out as the decision. What that costs is the whole point of a watch: the run rebuilds the baseline
// from the page as it is *now*, so the first comparison after the damage is against bytes written seconds
// ago. The change that happened while the baseline was broken is the one change that can never be reported —
// and the damaged file is overwritten by the rebuild, so it cannot be examined afterwards either.
//
// The three states, and what each one must do (the same rule server/src/config.js settled for its own file):
//
//   missing     -> 'first-run'    silent, no fault, nothing written. A genuine first check.
//   not JSON    -> 'corrupt'      the damaged file is COPIED ASIDE (`<id>.baseline.json.corrupt-<stamp>`),
//                                 the state is reported as a fault, and the target is still usable: the
//                                 baseline is rebuilt in the same pass, because a watch that stops working
//                                 over a damaged baseline is a worse outcome than a reported rebuild.
//   unreadable  -> 'unavailable'  (EACCES/EPERM/EISDIR) reported as its own state, and **nothing is
//                                 written**: a file we may not read is a file we may not replace.
//   parses      -> 'ok'
//
// The control this file needs above all others is the one on 'missing': if a first run reports the corrupt
// state, then every new watch target warns on its first check and the warning that matters is buried. That
// assertion is `control:`-marked below and the mutation in section F makes it fail on purpose.
//
// The whole test runs offline against a fixture directory of its own (VML_CONFIG_PATH + paths.watchDir), so
// no network is involved and the repository's own config.json is never read or written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const MODULE_REL = 'server/src/watch.js';

const MODE = process.env.VML_BASELINE_MODE ?? 'main';
const WORK = process.env.VML_BASELINE_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vml-watch-baseline-'));
fs.mkdirSync(WORK, { recursive: true });

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

/**
 * The module's text with **LF line endings**, for the two things a control does with it: matching an anchor
 * and writing the mutated copy.
 *
 * This is not cosmetic. git checks these files out with CRLF on Windows (`core.autocrlf`), while the anchors
 * in this file are template literals written with LF — so on a Windows checkout an LF anchor never matches
 * the source, and the control reports "the mutation anchor is gone" while the code it names is plainly still
 * there. Measured, and it is exactly how the first version of this section failed.
 */
const CR = String.fromCharCode(13);
const asLf = (text) => String(text).split(CR).join('');

/**
 * The module under test.
 *
 * Every scenario loads it through `mod()`, and that is a requirement rather than a style: a module namespace
 * object is immutable and bound at import time, so a control run - which must exercise a **mutated copy** -
 * cannot work with names captured once at the top of this file. `W` is the live view, `reload()` refreshes it
 * at the start of each scenario, and the assertions are therefore the same ones in a normal run and in a
 * control run.
 */
const mod = async () => {
  const target = process.env.VML_BASELINE_MODULE ?? path.join(ROOT, MODULE_REL);
  return import(pathToFileURL(target).href);
};
let W = await mod();
const reload = async () => {
  W = await mod();
  return W;
};

const WATCH_DIR = path.join(WORK, 'watch');
const HISTORY = path.join(WATCH_DIR, 'history');

/** The config the watch module is driven with.
 * `watchDir` is absolute and inside WORK: a relative value is resolved against APP_ROOT (see `resolveDir` in
 * config.js), which would write into the repository. */
const cfg = () => ({
  paths: { watchDir: WATCH_DIR },
  watch: { enabled: true, targets: [], rules: {} },
});

const baselineFile = (id) => path.join(HISTORY, `${id}.baseline.json`);
const preservedFiles = () => (fs.existsSync(HISTORY) ? fs.readdirSync(HISTORY).filter((f) => f.includes('.corrupt-')) : []);
const cleanup = () => {
  fs.rmSync(WATCH_DIR, { recursive: true, force: true });
  W.resetBaselineHealthForTest();
};

// ---------------------------------------------------------------------------------------------------
// A. a parseable baseline is 'ok', and a missing one is a silent first run (the control-shaped half)
//
// Every scenario below starts with `await reload()`, which loads the module under test: the real one in a
// normal run, the mutated copy in a control run. Nothing here captures module functions at import time.
// ---------------------------------------------------------------------------------------------------
async function caseMissingAndOk() {
  await reload();
  cleanup();
  await ta('control: a missing baseline is a first run, NOT a fault (this is the assertion the fix must not break)', async () => {
    const r = W.readBaseline(cfg(), 'target-1');
    assert.equal(r.state, 'first-run', `a fresh target reported ${r.state}`);
    assert.equal(r.data, null);
    assert.equal(W.getBaseline(cfg(), 'target-1'), null);
    const h = W.baselineHealthSnapshot();
    assert.equal(h.fault, false, 'a first run was reported as a fault');
    assert.equal(h.state, 'ok', `the snapshot says ${h.state} after nothing but a first run`);
    assert.deepEqual(h.faults, []);
  });
  await ta('a first run writes nothing to disk', async () => {
    assert.equal(fs.existsSync(baselineFile('target-1')), false, 'reading a missing baseline created a file');
    assert.deepEqual(preservedFiles(), []);
  });
  await ta('a first run is recorded as such, so the state is not "unknown"', async () => {
    const h = W.baselineHealthSnapshot();
    const rep = h.reports.find((x) => x.file === baselineFile('target-1'));
    assert.ok(rep, 'no per-file report for the baseline that was read');
    assert.equal(rep.state, 'first-run');
  });

  W.setBaseline(cfg(), 'target-1', { kind: 'url', hash: 'abc', text: 'hello' });
  await ta('a written baseline reads back as ok', async () => {
    const r = W.readBaseline(cfg(), 'target-1');
    assert.equal(r.state, 'ok');
    assert.equal(r.data.hash, 'abc');
    assert.equal(W.getBaseline(cfg(), 'target-1').text, 'hello');
    assert.equal(W.baselineHealthSnapshot().fault, false);
  });
  await ta('the baseline the module writes is JSON with an updatedAt stamp', async () => {
    const raw = JSON.parse(fs.readFileSync(baselineFile('target-1'), 'utf8'));
    assert.equal(raw.hash, 'abc');
    assert.ok(typeof raw.updatedAt === 'string' && raw.updatedAt.includes('T'), 'no updatedAt stamp');
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// B. a corrupt baseline: preserved, reported, and still usable
// ---------------------------------------------------------------------------------------------------
async function caseCorrupt() {
  await reload();
  cleanup();
  const file = baselineFile('damaged');
  fs.mkdirSync(HISTORY, { recursive: true });
  const damaged = '{"kind":"url","hash":"deadbeef","text":"the old page';
  fs.writeFileSync(file, damaged, 'utf8');

  const r = W.readBaseline(cfg(), 'damaged');
  await ta('a baseline that is not JSON is reported as corrupt, not as absent', async () => {
    assert.equal(r.state, 'corrupt', `a damaged baseline reported ${r.state}`);
    assert.equal(r.data, null, 'a damaged baseline was returned as if it had parsed');
    assert.equal(r.code, 'SyntaxError');
    assert.equal(r.stillInPlace, false);
  });
  await ta('the damaged file is preserved under its own name, byte for byte', async () => {
    assert.ok(r.movedTo, 'nothing was preserved');
    assert.ok(fs.existsSync(r.movedTo), `the preserved copy is not there: ${r.movedTo}`);
    assert.equal(fs.readFileSync(r.movedTo, 'utf8'), damaged, 'the preserved copy is not the damaged bytes');
    assert.match(path.basename(r.movedTo), /^damaged\.baseline\.json\.corrupt-/);
  });
  await ta('the corrupt state is visible where the watch API can see it, not only in a log line', async () => {
    const h = W.baselineHealthSnapshot();
    assert.equal(h.fault, true);
    assert.equal(h.state, 'corrupt');
    assert.ok(
      h.faults.some((f) => f.file === file && f.state === 'corrupt' && f.movedTo === r.movedTo),
      `the fault list does not describe it: ${JSON.stringify(h.faults)}`
    );
    assert.ok(h.events.some((e) => e.kind === 'read' && e.state === 'corrupt'), 'no read event was recorded');
  });
  await ta('the snapshot never carries baseline content, only states and file names', async () => {
    const text = JSON.stringify(W.baselineHealthSnapshot());
    assert.ok(!text.includes('deadbeef'), 'baseline content leaked into the health answer');
    assert.ok(!text.includes('the old page'), 'baseline content leaked into the health answer');
  });
  await ta('control: the same file, read again after being preserved, is a first run and not a second fault', async () => {
    // The rebuild is what makes a damaged baseline survivable. This is deliberately the *next* read, because
    // the failure mode the fix must avoid is a target that stays broken forever.
    const again = W.readBaseline(cfg(), 'damaged');
    assert.equal(again.state, 'first-run');
    assert.equal(W.baselineHealthSnapshot().fault, false, 'the fault did not clear once the file was dealt with');
  });
  await ta('and a rebuilt baseline puts the target back in business', async () => {
    W.setBaseline(cfg(), 'damaged', { kind: 'url', hash: 'newhash', text: 'the new page' });
    assert.equal(W.readBaseline(cfg(), 'damaged').state, 'ok');
    assert.equal(W.getBaseline(cfg(), 'damaged').hash, 'newhash');
    // The preserved copy is untouched by the rebuild: it is the only record of what was missed.
    assert.equal(fs.readFileSync(r.movedTo, 'utf8'), damaged);
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// C. an unreadable baseline: a third state, left alone
//
// EISDIR/EPERM by making the path a **directory** — no ACLs needed, and it is a real shape (a stray folder, a
// botched sync). config.js's own durability test makes the same choice for the same reason.
// ---------------------------------------------------------------------------------------------------
async function caseUnreadable() {
  await reload();
  cleanup();
  const file = baselineFile('locked');
  fs.mkdirSync(file, { recursive: true });

  const r = W.readBaseline(cfg(), 'locked');
  await ta('a baseline that cannot be read is its own state, not "corrupt"', async () => {
    assert.equal(r.state, 'unavailable', `an unreadable baseline reported ${r.state}`);
    assert.equal(r.code, 'EISDIR');
  });
  await ta('nothing is written and nothing is moved for an unreadable baseline', async () => {
    const wrote = W.setBaseline(cfg(), 'locked', { kind: 'url', hash: 'x' });
    assert.equal(wrote, null, 'a baseline we may not read was replaced');
    assert.equal(fs.statSync(file).isDirectory(), true, 'the unreadable path was replaced by a file');
    assert.deepEqual(preservedFiles(), [], 'an unreadable baseline was treated as a damaged one');
  });
  await ta('the unreadable state stays visible until it is dealt with', async () => {
    const h = W.baselineHealthSnapshot();
    assert.equal(h.state, 'unavailable');
    assert.equal(h.fault, true);
    assert.ok(h.faults.some((f) => f.state === 'unavailable' && f.file === file));
    const f = h.faults.find((x) => x.file === file) ?? {};
    assert.equal(f.code, 'EISDIR');
    assert.ok(
      /not allowed to read it|may not read/i.test(String(f.note ?? '')),
      `the fault does not say it was a permission problem: ${JSON.stringify(f)}`
    );
    // And it does not echo the file: a read/json error message can quote the baseline's own bytes.
    assert.ok(!/"nope|the old page/.test(JSON.stringify(h)), 'the health answer echoed baseline content');
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// D. the baseline condition reaches the check result (this is what the run report renders)
// ---------------------------------------------------------------------------------------------------
async function caseCheckResult() {
  await reload();
  cleanup();
  const file = baselineFile('via-check');
  fs.mkdirSync(HISTORY, { recursive: true });

  await ta('a check against a damaged baseline reports the baseline condition in its result', async () => {
    fs.writeFileSync(file, '{ not json', 'utf8');
    W.resetBaselineHealthForTest();
    // The fetch fails on its own (port 1 refuses; nothing is listening there), which is deliberate: what is
    // asserted is the `baseline` field on the result, and the failure path has to carry it too.
    const target = { id: 'via-check', kind: 'url', label: 'fixture', url: 'http://127.0.0.1:1/x' };
    const res = await W.checkTarget(target, { cfg: cfg(), log: { info: () => {}, warn: () => {}, error: () => {} } });
    assert.ok(res.baseline, 'the result carries no baseline condition');
    assert.equal(res.baseline.state, 'corrupt');
    assert.equal(res.baseline.fault, true);
    assert.ok(res.baseline.movedTo, 'the result does not say where the damaged file was preserved');
    // The check fails at the network, so the sentence a person reads is `error`; on a check that fetched, the
    // same sentence is prepended to `summary` by checkTarget. Both are asserted because both are rendered.
    assert.match(String(res.error ?? ''), /loopback|refused/, `unexpected error text: ${res.error}`);
    assert.match(String(res.baseline.summary), /基线损坏|baseline was corrupt/, 'the baseline fault carries no sentence');
  });
  await ta('control: a check against a MISSING baseline reports a first run and no fault', async () => {
    cleanup();
    const target = { id: 'clean', kind: 'url', label: 'fixture', url: 'http://127.0.0.1:1/x' };
    const res = await W.checkTarget(target, { cfg: cfg(), log: { info: () => {}, warn: () => {}, error: () => {} } });
    assert.ok(res.baseline, 'the result carries no baseline condition');
    assert.equal(res.baseline.state, 'first-run');
    assert.equal(res.baseline.fault, false);
    assert.ok(!/基线损坏|baseline was corrupt/.test(String(res.summary ?? res.error ?? '')), 'a first run was described as damage');
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// E. the API surface: the watch route serves the condition
// ---------------------------------------------------------------------------------------------------
async function caseApi() {
  await reload();
  cleanup();
  const file = baselineFile('api-target');
  fs.mkdirSync(HISTORY, { recursive: true });
  fs.writeFileSync(file, 'nope{', 'utf8');
  W.resetBaselineHealthForTest();

  const http = await import('node:http');
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'server/src/server.js')).href);
  const appCfg = {
    ...cfg(),
    watch: {
      enabled: true,
      targets: [{ id: 'api-target', kind: 'url', label: 'fixture', url: 'http://127.0.0.1:1/x', enabled: true }],
      rules: {},
    },
  };
  const app = createApp({
    getConfig: () => appCfg,
    setConfig: (next) => next,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onConfigChanged: () => {},
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The read has to happen before the route can report it: the state is a property of the process's own
    // work, so the route is asked after something has read the damaged file.
    W.readBaseline(cfg(), 'api-target');
    await ta('GET /api/watch carries the baseline condition', async () => {
      const r = await fetch(base + '/api/watch');
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.baselineHealth, 'the watch answer has no baselineHealth');
      assert.equal(body.baselineHealth.fault, true);
      assert.equal(body.baselineHealth.state, 'corrupt');
      assert.ok(
        body.baselineHealth.faults.some((f) => f.state === 'corrupt'),
        `the route does not name the damaged baseline: ${JSON.stringify(body.baselineHealth.faults)}`
      );
    });
    await ta('the watch answer does not echo the damaged baseline content', async () => {
      // A JSON syntax error in current node quotes the offending input, so the *raw* message would put a slice
      // of the watched page on the route. The record reports a fixed sentence instead; this asserts that.
      const r = await fetch(base + '/api/watch');
      const text = await r.text();
      assert.ok(!text.includes('nope{'), 'the damaged baseline content leaked into the answer');
      assert.ok(!text.includes('Unexpected token'), 'the raw parse message leaked into the answer');
      const body = JSON.parse(text);
      const f = (body.baselineHealth.faults ?? []).find((x) => x.state === 'corrupt') ?? {};
      assert.equal(f.error, 'the baseline is not valid JSON', `the fault carries an unexpected reason: ${JSON.stringify(f.error)}`);
    });
    await ta('control: with a healthy baseline the route reports no fault', async () => {
      W.setBaseline(cfg(), 'api-target', { kind: 'url', hash: 'h', text: 't' });
      const r = await fetch(base + '/api/watch');
      const body = await r.json();
      assert.equal(
        body.baselineHealth.fault,
        false,
        `a healthy baseline was reported as a fault: ${JSON.stringify(body.baselineHealth.faults)}`
      );
      assert.equal(body.baselineHealth.state, 'ok');
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// F. the controls: the pre-fix readers are restored and the checks must fail
//
// Two mutations, one per half of the defect:
//   • `legacy-reader` — the measured pre-fix `getBaseline`/`readBaseline`: one `catch`, null on everything,
//     nothing preserved, no state. The "missing is NOT a fault" control still passes under it (the bug was
//     never about missing); what must fail is the corrupt-state check and the preservation check;
//   • `missing-as-corrupt` — the *fix* applied to the wrong fact: a missing file reported as corrupt. This is
//     the mutation that proves the "a missing baseline must NOT produce the corrupt state" assertion is a
//     real check rather than a sentence in a comment.
// ---------------------------------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: 'legacy-reader',
    what: 'the pre-fix reader: one catch, null for every failure, nothing preserved, no state',
    // The mutation replaces the whole state machine with the measured pre-fix behaviour: a single `try`, a
    // `null` for anything that goes wrong, and no record at all. The real body is kept below under a name
    // nothing calls, so the rest of the module still parses and the mutation stays applicable.
    from: `export function readBaseline(cfg, id) {
  const file = baselinesPath(cfg, id);
  if (!fs.existsSync(file)) {`,
    to: `export function readBaseline(cfg, id) {
  const file = baselinesPath(cfg, id);
  try {
    if (fs.existsSync(file)) return { state: 'ok', data: JSON.parse(fs.readFileSync(file, 'utf8')), file };
  } catch {
    /* MUTATION: corrupt file treated as absent */
  }
  return { state: 'first-run', data: null, file };
}
export function readBaselineReal_UNUSED(cfg, id) {
  const file = baselinesPath(cfg, id);
  if (!fs.existsSync(file)) {`,
    expectFail: [
      'a baseline that is not JSON is reported as corrupt, not as absent',
      'the damaged file is preserved under its own name, byte for byte',
    ],
  },
  {
    name: 'missing-as-corrupt',
    what: 'the fix applied to the wrong fact: a missing baseline reported as corrupt',
    from: `    recordBaselineEvent('read', 'first-run', { file, note: 'no baseline file yet: this is a first check, not a fault' });
    return { state: 'first-run', data: null, file };`,
    to: `    // MUTATION: the first run is reported as damage (the defect the assertion below exists to prevent)
    recordBaselineEvent('read', 'corrupt', { file, code: 'ENOENT', error: 'no baseline file', movedTo: null, stillInPlace: false });
    return { state: 'corrupt', data: null, file, movedTo: null, stillInPlace: false, code: 'ENOENT', error: 'no baseline file' };`,
    expectFail: ['control: a missing baseline is a first run, NOT a fault (this is the assertion the fix must not break)'],
  },
];

/** One scenario per control, chosen so that the mutation's damage lands on it. */
const CONTROL_SCENARIOS = {
  'legacy-reader': caseCorrupt,
  'missing-as-corrupt': caseMissingAndOk,
};

function runControls() {
  section('F. the controls: the pre-fix reader and the wrong-fact reader are applied and must fail');
  // Inside the repository, so `express` and the module's own siblings resolve. Removed in the `finally`, and
  // asserted gone afterwards: a leftover would be picked up by the next run's scans.
  const dir = fs.mkdtempSync(path.join(ROOT, '.baseline-mutants-'));
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
      fs.mkdirSync(path.join(mutantRoot, 'server', 'src'), { recursive: true });
      // The whole of server/src, because the module imports its siblings by relative path.
      fs.cpSync(path.join(ROOT, 'server', 'src'), path.join(mutantRoot, 'server', 'src'), { recursive: true });
      fs.writeFileSync(path.join(mutantRoot, MODULE_REL), src.replace(m.from, m.to), 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          VML_BASELINE_MODE: 'control',
          VML_BASELINE_CONTROL: m.name,
          VML_BASELINE_WORK: path.join(mutantRoot, 'work'),
          VML_BASELINE_MODULE: path.join(mutantRoot, MODULE_REL),
        },
        encoding: 'utf8',
        timeout: 180000,
      });
      const out = String(child.stdout ?? '');
      const listed = (out.match(/\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace('[FAIL] ', '').split(' - ')[0].trim());
      t(`control "${m.name}" (${m.what}) makes a check fail`, () => {
        assert.equal(child.status, 1, `the mutant exited ${child.status}; it was supposed to fail a check\n${out.slice(-900)}`);
        assert.ok(listed.length > 0, `the mutant reported no [FAIL], so it proves nothing\n${out.slice(-900)}`);
      });
      for (const expected of m.expectFail) {
        t(`control "${m.name}" breaks exactly: ${expected}`, () => {
          assert.ok(
            listed.includes(expected),
            `the mutant failed for other reasons (${JSON.stringify(listed)}), so it does not control this check\n${out.slice(-900)}`
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
    assert.ok(!/_UNUSED/.test(src), 'a mutated copy marker is in the real source');
    assert.ok(!/MUTATION/.test(src), 'a mutation marker is in the real source');
    const leftovers = fs.readdirSync(ROOT).filter((n) => n.startsWith('.baseline-mutants-'));
    assert.deepEqual(leftovers, [], `a mutant tree survived the run: ${leftovers.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------------------------------
// G. the surface: the states are exported, and the convention matches config.js
// ---------------------------------------------------------------------------------------------------
async function caseSurface() {
  await reload();
  await ta('the four states are exported as a named list', async () => {
    assert.deepEqual([...W.BASELINE_STATES].sort(), ['corrupt', 'first-run', 'ok', 'unavailable']);
  });
  await ta('the preserved-copy name follows the same convention as the config one', async () => {
    const p = W.corruptBaselinePathFor('/tmp/x.baseline.json', '2026-01-02T03:04:05.678Z');
    assert.equal(p, '/tmp/x.baseline.json.corrupt-2026-01-02T03-04-05-678Z');
  });
  const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
  await ta('the pre-fix shape is gone: no single catch that returns null for every failure', async () => {
    // The *quote* of the old code in the module's own explanation is expected and wanted — this file is
    // documented by showing what it replaced. What must be gone is the old reader as live code: the function
    // that returned `null` from one `catch`, with no state recorded anywhere.
    assert.ok(
      !/export function getBaseline\(cfg, id\) \{\s*const f = baselinesPath\(cfg, id\);\s*try \{/.test(src),
      'the old getBaseline reader is back'
    );
    assert.ok(/export function readBaseline\(cfg, id\) \{/.test(src), 'the state-reporting reader is gone');
    assert.ok(/return \{ state: 'ok', data, file \};/.test(src), 'the reader no longer reports its state');
  });
  await ta('the module says which of the three ways a baseline can be missing it is in', async () => {
    assert.match(src, /'first-run'/, 'no first-run state');
    assert.match(src, /'corrupt'/, 'no corrupt state');
    assert.match(src, /'unavailable'/, 'no unavailable state');
  });
  await ta('the condition is exposed, not only logged', async () => {
    assert.equal(typeof W.baselineHealthSnapshot, 'function');
    assert.equal(typeof W.setBaselineHealthLogger, 'function');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
    assert.match(serverSrc, /baselineHealth: baselineHealthSnapshot\(\)/, 'the watch route does not serve the condition');
  });
}

// ---------------------------------------------------------------------------------------------------

// run
// ---------------------------------------------------------------------------------------------------
if (MODE === 'control') {
  // The child of a control run: the scenario the mutation is meant to break, run against the mutated module.
  // `W` points at the mutant (see `mod()`), and each scenario calls `reload()` at its start, so the assertions
  // executed here are the ones the parent runs - which is what makes this a control rather than a second,
  // separately-written test that could pass for its own reasons.
  process.stdout.write(`  (control "${process.env.VML_BASELINE_CONTROL}" against a mutated watch.js)\n`);
  await CONTROL_SCENARIOS[process.env.VML_BASELINE_CONTROL]();
  process.stdout.write(`\ncontrol: ${pass} ok, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

process.stdout.write('\nwatch baseline: three ways a baseline can be missing, and only two are faults\n');
section('A. a parseable baseline is ok; a missing one is a silent first run');
await caseMissingAndOk();
section('B. a corrupt baseline is preserved, reported, and still usable');
await caseCorrupt();
section('C. an unreadable baseline is a third state, and it is left alone');
await caseUnreadable();
section('D. the condition reaches the check result (the run report renders it)');
await caseCheckResult();
section('E. the API surface: /api/watch serves the condition');
await caseApi();
section('G. the surface: exported states, the preserved name, and the route');
await caseSurface();
runControls();

fs.rmSync(WORK, { recursive: true, force: true });
process.stdout.write(`\nwatch baseline: ${pass} ok, ${fail} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
process.exit(fail ? 1 : 0);
