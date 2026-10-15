// tools/launch-target-test.mjs - the resolution that says how a built package is started.
//
// ASCII only.
//
// What is being tested is not "does existsSync work": it is the two layouts (SEA launcher binary,
// and launcher/ plus a bundled runtime with no exe) and, more importantly, the *controls*. Every
// positive case here has a sibling that removes one required piece and expects a null answer.
// Without those siblings, a resolver that answered "the exe layout" for any directory would pass
// the whole suite - and the failure it would cause downstream is exactly the one this tool exists
// to prevent: a runnable launcher-layout package reported as "nothing to start".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveLaunch, launchCandidates } = require('./launch-target.cjs');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + (e && e.message) + '\n');
  }
};

// Scratch under the OS temp directory, overridable, never a hard-coded drive. The fixtures are
// empty files a few bytes each: nothing here starts a process.
const TMP_ROOT = process.env.VML_TEST_TMP || path.join(os.tmpdir(), 'vml-launch-target');
const TMP_PREFIX = 'vml-launch-target-';
const NAME = 'VtuberMonitorLink';
const EXE = process.platform === 'win32' ? '.exe' : '';

function sweep() {
  let n = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(TMP_ROOT, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(TMP_PREFIX)) continue;
    fs.rmSync(path.join(TMP_ROOT, e.name), { recursive: true, force: true });
    n++;
  }
  return n;
}

let fixtureSeq = 0;
function touch(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes || '');
}

/** A throwaway package directory. `parts` names the pieces to create.
 *
 * The package sits in a directory named after the package, because that is how the real layout is
 * shaped (`dist/VtuberMonitorLink/VtuberMonitorLink.exe`) and the resolver derives the binary's
 * name from the directory. A fixture that put the binary in an arbitrarily named directory would
 * be testing a layout the build never produces - and it would have passed while the real one did
 * not resolve at all.
 */
function fixture(parts) {
  const root = path.join(TMP_ROOT, TMP_PREFIX + process.pid + '-' + fixtureSeq++);
  const dir = path.join(root, NAME);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const layout = {
    exe: () => touch(path.join(dir, NAME + EXE)),
    runtime: () => touch(path.join(dir, 'runtime', 'node' + EXE)),
    launcher: () => touch(path.join(dir, 'launcher', 'launch.cjs')),
    entry: () => touch(path.join(dir, 'app', 'server', 'src', 'index.js')),
  };
  for (const p of parts) layout[p]();
  return dir;
}

sweep();
process.stdout.write('\nlaunch target: how one built package is started\n\n');

// ---------------------------------------------------------------- the exe layout
t('a package with a launcher binary resolves to that binary, with no arguments of its own', () => {
  const dir = fixture(['exe']);
  const target = resolveLaunch(dir);
  assert.ok(target, 'the exe layout did not resolve at all');
  assert.equal(target.kind, 'exe');
  assert.equal(target.cmd, path.join(dir, NAME + EXE));
  assert.deepEqual(target.args, [], 'the exe takes no leading arguments; the caller appends its own');
});

t('control: the same directory without the binary does not resolve', () => {
  const dir = fixture([]);
  assert.equal(resolveLaunch(dir), null, 'an empty directory was reported as startable');
});

// ------------------------------------------------------------ the launcher layout
t('launcher + bundled runtime + app entry resolves to the launcher script run by that runtime', () => {
  const dir = fixture(['launcher', 'runtime', 'entry']);
  const target = resolveLaunch(dir);
  assert.ok(target, 'the launcher layout did not resolve');
  assert.equal(target.kind, 'launcher');
  assert.equal(target.cmd, path.join(dir, 'runtime', 'node' + EXE), 'the bundled runtime is the binary to run');
  assert.deepEqual(target.args, [path.join(dir, 'launcher', 'launch.cjs')], 'the launcher script is the thing to run');
});

t('control: no bundled runtime means nothing can start the app', () => {
  const dir = fixture(['launcher', 'entry']);
  assert.equal(resolveLaunch(dir), null, 'a launcher with no runtime cannot start anything');
});

t('control: no app entry means the launcher would have nothing to load', () => {
  const dir = fixture(['launcher', 'runtime']);
  assert.equal(resolveLaunch(dir), null, 'a runtime and a launcher with no app is not a runnable package');
});

t('control: a runtime alone is not a package', () => {
  const dir = fixture(['runtime', 'entry']);
  assert.equal(resolveLaunch(dir), null, 'there is no launcher to invoke');
});

// ----------------------------------------------------------------- the precedence
t('when both layouts are present the binary wins, and that precedence is asserted rather than implied', () => {
  const dir = fixture(['exe', 'launcher', 'runtime', 'entry']);
  const target = resolveLaunch(dir);
  assert.ok(target);
  assert.equal(target.kind, 'exe', 'a package carrying both must not silently change which one runs');
});

// ------------------------------------------------------------- the failure report
t('a package nothing can start reports every path that was looked for, and none of them present', () => {
  const dir = fixture([]);
  const cands = launchCandidates(dir);
  assert.equal(cands.length, 4, 'the report names four paths');
  assert.deepEqual(
    cands.map((c) => c.present),
    [false, false, false, false],
    'nothing was present, so every entry has to say so'
  );
  for (const c of cands) {
    assert.ok(c.what && c.path, 'each entry says what it looked for and where');
  }
});

t('control: the same report flips to present once the pieces exist', () => {
  const dir = fixture(['launcher', 'runtime', 'entry']);
  const present = launchCandidates(dir).filter((c) => c.present).map((c) => c.what);
  assert.equal(present.length, 3, 'three of the four paths exist in this layout');
  assert.ok(
    present.every((w) => !w.includes('launcher binary')),
    'the launcher binary is the one that must still be reported missing'
  );
});

// ------------------------------------------------------------------ the real thing
const DIST = path.join(ROOT, 'dist', 'VtuberMonitorLink');
if (!fs.existsSync(DIST)) {
  process.stdout.write('  (skip) the built package under dist/ is absent, so the real direction is stated, not run\n');
} else {
  t('the package this repository actually built resolves, whichever layout it is', () => {
    const target = resolveLaunch(DIST);
    assert.ok(
      target,
      'dist/VtuberMonitorLink exists but cannot be started: ' +
        launchCandidates(DIST)
          .map((c) => (c.present ? 'present ' : 'missing ') + c.what)
          .join('; ')
    );
    assert.ok(['exe', 'launcher'].includes(target.kind));
    assert.ok(fs.existsSync(target.cmd), 'the resolved binary exists: ' + target.cmd);
  });
}

sweep();

process.stdout.write('\n' + (fail === 0 ? 'all passed' : fail + ' failed') + ': ' + pass + ' passed, ' + fail + ' failed\n\n');
process.exit(fail === 0 ? 0 : 1);
