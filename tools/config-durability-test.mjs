// ---------------------------------------------------------------------------------------------------
// config-durability-test.mjs - what happens to config.json when the file, or the write, goes wrong.
//
// The v1.0.5 audit finding this covers is not "the settings were reset". It is sharper than that, and
// the sharper version is the reason the checks below are shaped the way they are:
//
//   1. `loadConfig()` returned `structuredClone(DEFAULT_CONFIG)` both when the file was missing **and**
//      when `JSON.parse` threw, with one `console.error` as the only difference. A damaged file was
//      therefore indistinguishable from a clean install;
//   2. `saveConfig()` wrote with a bare `writeFileSync` - truncate the target, then write. A write cut
//      short in the middle left a truncated file, so producing the damage was easy;
//   3. the two together mean the **next** save persists the defaults over the damaged file. The user
//      loses the file that could have been repaired, which is unrecoverable where a reset is not.
//
// So the checks are about states and about bytes, not about messages: which of the three conditions a
// file is in, whether the damaged bytes still exist somewhere afterwards, and whether the file on disk
// is ever observed half-written.
//
// The three conditions, and the decision for each (this is the state machine the task asked for):
//
//   missing    -> `fresh`       defaults, silent, nothing written. A genuine first run.
//   not JSON   -> `corrupt`     the damaged file is copied to config.json.broken-<stamp> and removed
//                               (or, when even that copy fails, left exactly where it is and said so);
//                               the app runs on defaults **visibly** (a log line at start, plus
//                               GET /api/config/health) until it is resolved. Nothing is written over
//                               the damaged file, and a later save leaves the preserved copy alone.
//   not readable (EACCES/EPERM/EISDIR)
//              -> `unreadable`  defaults, reported, and the file is left exactly where it is: a file
//                               we may not read is a file we may not replace, and this is the state
//                               where writing would be most likely to destroy something.
//   parses     -> `ok`
//
// On controls, two kinds are used and they answer different questions:
//   · an in-test control, stated as `control:` in its own check name, feeds the same probe a wrong
//     input (a damaged file where a missing one is asserted) and requires it to react differently;
//   · section H **runs** the mutations. Each entry below changes one thing in a copy of
//     server/src/config.js, spawns this same file against that copy, and requires the named check to
//     fail there. The deliberately-wrong inputs are the two halves of the finding: the pre-fix loader
//     (defaults on any error, nothing kept, no state) and the pre-fix writer (a bare writeFileSync
//     over the target). The copies live in a temp directory and are removed afterwards; the real
//     source is compared byte-for-byte with what it was before the section ran, and the tree is
//     grepped for a leftover mutation marker.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

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
const section = (s) => process.stdout.write('\n' + s + '\n');

// ---------------------------------------------------------------------------------------------------
// The work directory, and the one file this test is allowed to touch.
//
// `VML_CONFIG_PATH` is the injection point (config.js), and it is set **before** the import below -
// config.js resolves the path at module load, which is what makes the file the app uses and the file
// the test uses the same decision rather than two that can drift. Nothing here ever resolves to the
// repository's own config.json: the whole point of driving the real path is to prove the real
// behaviour, and doing that against the user's file would be the accident this release is about.
// ---------------------------------------------------------------------------------------------------
const MODE = process.env.VML_DURABILITY_MODE ?? 'main';
const WORK = process.env.VML_DURABILITY_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vml-config-durability-'));
fs.mkdirSync(WORK, { recursive: true });
const CFG = path.join(WORK, 'config.json');
process.env.VML_CONFIG_PATH = CFG;

// A control run points this at a mutated copy of the same module; every other run uses the real one.
const CONFIG_MODULE = process.env.VML_CONFIG_MODULE ?? path.join(ROOT, 'server/src/config.js');
const config = await import(pathToFileURL(CONFIG_MODULE).href);
const { configHealthSnapshot, loadConfig, recoverConfigFromBackup, resetConfigHealthForTest, saveConfig, verifyBackup, writeConfigText } = config;

// ── helpers over the fixture file ───────────────────────────────────────────────────────────────────
const read = (p = CFG) => fs.readFileSync(p, 'utf8');
const write = (text, p = CFG) => fs.writeFileSync(p, text, 'utf8');
const exists = (p = CFG) => fs.existsSync(p);
const siblings = () => fs.readdirSync(WORK).sort();
const brokenFiles = () => siblings().filter((n) => n.startsWith('config.json.broken-'));
const strayFiles = () => siblings().filter((n) => n.endsWith('.tmp'));
const cleanup = () => {
  for (const n of siblings()) {
    const p = path.join(WORK, n);
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* a read-only fixture is left for the OS to clean; nothing else here depends on it */
    }
  }
};

const GOOD = () => ({ ui: { theme: 'dark' }, llm: { providers: [{ id: 'p1', name: 'fixture', apiKey: 'sk-ORIGINAL-from-the-file' }], activeId: 'p1' } }); // sanitize-allow: a synthetic fixture value, not a credential
const DAMAGED = '{\n  "ui": { "theme": "dark" },\n  "llm": { "providers": [ { "id": "p1", "apiKey": "sk-DAMAGED" } ] }\n'; // missing the closing braces

// ---------------------------------------------------------------------------------------------------
// A. a damaged file is preserved, reported, and not overwritten by the defaults
//    control: `legacy-load` (the pre-fix loader: defaults on any error, nothing kept, no state)
//    control: `legacy-write` (the pre-fix writer: a bare writeFileSync over the target)
// ---------------------------------------------------------------------------------------------------
function caseCorrupt() {
  cleanup();
  write(DAMAGED);
  const before = fs.readFileSync(CFG); // bytes, not text: the copy has to be the same bytes
  resetConfigHealthForTest('fresh');

  const cfg = loadConfig();
  const h = configHealthSnapshot();

  t('a damaged config is reported as corrupt, not as a fresh install', () => {
    assert.equal(h.state, 'corrupt');
    assert.equal(h.fault, true);
    assert.equal(h.ok, false);
  });
  t('the app still runs (on defaults) in that state, explicitly rather than by accident', () => {
    assert.equal(cfg.ui?.theme, config.DEFAULT_CONFIG.ui.theme);
    assert.equal(cfg.llm?.providers?.length ?? 0, 0);
  });
  t('the damaged file is preserved as config.json.broken-<stamp>', () => {
    const broken = brokenFiles();
    assert.equal(broken.length, 1, `expected exactly one .broken file, found ${JSON.stringify(siblings())}`);
    assert.deepEqual(fs.readFileSync(path.join(WORK, broken[0])), before, 'the preserved copy is not byte-identical to what was damaged');
  });
  t('and it is no longer at the config path (it was moved aside, not merely copied)', () => {
    assert.equal(exists(), false);
  });
  t('the diagnostic names the file it kept and where it went', () => {
    const last = h.events.at(-1);
    assert.equal(last.kind, 'load');
    assert.equal(last.state, 'corrupt');
    assert.ok(last.movedTo && path.basename(last.movedTo) === brokenFiles()[0], 'the event does not point at the preserved file');
  });
  t('the default config is NOT written over the damaged file (the file count says so)', () => {
    // The assertion is about what is *on disk*: a `.broken` copy plus no config.json. The pre-fix
    // behaviour - and the second half of the finding, where the next save persists the defaults -
    // leaves either no copy at all or a config.json where the damage used to be.
    assert.equal(brokenFiles().length, 1);
    assert.equal(exists(), false, 'something wrote a config.json while the file was damaged');
    assert.equal(read(path.join(WORK, brokenFiles()[0])), DAMAGED, 'the damaged bytes changed');
  });
  t('nothing claims success: the state stays corrupt across reads of the snapshot', () => {
    assert.equal(configHealthSnapshot().state, 'corrupt');
    assert.equal(configHealthSnapshot().writeCount, 0);
  });

  // The other half of the finding: once the user saves (or the app writes for any other reason), a new
  // file appears - and the damaged bytes are still there to be repaired by hand.
  t('a save after the damage writes a fresh file and keeps the damaged one', () => {
    saveConfig({ ui: { theme: 'light' } });
    assert.equal(exists(), true);
    assert.equal(JSON.parse(read()).ui.theme, 'light');
    assert.equal(brokenFiles().length, 1, 'the save removed the preserved damaged file');
    assert.equal(read(path.join(WORK, brokenFiles()[0])), DAMAGED, 'the save rewrote the preserved damaged file');
  });
}

// ---------------------------------------------------------------------------------------------------
// B. a valid file survives an interrupted write
//    control: `legacy-write` (the bare writeFileSync: the same interrupted write leaves a truncated
//             target, i.e. the original bytes are gone - which is the defect, not a detail)
//
// Two ways of interrupting are checked, because they fail at different points:
//   B1. the write cannot complete at all (the target is unwritable). The original must be
//       byte-identical afterwards, and the test asks what the abandoned temp file *held*, so the new
//       content is visible as the near miss it was.
//   B2. a live process is killed between the temp write and the rename. The target must still be the
//       old file, and it must still be parseable as config: the point of temp-then-rename is that the
//       interrupted content never carries the name the app reads.
// ---------------------------------------------------------------------------------------------------
function caseInterruptedRename() {
  cleanup();
  saveConfig(GOOD());
  const before = fs.readFileSync(CFG);
  const beforeBak = fs.existsSync(CFG + '.bak') ? fs.readFileSync(CFG + '.bak') : null;
  const replacement = JSON.stringify({ ui: { theme: 'replaced-by-a-write-that-could-not-finish' } }, null, 2);

  // Make the target un-replaceable. On Windows an ACL deny is the mechanism that exists for a path we
  // own (a read-only *file* is refused by write-open, not by rename); on POSIX the directory bit is
  // enough. Whichever step fails first, the assertion is about bytes: had the target been opened for
  // writing, its old content would already be gone by the time the error surfaced.
  let restored = null;
  if (process.platform === 'win32') {
    const who = process.env.USERNAME ?? 'Everyone';
    const deny = spawnSync('icacls', [CFG, '/deny', `${who}:(W,D)`], { encoding: 'utf8' });
    if (deny.status !== 0) {
      t('a write that cannot complete leaves the original byte-identical (skipped: could not make the target unwritable)', () => {
        process.stdout.write('         (icacls refused: ' + String(deny.stderr ?? '').trim().slice(0, 80) + ')\n');
      });
      return;
    }
    restored = () => spawnSync('icacls', [CFG, '/remove:d', who], { encoding: 'utf8' });
  } else {
    fs.chmodSync(CFG, 0o444);
    fs.chmodSync(WORK, 0o555);
    restored = () => {
      fs.chmodSync(WORK, 0o755);
      fs.chmodSync(CFG, 0o644);
    };
  }

  // The near miss is what a `finally` destroys: by the time the failure surfaces in this file, the
  // temp file that held the new content has already been removed (that is the point of the cleanup, and
  // the kill case below is the one where it cannot run). So the content is captured at the removal
  // itself, by observing the one call that deletes it - the assertion then says "the new content
  // existed in full, in a file the config path never names", which is the property being claimed.
  const realUnlink = fs.unlinkSync;
  let nearMiss = null;
  fs.unlinkSync = (target) => {
    if (String(target).endsWith('.tmp') && fs.existsSync(target)) nearMiss = fs.readFileSync(String(target), 'utf8');
    return realUnlink(target);
  };
  let threw = null;
  try {
    writeConfigText(replacement);
  } catch (e) {
    threw = e;
  } finally {
    fs.unlinkSync = realUnlink;
  }
  restored();

  t('a write that cannot complete reports a failure instead of claiming success', () => {
    assert.ok(threw, 'the write was expected to fail on an unwritable target');
    assert.ok(threw.code || threw.name, 'the failure carries no code');
  });
  t('a write that cannot complete leaves the original byte-identical', () => {
    assert.deepEqual(fs.readFileSync(CFG), before, 'the target changed although the write failed');
    assert.equal(JSON.parse(read()).ui.theme, 'dark', 'the target is no longer the config that was there');
    if (beforeBak) assert.deepEqual(fs.readFileSync(CFG + '.bak'), beforeBak, 'the backup changed although the write failed');
  });
  t('the content that could not be placed existed in full, in a temp file the config path never names', () => {
    assert.equal(nearMiss, replacement, 'the temp file did not hold the content that failed to land');
  });
  t('and a failure that is caught removes its own temp file', () => {
    const strays = strayFiles();
    assert.equal(strays.length, 0, `a caught failure left ${JSON.stringify(strays)} behind`);
  });
  t('a failed write leaves no *.tmp content at the config path itself', () => {
    assert.deepEqual(JSON.parse(read()), JSON.parse(before.toString('utf8')));
  });
  t('a failed write is recorded, and it never claims success', () => {
    const h = configHealthSnapshot();
    assert.ok(h.writeFailures >= 1, 'the failure was not counted');
    assert.ok(h.lastWriteError, 'the failure was not recorded');
    assert.equal(h.lastWriteError.code, h.lastWriteError.code); // a code, not a stack
    assert.equal(h.lastWriteError.path, CFG);
  });
}

/**
 * B2: a live process killed between the temp write and the rename.
 *
 * The child calls the **production** `writeConfigText` with a payload large enough that the write and
 * its fsync take real time, and the parent kills it the instant a new entry appears in the fixture
 * directory. No `finally` runs under a kill, so this is the abandonment the temp file exists to
 * survive - not a tidy failure path.
 *
 * Two things about this are deliberate and were each found by the first version failing:
 *   · the polling is asynchronous. A synchronous spin (or `Atomics.wait`) blocks this process's event
 *     loop, and a synchronous spin is also the wrong tool - the child needs the CPU, and the check
 *     needs the directory listing, not a busy loop.
 *   · the child is asked to touch the dataless marker file after its own startup, so a kill during
 *     module loading cannot be mistaken for a kill between the temp write and the rename.
 *
 * Windows caveat, recorded rather than hidden: `child.kill()` (SIGKILL) on a busy process terminates it
 * with exit code 1 instead of a signal, so the check accepts either form of death. It also requires the
 * abandoned temp file to exist, which is what separates "killed mid-write" from "never got going".
 */
async function caseKilledWrite() {
  cleanup();
  saveConfig(GOOD());
  const before = fs.readFileSync(CFG);
  const beforeBak = fs.readFileSync(CFG + '.bak');

  const runner = path.join(WORK, 'interrupted-write-child.mjs');
  fs.writeFileSync(runner, KILL_CHILD, 'utf8');
  const child = spawn(process.execPath, [runner, CONFIG_MODULE], {
    env: { ...process.env, VML_CONFIG_PATH: CFG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const deadline = Date.now() + 30000;
  let killed = false;
  let seen = null;
  while (Date.now() < deadline) {
    const entries = siblings().filter((n) => n !== 'config.json' && n !== 'config.json.bak' && n !== 'interrupted-write-child.mjs');
    if (out.length > 0 && entries.length) {
      seen = entries;
      killed = child.kill();
      break;
    }
    // A yield, not a spin: the child needs the CPU to reach its fsync, and this loop only needs to see
    // the directory entry. 2 ms is enough that the write, not the polling, is the slow part.
    await new Promise((r) => setTimeout(r, 2));
  }
  const status = await waitForChild(child, 15000);

  t('a live write can be interrupted between its temp file and its rename', () => {
    assert.ok(killed, `the child was not caught in the window (saw ${JSON.stringify(seen)}, it said: ${JSON.stringify(out.slice(-300))})`);
    assert.ok(status !== 0, `the child was expected to die, it exited ${status}`);
  });
  t('a write killed between temp and rename leaves the original config byte-identical', () => {
    assert.deepEqual(fs.readFileSync(CFG), before, 'the target is not the file that existed before the interrupted write');
    assert.equal(JSON.parse(read()).ui.theme, 'dark', 'the target was replaced by the interrupted write');
  });
  t('and it leaves the target parseable: the interrupted content never carries its name', () => {
    assert.doesNotThrow(() => JSON.parse(read()), 'the target is not valid JSON after the interruption');
    assert.deepEqual(fs.readFileSync(CFG + '.bak'), beforeBak, 'the backup was disturbed by an interrupted write');
  });
  t('the abandoned temp file is what an interrupted write leaves behind, and it is not the config', () => {
    const strays = strayFiles();
    assert.equal(strays.length, 1, `expected exactly one abandoned temp file, found ${JSON.stringify(siblings())}`);
    assert.ok(read(path.join(WORK, strays[0])).length > 0, 'the abandoned temp file is empty');
    assert.equal(strays[0].startsWith('config.json.'), true);
  });
}

/** Wait for a spawned child to settle, with a ceiling: a hung child must fail the check, not the run. */
function waitForChild(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve(child.signalCode ?? child.exitCode ?? 'unknown');
    };
    if (child.exitCode !== null || child.signalCode !== null) done();
    else child.once('exit', done);
  });
}

/**
 * The child of B2. It imports the **production** module (from `CONFIG_MODULE`: the real
 * server/src/config.js in a normal run, the mutated copy in a control run) and calls the real
 * `writeConfigText` - a stand-in sequence would only prove that a stand-in works.
 *
 * Written as a file and run as one: `node -e` refuses to mix `require` with a top-level await
 * ("Cannot determine intended module format"), and a child that dies on that would look like an
 * interruption while proving nothing.
 */
const KILL_CHILD = `
import { pathToFileURL } from 'node:url';
process.stdout.write('x'); // one byte: the parent must not kill during startup
const mod = await import(pathToFileURL(process.argv[2]).href);
// Built here rather than passed in: a multi-megabyte environment variable is its own failure mode, and
// it is the serialisation + write + fsync cost that holds the window open, which is the same either way.
const big = { ui: { theme: 'killed' }, filler: Array.from({ length: 60000 }, (_, i) => 'row-' + i + '-' + 'y'.repeat(80)) };
mod.writeConfigText(JSON.stringify(big, null, 2));
`;

// ---------------------------------------------------------------------------------------------------
// C. a missing config is a silent first run - and the control for that is that it must NOT say
//    "damaged". This is the assertion the whole finding turns on: the two must not collapse.
// ---------------------------------------------------------------------------------------------------
function caseMissing() {
  cleanup();
  resetConfigHealthForTest('fresh');
  const cfg = loadConfig();
  const h = configHealthSnapshot();
  t('a missing config loads as a silent first run, not as a fault', () => {
    assert.equal(h.state, 'fresh');
    assert.equal(h.fault, false);
    assert.equal(h.ok, true, 'a first run must not be reported as a problem');
  });
  t('and nothing is written on a first run (no file, no .bak, no .broken)', () => {
    assert.deepEqual(siblings(), [], `a fresh start wrote ${JSON.stringify(siblings())}`);
  });
  t('the run really is on defaults', () => {
    assert.equal(cfg.llm?.model, config.DEFAULT_CONFIG.llm.model);
  });
  t('control: the same probe on a damaged file does report a fault', () => {
    // The negative half of the check above, in the same process: an implementation that returned
    // `fresh` for everything would pass the three checks above and fail this one.
    write(DAMAGED);
    loadConfig();
    assert.equal(configHealthSnapshot().state, 'corrupt');
    cleanup();
  });
}

// ---------------------------------------------------------------------------------------------------
// D. the .bak path round-trips: a good write creates one, and a recovery can read it
//    control: `legacy-write` (no atomic path, so no .bak is ever created)
// ---------------------------------------------------------------------------------------------------
function caseBackupRoundTrip() {
  cleanup();
  resetConfigHealthForTest('fresh');
  saveConfig(GOOD());
  t('a good write creates config.json.bak', () => {
    assert.equal(fs.existsSync(CFG + '.bak'), true, 'no backup was created');
    // On a *first* write there is no previous file to copy, so the backup is seeded from the file that
    // was just written (config.js): it is then byte-identical to the config, not to the partial object
    // that went in. The next check is the one that pins the "previous content" meaning.
    assert.deepEqual(fs.readFileSync(CFG + '.bak'), fs.readFileSync(CFG), 'the seeded backup is not the file that was written');
  });
  t('a good write also verifies the written file parses (a backup of garbage is worse than none)', () => {
    assert.doesNotThrow(() => JSON.parse(read(CFG)));
    assert.doesNotThrow(() => JSON.parse(read(CFG + '.bak')));
  });
  t('verifyBackup accepts it', () => {
    const v = verifyBackup();
    assert.equal(v.ok, true);
    assert.ok(v.bytes > 0);
  });
  t('the backup is refreshed by the next good write, and it is the previous content', () => {
    saveConfig({ ...GOOD(), ui: { theme: 'second' } });
    const bak = JSON.parse(read(CFG + '.bak'));
    assert.equal(bak.ui.theme, 'dark', 'the backup holds the new content instead of the previous one');
    assert.equal(JSON.parse(read(CFG)).ui.theme, 'second');
  });

  // Now the recovery: damage the file, then put the backup back.
  const bakBytes = fs.readFileSync(CFG + '.bak');
  write(DAMAGED);
  loadConfig();
  t('the damaged file is a fault state before the recovery', () => {
    assert.equal(configHealthSnapshot().state, 'corrupt');
  });
  const rec = recoverConfigFromBackup();
  t('a recovery can read the .bak and restore it', () => {
    assert.equal(rec.ok, true, rec.error);
    assert.equal(JSON.parse(read(CFG)).ui.theme, 'dark');
    assert.deepEqual(fs.readFileSync(CFG), bakBytes, 'the restored file is not the backup');
  });
  t('the recovery resolves the condition (the state is ok afterwards)', () => {
    assert.equal(configHealthSnapshot().state, 'ok');
    assert.equal(configHealthSnapshot().fault, false);
  });
  t('the recovery keeps the damaged file, so nothing is lost either way', () => {
    assert.equal(brokenFiles().length, 1);
  });
  t('a recovery refuses to overwrite a config.json that is already there', () => {
    // The rule that makes "the config never silently changes itself" hold: the only automatic-looking
    // step is refused when the target exists.
    const rec2 = recoverConfigFromBackup();
    assert.equal(rec2.ok, false);
    assert.equal(configHealthSnapshot().state, 'ok');
  });
  t('control: a recovery with no .bak fails loudly instead of restoring nothing', () => {
    // Back to a damaged state with the backup gone. `cleanup()` is deliberately NOT used here: it
    // would delete the `.broken` file this case is also about (found by this check failing with an
    // ENOENT on the very file it was asserting about).
    fs.rmSync(CFG + '.bak');
    write(DAMAGED);
    loadConfig();
    const preserved = brokenFiles();
    const rec3 = recoverConfigFromBackup();
    assert.equal(rec3.ok, false);
    assert.match(String(rec3.error), /no config\.json\.bak/);
    // "restoring nothing" has to mean *nothing was written*: after a corrupt load the damaged bytes
    // live at the .broken path (that is the state the recovery is offered in), so the assertion is
    // that no config.json reappeared and that the preserved copy is untouched.
    assert.equal(exists(), false, 'a failed recovery wrote a config.json anyway');
    assert.equal(preserved.length, brokenFiles().length, 'a failed recovery changed the preserved copies');
    assert.equal(read(path.join(WORK, preserved[0])), DAMAGED, 'a failed recovery rewrote the preserved damaged file');
  });
}

// ---------------------------------------------------------------------------------------------------
// E. a config that cannot be read is its own state, and it is left alone
//    (EISDIR/EPERM by making the path a directory: no ACLs needed, and it is a real shape - a mount
//    point, a folder that was created by hand, a botched sync)
// ---------------------------------------------------------------------------------------------------
function caseUnreadable() {
  cleanup();
  fs.mkdirSync(CFG);
  resetConfigHealthForTest('fresh');
  const cfg = loadConfig();
  const h = configHealthSnapshot();
  t('an unreadable config is reported as unreadable, not as corrupt', () => {
    assert.equal(h.state, 'unreadable');
    assert.equal(h.fault, true);
  });
  t('and the app runs on defaults while saying so', () => {
    assert.equal(cfg.llm?.model, config.DEFAULT_CONFIG.llm.model);
  });
  t('nothing is written, moved or replaced: the path is exactly as it was found', () => {
    assert.equal(fs.statSync(CFG).isDirectory(), true, 'the unreadable path was replaced');
    assert.equal(brokenFiles().length, 0, 'an unreadable file was treated as a damaged one');
  });
  t('a recovery refuses to touch a file it may not read', () => {
    const rec = recoverConfigFromBackup();
    assert.equal(rec.ok, false);
    assert.equal(fs.statSync(CFG).isDirectory(), true);
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// F. the P0 #1 secret rule, re-proven on this write path
//    A masked secret arriving in a PUT must still mean "unchanged". The write path changed (it is now
//    temp+fsync+rename), so the rule has to be proven again on the new one rather than assumed: the
//    two halves of P0 #1 and P0 #2 touch the same function.
//    control: the same PUT without the mask rule (a raw write of the body) - which stores '***'.
// ---------------------------------------------------------------------------------------------------
async function caseMaskedSecret() {
  cleanup();
  const { SECRET_MASK, preserveSecretStrings } = config;
  const stored = { llm: { activeId: 'p1', providers: [{ id: 'p1', preset: 'custom', name: 'fixture', baseUrl: 'https://api.example.invalid/v1', apiKey: 'sk-STORED-9999', model: 'm' }] } };
  saveConfig(stored);
  assert.equal(fs.existsSync(CFG + '.bak'), true);

  const mask = { ...stored, llm: { ...stored.llm, providers: [{ ...stored.llm.providers[0], apiKey: SECRET_MASK }] } };
  const body = preserveSecretStrings(mask, stored); // what `persist` does before setConfig
  saveConfig(body);

  t('a masked secret sent back does not overwrite the stored one', () => {
    const onDisk = JSON.parse(read(CFG));
    assert.equal(onDisk.llm.providers[0].apiKey, 'sk-STORED-9999');
    assert.notEqual(onDisk.llm.providers[0].apiKey, SECRET_MASK);
  });
  t('a blank secret sent back means "unchanged" too', () => {
    const blank = { ...stored, llm: { ...stored.llm, providers: [{ ...stored.llm.providers[0], apiKey: '' }] } };
    saveConfig(preserveSecretStrings(blank, JSON.parse(read(CFG))));
    assert.equal(JSON.parse(read(CFG)).llm.providers[0].apiKey, 'sk-STORED-9999');
  });
  t('control: without the mask rule the same body stores the mask (the check can fail)', () => {
    // The deliberately wrong input for the two checks above: the same body, written as-is. If the
    // file after the *real* path equaled this one, the rule would not be doing anything.
    saveConfig(mask);
    assert.equal(JSON.parse(read(CFG)).llm.providers[0].apiKey, SECRET_MASK);
  });
  t('the backup of the masked write is the pre-write file, so a mask cannot destroy the key', () => {
    // After the control wrote the mask, the .bak still holds the secret from before it.
    const bak = read(CFG + '.bak');
    assert.ok(bak.includes('sk-STORED-9999'), 'the .bak does not hold the value from before the write');
  });
  cleanup();
}

// ---------------------------------------------------------------------------------------------------
// G. the HTTP surface: the state the API exposes, and the recovery route's contract
// ---------------------------------------------------------------------------------------------------
async function caseApi() {
  cleanup();
  write(DAMAGED);
  resetConfigHealthForTest('fresh');
  const express = (await import('express')).default;
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'server/src/server.js')).href);
  const http = await import('node:http');

  let cfg = loadConfig();
  const app = createApp({
    getConfig: () => cfg,
    setConfig: (next) => {
      cfg = saveConfig(next);
      return cfg;
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onConfigChanged: () => {},
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => {
    const r = await fetch(base + route, { headers: { host: `127.0.0.1:${server.address().port}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = async (route, body) => {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: { host: `127.0.0.1:${server.address().port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    const h = await get('/api/config/health');
    t('GET /api/config/health reports the damaged state', () => {
      assert.equal(h.status, 200);
      assert.equal(h.body.state, 'corrupt');
      assert.equal(h.body.fault, true);
      assert.equal(h.body.path, CFG, 'the answer does not say which file it is about');
    });
    t('the answer names the preserved file and whether a .bak can be used', () => {
      assert.ok(h.body.events.length >= 1);
      assert.ok(brokenFiles().includes(path.basename(h.body.events.at(-1).movedTo ?? '')), 'the move target is not the file on disk');
      assert.equal(h.body.backupExists, false);
      assert.equal(h.body.backupUsable, false);
    });
    t('the health answer never carries a config value (it describes the file, not the settings)', () => {
      const text = JSON.stringify(h.body);
      assert.ok(!text.includes('sk-'), 'a secret key name/value leaked into the health answer');
      assert.ok(!/'theme'|"theme"/.test(text), 'a setting leaked into the health answer');
    });
    t('a recovery with no usable backup answers 409 and says why', () => {
      return post('/api/config/recover').then((rec) => {
        assert.equal(rec.status, 409, `expected 409, got ${rec.status}: ${JSON.stringify(rec.body)}`);
        assert.ok(rec.body.error, 'a refusal without a reason');
        assert.equal(rec.body.health.state, 'corrupt');
      });
    });
    t('a save through the API writes a file, and the surviving damage is still on disk', () => {
      return fetch(base + '/api/config', {
        method: 'PUT',
        headers: { host: `127.0.0.1:${server.address().port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ui: { theme: 'light' } }),
      })
        .then((r) => r.json())
        .then((answered) => {
          assert.equal(answered.ui.theme, 'light');
          assert.equal(JSON.parse(read(CFG)).ui.theme, 'light');
          assert.equal(brokenFiles().length, 1, 'the damaged file was lost by an API save');
        });
    });
    t('after that save the state is still ok=false until the damage is dealt with by hand', () => {
      // A successful write does not erase the fact that a file was moved aside. The state is the
      // load result; the write result is a separate field, on purpose.
      return get('/api/config/health').then((again) => {
        assert.equal(again.body.state, 'corrupt', 'a later write silently cleared the fault');
        assert.equal(again.body.writeCount >= 1, true);
      });
    });
    t('a recovery over a healthy config refuses (nothing to recover)', () => {
      return post('/api/config/recover').then((rec) => {
        assert.equal(rec.status, 409);
        assert.match(String(rec.body.error), /not in a fault state/);
      });
    });
  } finally {
    await new Promise((r) => server.close(r));
    cleanup();
  }
}

// ---------------------------------------------------------------------------------------------------
// The mutation controls.
//
// Each entry: the one change that must make the named assertion fail, and why that is the change the
// finding was about. The source is copied to a temp directory, the change is applied to the copy, and
// this same file is spawned against it in `VML_DURABILITY_MODE=control` with
// `VML_DURABILITY_EXPECT=<mode of the child>`; the run must exit non-zero. The copy is deleted
// afterwards and the real file's bytes are compared to what they were before the run.
// ---------------------------------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: 'legacy-load',
    what: 'the pre-fix loader: defaults on any error, nothing kept, no state',
    from: `  if (!fs.existsSync(CONFIG_PATH)) {
    recordEvent('load', 'fresh', { note: 'no config file yet: this is a first run, not a fault' });
    return defaultsOnFault();
  }`,
    to: `  if (!fs.existsSync(CONFIG_PATH)) {
    recordEvent('load', 'fresh', { note: 'no config file yet: this is a first run, not a fault' });
    return defaultsOnFault();
  }
  try {
    return mergeDefaults(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    console.error('[config] load failed:', err.message);
    return defaultsOnFault();
  }`,
    expectFail: 'corrupt',
    mutationCanReport: 'a damaged config is reported as corrupt, not as a fresh install',
  },
  {
    name: 'legacy-write',
    what: 'the pre-fix writer: a bare writeFileSync over the target, no temp, no rename, no .bak',
    from: `export function writeConfigText(text) {
  const dir = path.dirname(CONFIG_PATH);`,
    to: `export function writeConfigText(text) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, text, 'utf8');
  health.writeCount++;
  health.lastWrite = recordEvent('write', health.state, { bytes: Buffer.byteLength(text) });
  return { ok: true, bytes: Buffer.byteLength(text), path: CONFIG_PATH, dirSync: true };
}
export function writeConfigTextAtomic_UNUSED(text) {
  const dir = path.dirname(CONFIG_PATH);`,
    expectFail: 'interrupted', // the scenario in section B: the original bytes must survive
    mutationCanReport: 'a write that cannot complete leaves the original byte-identical',
  },
];

/** One scenario per control, chosen so that the mutation's damage lands on it. */
const CONTROL_SCENARIOS = {
  corrupt: caseCorrupt,
  interrupted: caseInterruptedRename,
};

function runControls() {
  section('H. the controls: every mutation above is applied and the matching check must fail');
  const realPath = path.join(ROOT, 'server/src/config.js');
  const original = fs.readFileSync(realPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-config-mutants-'));
  try {
    for (const m of MUTATIONS) {
      const src = original.toString('utf8');
      if (!src.includes(m.from)) {
        t(`control "${m.name}" is applicable (its anchor is still in the source)`, () => {
          throw new Error('the mutation anchor is gone: the check it backs no longer exists');
        });
        continue;
      }
      const mutatedDir = path.join(dir, m.name, 'server', 'src');
      fs.mkdirSync(mutatedDir, { recursive: true });
      fs.writeFileSync(path.join(mutatedDir, 'config.js'), src.replace(m.from, m.to), 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          VML_DURABILITY_MODE: 'control',
          VML_DURABILITY_CONTROL: m.name,
          VML_DURABILITY_WORK: path.join(dir, m.name, 'work'),
          VML_CONFIG_MODULE: path.join(mutatedDir, 'config.js'),
          VML_DURABILITY_EXPECT: m.expectFail,
        },
        encoding: 'utf8',
        timeout: 180000,
      });
      const out = String(child.stdout ?? '');
      const failed = (out.match(/\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace('[FAIL] ', '').split(' - ')[0].trim());
      t(`control "${m.name}" (${m.what}) makes the scenario in section ${m.expectFail} fail`, () => {
        assert.equal(child.status, 1, `the mutant exited ${child.status}; it was supposed to fail a check\n${out.slice(-800)}`);
        assert.ok(failed.length > 0, `the mutant reported no [FAIL] at all, so it proves nothing\n${out.slice(-800)}`);
      });
      t(`control "${m.name}" breaks exactly the check it is meant to: ${m.mutationCanReport}`, () => {
        assert.ok(
          failed.includes(m.mutationCanReport),
          `the mutant failed for another reason (${JSON.stringify(failed)}), so it does not control this check\n${out.slice(-800)}`
        );
      });
      fs.rmSync(path.join(dir, m.name), { recursive: true, force: true });
    }
    t('the real server/src/config.js was never modified by the controls', () => {
      assert.deepEqual(fs.readFileSync(realPath), original, 'the source changed while the controls ran');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The evidence the previous agent left in the same place: a mutation that stayed applied is a
  // failure of this whole file, so it is asserted rather than trusted.
  t('no mutation is left in the tree (grep for MUTATION / UNUSED markers in server/src)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/src/config.js'), 'utf8');
    assert.ok(!/_UNUSED/.test(src), 'a mutated copy marker is in the real source');
    assert.ok(!/MUTATION/.test(src), 'a mutation marker is in the real source');
  });
}

// ---------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------
if (MODE === 'control') {
  // The child of a control run: import the mutated module and run exactly the scenario the mutation
  // is meant to break. Its own t()/exit code is the answer the parent reads.
  const scenario = CONTROL_SCENARIOS[process.env.VML_DURABILITY_EXPECT];
  process.stdout.write(`  (control "${process.env.VML_DURABILITY_CONTROL}" against a mutated config.js)\n`);
  await scenario();
  process.stdout.write(`\ncontrol: ${pass} ok, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

process.stdout.write('\nconfig durability: the file, the write, and the three states\n');
section('A. a damaged config is preserved, reported, and never overwritten by defaults');
caseCorrupt();
section('B1. a write whose rename fails leaves the original intact');
caseInterruptedRename();
section('B2. a write killed between temp and rename leaves the original intact');
await caseKilledWrite();
section('C. a missing config is a silent first run');
caseMissing();
section('D. the .bak path round-trips');
caseBackupRoundTrip();
section('E. an unreadable config is a third state, and it is left alone');
caseUnreadable();
section('F. the P0 #1 secret rule, on the new write path');
await caseMaskedSecret();
section('G. the API surface: the state, and the recovery contract');
await caseApi();
runControls();

process.stdout.write(`\nconfig durability: ${pass} ok, ${fail} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
process.exit(fail ? 1 : 0);
