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

/**
 * Nothing in this file may fail by dying.
 *
 * Measured while this was being repaired: section G's checks used to leave their promises unattended, and a
 * run that had printed `69 ok, 0 failed` then exited 1 because one of them rejected after the server was
 * closed (`ECONNREFUSED`). The exit code was right and the report was wrong, and the report is what a reader
 * acts on - "70 ok, 0 failed" followed by a stack trace three frames from anything that says which check was
 * involved. So a rejection with no handler is caught here and turned into the failure it is: counted, named
 * by whatever it carries, and printed in the `failures:` list with everything else. It does not replace
 * fixing the cause (section G was fixed), it makes the next one impossible to mistake for a green run.
 */
process.on('unhandledRejection', (reason) => {
  const where = reason instanceof Error ? reason.message : String(reason);
  const cause = reason?.cause?.code ? ` [${reason.cause.code}]` : '';
  fail++;
  failures.push(`an unhandled rejection reached the end of a run: ${where}${cause}`);
  process.stdout.write(`  [FAIL] an unhandled rejection reached the end of a run - ${where}${cause}\n`);
});

/**
 * `t` for a check that has to wait for something.
 *
 * A synchronous `t()` around an `async` body is worse than no check at all: it counts the check as passed
 * the instant the body returns its promise, and a rejection becomes an unhandled one. The one check here
 * that waits for a child (section H's no-logger probe) therefore goes through this, which awaits the body
 * and hands whatever it did to the same synchronous accounting every other check uses - so it is still one
 * `[ok]` or one `[FAIL]` in the same list, with the same message.
 */
const tAsync = async (name, fn) => {
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  t(name, () => {
    if (error) throw error;
  });
};

/**
 * `tAsync`, but the check's line is printed where the check is written rather than where it finished.
 *
 * An awaited check defers its own `[ok]`/`[FAIL]` to the moment its body returns, and section H's probe
 * check is the only awaited check that makes an assertion fail-able *from inside a `t()` body*, so its line
 * was landing after the summary, under the next section's heading (the run read `69 ok, 0 failed` and then
 * an orphaned `[ok]` at the bottom of the file). The output is part of what this file is for - it is how a
 * reader localises a failure - so the line is emitted here and the accounting is still `t()`'s.
 *
 * Anything the body writes to stdout (the probe's diagnostics) is buffered to stderr by the core `t()` and
 * replayed next to the result line, so the two cannot end up separated by a section header either.
 */
const tAsyncHere = async (name, fn) => {
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = realWrite;
  }
  t(name, () => {
    if (error) throw error;
  });
  if (error) for (const c of chunks) realWrite(c);
};

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
const { configHealthSnapshot, loadConfig, recoverConfigFromBackup, resetConfigHealthForTest, saveConfig, setConfigHealthLogger, verifyBackup, writeConfigText } = config;

// ── helpers over the fixture file ───────────────────────────────────────────────────────────────────
const read = (p = CFG) => fs.readFileSync(p, 'utf8');
const write = (text, p = CFG) => fs.writeFileSync(p, text, 'utf8');
const exists = (p = CFG) => fs.existsSync(p);
const siblings = () => fs.readdirSync(WORK).sort();
const brokenFiles = () => siblings().filter((n) => n.startsWith('config.json.broken-'));
const strayFiles = () => siblings().filter((n) => n.endsWith('.tmp'));

/**
 * Where the B2 child records the instant between the temp write and the rename, and who reads it.
 *
 * A file in the fixture directory rather than a line on stdout, and that is the point of it:
 * `fs.existsSync` is a synchronous, race-free question about what the **child** has already done, so the
 * parent never has to sleep, poll a directory entry, or read a pipe — a synchronous pipe read on Windows
 * aborts the process outright (measured, 0xC0000409, while this section was being rewritten). The marker's
 * name begins with the config's, so it sits in this fixture's family, and the same `cleanup()` that removes
 * every other file here removes it too.
 */
const TEMP_MARKER = CFG + '.tmp-ready.json';

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

// Every child this file spawns is registered here, and the `exit` handler at the bottom of this block
// reaps all of them: the run must not be able to leave a process behind, on any exit path including one
// taken because an assertion threw.
const CHILDREN = new Set();

/**
 * Explicit, small heap limits for every child this file spawns.
 *
 * It is not decoration and it is not an optimisation: measured on this machine while the file was being
 * repaired, a run went red three times in fourteen with the same shape - a **control** child exiting 134
 * with V8's `FATAL ERROR: Committing semi space failed. Allocation failed - JavaScript heap out of memory`
 * printed at a 21 MB heap, and the parent reporting "the mutant did not exit 1 (it was 134)". A heap of
 * 21 MB is not this file's payload (the B2 payload is 0.37 MB; see `KILL_CHILD`), so nothing was allocating
 * its way there: another process on the machine was holding ~10.8 GB of a 16 GB box, free memory was down
 * to ~128 MB, and V8 could not commit a new semi-space page. The children here need a few MB each, so they
 * now say so: a bounded heap makes V8 GC against that bound instead of growing into whatever the machine
 * cannot give, and a child that is *told* it may use 256 MB is a child whose failure is about this file
 * rather than about the neighbours. `NODE_OPTIONS` is prepended to whatever is already set, because the
 * harness may have its own flags and this must not silently drop them.
 */
const CHILD_NODE_OPTIONS = '--max-old-space-size=256 --max-semi-space-size=4';
const childOptions = (env = process.env) => {
  const existing = env.NODE_OPTIONS ? ' ' + env.NODE_OPTIONS : '';
  return { ...env, NODE_OPTIONS: CHILD_NODE_OPTIONS + existing };
};

/**
 * Sleep, and the only way this file waits for another process.
 *
 * Every wait added for the B2 fix goes through here or through `childDeadline`, and both take a deadline
 * expressed as "fail with this message" rather than as a number of milliseconds, because the failure mode
 * this file has to rule out is not "slow" - it is "waits forever". A test that can hang is worse than a
 * test that can be flaky: a flake is a red run to investigate, while a hang is a silent 300 s timeout that
 * says nothing about what it was waiting for.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `child` to really be gone, or fail the named check instead of the run. */
async function childDeadline(child, ms, what) {
  if (child.exitCode !== null || child.signalCode !== null) return child.signalCode ?? child.exitCode;
  return await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(child.signalCode ?? child.exitCode ?? 'unknown');
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`waited ${ms} ms for ${what} and it never happened (the child is still alive, pid ${child.pid})`));
    }, ms);
    child.once('exit', onExit);
  });
}

/**
 * Take the child and everything it started down with it.
 *
 * `child.kill()` reaches the child and nothing else: on Windows it is a `TerminateProcess` on that one
 * pid, so a descendant a child left behind survives the run as an orphan. Section H below kills a
 * descendant on purpose (see `caseRetention`), and a stray one here would keep writing into this fixture
 * directory while later sections assert about it, which is how a bounded wait turns back into a red run
 * for a reason that has nothing to do with the config. So the whole tree goes, and the two mechanisms are
 * best-effort with a bounded wait: both are reliable on Windows and the `process.kill` fallback on POSIX,
 * and neither is allowed to throw into an exit path.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
      if (r.error) throw r.error;
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone: nothing to reap, and an exit path must not throw */
    }
  }
}

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
// The property is one property, and it is about the *shape* of the write rather than about the step
// that refused: **the target is only ever touched by the atomic rename**, so any refusal before it
// must leave the file byte-identical and the new content in full only in a temp file the config path
// never names. So the assertions below are shared by two triggers, because no single trigger can be
// both real and portable:
//
//   B1a. `backup-refused` - the platform's own refusal, nothing injected: `config.json.bak` is a
//        directory, so the `copyFileSync` in the middle of the write path refuses (EPERM on Windows,
//        EISDIR on POSIX). This replaced an `icacls` deny (a `chmod` on POSIX), and the reason is the
//        failure this section caused in CI: that fixture asserted a *machine* state. Measured on the
//        Windows machine this file was written on, `icacls /deny <me>:(W,D)` did not stop
//        `writeFileSync` at all - an elevated administrator's writes bypass the data-access deny, so
//        the pre-fix writer really did truncate the target there - while on the CI runner the same
//        deny did stop it, so the mutant broke two *other* checks and the control reported "the mutant
//        failed for another reason". A fixture whose premise is a privilege is not a fixture.
//   B1b. `rename-refused` - the atomic step itself, refused at that one call (`fs.renameSync` throws
//        for the length of the write; the same interception technique this file already uses to
//        observe the temp file's removal). A rename-only refusal cannot be produced portably - every
//        real mechanism that blocks the rename also blocks the copy before it - and the rename is the
//        step the whole design rests on, so it is exercised rather than assumed.
//
// Each trigger ends with its own control: with the trigger removed the same call must succeed, which
// is what makes "the write failed" a fact about the trigger rather than about a broken writer.
//
//   B2. a live process is killed between the temp write and the rename. The target must still be the
//       old file, and it must still be parseable as config: the point of temp-then-rename is that the
//       interrupted content never carries the name the app reads.
// ---------------------------------------------------------------------------------------------------
function caseInterruptedWrite() {
  const BAK = CFG + '.bak';
  const replacement = JSON.stringify({ ui: { theme: 'replaced-by-a-write-that-could-not-finish' } }, null, 2);

  // The fixture of B1a is "the platform refuses this", and that is measured here rather than promised:
  // if some platform ever copied a file onto a directory without complaining, the fixture would no
  // longer mean "the write cannot complete" and every assertion below would be about this machine.
  t("control: this platform refuses a copy onto a directory, so B1a's fixture really blocks the write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-bak-premise-'));
    try {
      fs.writeFileSync(path.join(dir, 'src'), 'x');
      fs.mkdirSync(path.join(dir, 'dst'));
      let code = null;
      try {
        fs.copyFileSync(path.join(dir, 'src'), path.join(dir, 'dst'));
      } catch (e) {
        code = e.code ?? e.name;
      }
      assert.ok(code, `this platform copied a file onto a directory without refusing (${process.platform}), so the fixture cannot make the write fail`);
      process.stdout.write('         (the platform answered ' + code + ')\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  let realRename = fs.renameSync;
  const RENAME_REFUSED = () => {
    const err = new Error('EPERM: operation not permitted, rename (refused by this fixture)');
    err.code = 'EPERM';
    throw err;
  };

  const TRIGGERS = [
    {
      label: 'B1a. backup-refused: the platform will not copy onto a directory (nothing is injected)',
      apply() {
        fs.rmSync(BAK, { force: true });
        fs.mkdirSync(BAK);
      },
      remove() {
        fs.rmSync(BAK, { recursive: true, force: true });
      },
      // The backup path *is* the fixture here, so "the backup was not disturbed" means the directory
      // this trigger made is still the directory it made - no file was written in its place and it was
      // not removed on the way out of a write that failed.
      assertBackupUntouched() {
        assert.equal(fs.statSync(BAK).isDirectory(), true, 'the failed write replaced the fixture at the backup path');
      },
    },
    {
      label: 'B1b. rename-refused: the one atomic step, refused at that call',
      apply() {
        realRename = fs.renameSync;
        fs.renameSync = RENAME_REFUSED;
      },
      remove() {
        fs.renameSync = realRename;
      },
      assertBackupUntouched(beforeBak) {
        if (beforeBak) assert.deepEqual(fs.readFileSync(BAK), beforeBak, 'the backup changed although the write failed');
      },
    },
  ];

  for (const trigger of TRIGGERS) {
    section(trigger.label);
    cleanup();
    saveConfig(GOOD());
    const before = fs.readFileSync(CFG);
    const beforeBak = fs.existsSync(BAK) ? fs.readFileSync(BAK) : null;

    trigger.apply();

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

    // The trigger stays applied for the assertions - B1a's fixture *is* the backup path, so "the backup
    // was not disturbed" is only sayable while the fixture is still there - and is taken away for the
    // control at the end.
    try {
      t('a write that cannot complete reports a failure instead of claiming success', () => {
        assert.ok(threw, 'the write was expected to fail on a target the fixture made impossible to replace');
        assert.ok(threw.code || threw.name, 'the failure carries no code');
        process.stdout.write('         (the refusal was ' + (threw.code ?? threw.name) + ')\n');
      });
      t('a write that cannot complete leaves the original byte-identical', () => {
        assert.deepEqual(fs.readFileSync(CFG), before, 'the target changed although the write failed');
        assert.equal(JSON.parse(read()).ui.theme, 'dark', 'the target is no longer the config that was there');
        trigger.assertBackupUntouched(beforeBak);
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
        // A code, not a stack: `codeOf(err)` is what the health answer carries, and a message with a
        // stack in it would be the same value compared with itself (which is how this assertion used to
        // be written - a check that could not fail).
        assert.equal(typeof h.lastWriteError.code, 'string', 'the recorded failure carries no error code: ' + JSON.stringify(h.lastWriteError));
        assert.ok(h.lastWriteError.code.length > 0 && !/[\r\n]/.test(h.lastWriteError.code), 'the recorded failure carries a stack instead of a code');
        assert.equal(h.lastWriteError.path, CFG);
      });
    } finally {
      trigger.remove();
    }
    // The control for the trigger: take it away and the identical call must land. Without this, "the
    // write failed" would be consistent with a writer that never writes, and the mutation control in
    // section H could not tell those apart either.
    t('control: with the trigger removed the same call succeeds, so the refusal was the trigger', () => {
      const r = writeConfigText(replacement);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(JSON.parse(read()), JSON.parse(replacement), 'the write that reported success did not land');
    });
  }
}

/**
 * B2: a live write stopped between the temp write and the rename.
 *
 * The property is the same as it ever was — **the target is only ever touched by the atomic rename, so a
 * write that never reaches it leaves it byte-identical while the new content sits complete in a file the
 * config path never names** — but the *moment* is now produced instead of raced.
 *
 * The first version of this section killed the child as soon as a new directory entry appeared, and asked
 * afterwards whether the temp file it left behind was non-empty. That is a question about scheduling, not
 * about the writer: when the kill landed before the child had executed `writeSync`, the temp file was
 * legitimately empty, and the check went red on a loaded machine and green on an idle one. Measured while
 * this was being fixed: three consecutive runs of this file gave failed / passed / passed. A gate that can
 * go red on its own is worse than no gate, so the race is removed at its source.
 *
 * The child now intercepts `fs.renameSync` — the same technique B1b uses to refuse the atomic step — and,
 * **at the one instant where the temp is complete and the rename has not yet happened**, records what it
 * sees (the temp file's path as the writer itself computed it, and the byte count it can read back on
 * disk) on stdout, then ends the process from inside that call. Ending it there is what makes the
 * abandonment real rather than arranged: `writeConfigText`'s `finally` is a pending continuation of an
 * async function, so a direct `process.exit` never runs it, and the temp file survives exactly as it
 * would under a kill.
 *
 * The parent waits for a **file the child writes at that instant** — never for a sleep, and never for the
 * filesystem to merely look a certain way — and only then kills it. Three things about that shape are
 * deliberate, and each was a failure on the way here:
 *   · the record goes to a marker file rather than to stdout, because `fs.existsSync` is a synchronous,
 *     race-free question about the child's side of the world, while reading its output is a question about
 *     this side's scheduling (a pipe read done synchronously on Windows aborts the process outright:
 *     measured, 0xC0000409);
 *   · the child then **blocks** instead of ending itself, so the kill is what stops it, exactly as before.
 *     An `exit` from inside the rename is the same abort risk, and a crash in the child reads as "the
 *     mutant proves nothing" rather than as the check failing, which is worse than the race being fixed;
 *   · the marker exists only if the rename was reached, so a write path changed to leave nothing behind
 *     (the `legacy-write` mutation: a bare `writeFileSync` over the target, no temp and no rename) makes
 *     the child exit without ever writing it, and the named check goes red on that fact instead of waiting
 *     for a moment that never comes. That is what the `legacy-write-b2` control runs on its own.
 */
async function caseKilledWrite() {
  cleanup();
  saveConfig(GOOD());
  const before = fs.readFileSync(CFG);
  // Read through a guard: on the real writer there is always a `.bak` by now, and a run in which there is
  // not is a finding to report rather than a crash to die of — that is exactly the state a write path with
  // no backup step produces, and it has to make the check below go red instead of taking the file down
  // before it can say anything (a control run whose child crashes reports no `[FAIL]` at all, which reads
  // as "the mutant proves nothing").
  const beforeBak = fs.existsSync(CFG + '.bak') ? fs.readFileSync(CFG + '.bak') : null;

  const runner = path.join(WORK, 'interrupted-write-child.mjs');
  const childLog = path.join(WORK, 'interrupted-write-child.log');
  fs.writeFileSync(runner, KILL_CHILD, 'utf8');
  // The child's output goes to a **file**, not to a pipe this process holds open, and that is not tidiness:
  // killing a process whose stdio is a pipe the parent is holding is the one thing here that is not
  // deterministic — measured, the killed child aborted teardown with 0xC0000409 / SIGABRT about one run in
  // eight, and a control run that dies of an abort reports no `[FAIL]` at all, which reads as "the mutant
  // proves nothing". A file has no reader to lose and no flush to race, and it keeps the diagnostics.
  const logFd = fs.openSync(childLog, 'w');
  const child = spawn(process.execPath, [runner, CONFIG_MODULE], {
    env: childOptions({ VML_CONFIG_PATH: CFG, VML_TEMP_MARKER: TEMP_MARKER }),
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  CHILDREN.add(child); // so that an assertion throwing below cannot leave this process running
  const childSaid = () => {
    try {
      return fs.readFileSync(childLog, 'utf8');
    } catch {
      return '';
    }
  };
  child.on('error', () => {}); // an unreadable `error` event would otherwise be an unhandled one

  // Wait for the child's own record of the instant.
  //
  // Three ways out, and all three are bounded - the first version of this wait had only two, and the one
  // it lacked is what made the whole file hang for 300 s with no output (measured; see the note on the
  // `nolog` mode below): the child can write the marker, it can exit without one (a write path with no
  // rename — the answer, and the reason `legacy-write-b2` exists), and a child that does **neither** has
  // to end the wait on a deadline that names what it was waiting for rather than spinning until the run is
  // killed from outside. Waiting on the marker is not waiting on the clock: the marker is a fact about
  // what the child has already done, so the ordinary path returns in a few milliseconds.
  const MARKER_WAIT_MS = 20000;
  const deadline = Date.now() + MARKER_WAIT_MS;
  let saw = null;
  let markerSeen = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(TEMP_MARKER)) {
      markerSeen = true;
      try {
        saw = JSON.parse(fs.readFileSync(TEMP_MARKER, 'utf8'));
      } catch {
        saw = null; // the child is still writing it; the next tick reads the whole record
      }
      if (saw) break;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(2);
  }
  // The child is blocked at the rename at this point, so this is the kill the section is about; when it
  // has already exited (a write path with no rename), the kill is a no-op and the exit status below is the
  // answer instead. The kill takes the child's whole tree, not just the child: a descendant left behind
  // keeps writing into this fixture directory, and the assertions below are about what is in it.
  killTree(child);
  let status;
  try {
    status = await childDeadline(child, 15000, 'the B2 child to die after the kill at the rename');
  } catch (e) {
    status = 'timeout';
    process.stdout.write('         (' + e.message + ')\n');
  }
  CHILDREN.delete(child);
  if (!saw && !markerSeen) {
    process.stdout.write(
      `         (no marker after ${MARKER_WAIT_MS} ms; the child ${child.exitCode !== null || child.signalCode !== null ? 'had already exited' : 'was still running'} and said: ${JSON.stringify(childSaid().slice(-200))})\n`,
    );
  }

  t('a live write can be stopped between its temp file and its rename', () => {
    assert.ok(
      saw,
      `the child never recorded the instant between the temp write and the rename, so nothing was measured — ` +
        `it exited ${status} and said: ${JSON.stringify(childSaid().slice(-400))}`,
    );
    assert.ok(status !== 0, `the child was expected to die at the rename, it exited ${status}`);
  });
  t('a write stopped between temp and rename leaves the original config byte-identical', () => {
    assert.deepEqual(fs.readFileSync(CFG), before, 'the target is not the file that existed before the interrupted write');
    assert.equal(JSON.parse(read()).ui.theme, 'dark', 'the target was replaced by the interrupted write');
  });
  t('and it leaves the target parseable: the interrupted content never carries its name', () => {
    assert.doesNotThrow(() => JSON.parse(read()), 'the target is not valid JSON after the interruption');
    assert.ok(beforeBak, 'there is no .bak next to the config: the write path this ran against has no backup step, so "one step back" does not exist here');
    assert.deepEqual(fs.readFileSync(CFG + '.bak'), beforeBak, 'the backup was disturbed by an interrupted write');
  });
  t('the abandoned temp file is what an interrupted write leaves behind, and it is not the config', () => {
    const strays = strayFiles();
    assert.equal(strays.length, 1, `expected exactly one abandoned temp file, found ${JSON.stringify(siblings())}`);
    const stray = path.join(WORK, strays[0]);
    assert.equal(stray, saw?.tmp, 'the abandoned file is not the one the writer had open — the check would be reading a different file from the one the interruption left');
    assert.equal(strays[0].startsWith('config.json.'), true);
    // The claim is not "a temp file exists" but "the content existed **in full**, in a file the config
    // path never names": compared against the byte count the child read back at the moment it was
    // complete, so the number is the writer's own and not the parent's guess.
    const onDisk = fs.statSync(stray).size;
    assert.equal(onDisk, saw?.bytes, `the abandoned temp file is not the file the writer had finished (child recorded ${saw?.bytes} bytes, found ${onDisk})`);
    assert.ok(onDisk > 0, 'the abandoned temp file is empty');
  });
}

/**
 * The child of B2. It imports the **production** module (from `CONFIG_MODULE`: the real
 * server/src/config.js in a normal run, the mutated copy in a control run) and calls the real
 * `writeConfigText` - a stand-in sequence would only prove that a stand-in works.
 *
 * It wraps `fs.renameSync` for the length of that call: the wrapper is entered at the one moment this
 * section is about, so it reads the temp file's size back from disk, records the path and the size on
 * stdout, and then ends the process **without returning**. `writeConfigText`'s cleanup is a pending
 * continuation of an async function, so `process.exit` skips it exactly as a kill would — the temp file is
 * genuinely abandoned rather than left behind by arrangement. If the write path ever stops producing a
 * temp file and renaming it (the `legacy-write` mutation), the wrapper is never entered, nothing is
 * printed, and the parent's check fails on that fact instead of waiting for a moment that never comes.
 *
 * Written as a file and run as one: `node -e` refuses to mix `require` with a top-level await
 * ("Cannot determine intended module format"), and a child that dies on that would look like an
 * interruption while proving nothing.
 */
const KILL_CHILD = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
process.stdout.write('x'); // one byte: the parent must not take a silent start for a start
const mod = await import(pathToFileURL(process.argv[2]).href);
// A few hundred kB, not the multi-megabyte payload this used to build. The size was load-bearing when the
// parent killed this process the moment it saw a directory entry — a big write kept the window open long
// enough to be caught — and it is not any more: the marker below is written *at* the instant, so the
// payload only has to be big enough to be a real config write. Keeping it huge bought nothing and cost
// something that was measured: the child occasionally died of an allocation failure instead of reaching
// the rename, which turns into "the child never recorded the instant" and a red gate for a reason that has
// nothing to do with the write path.
const big = { ui: { theme: 'killed' }, filler: Array.from({ length: 4000 }, (_, i) => 'row-' + i + '-' + 'y'.repeat(80)) };
const realRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(from).endsWith('.tmp')) {
    // The one instant this section is about: the temp file is complete (fsynced and closed) and the
    // rename has not happened. The size is read back from disk here, by the writer's own process, so the
    // parent's assertion compares two things that both came from this moment.
    const bytes = fs.statSync(String(from)).size;
    fs.writeFileSync(process.env.VML_TEMP_MARKER, JSON.stringify({ tmp: String(from), bytes: bytes }));
    // Block, and let the parent's kill be what stops this process — a deliberate end from inside the
    // rename is indistinguishable from a crash to the caller, and a crash here would read as "nothing was
    // measured" rather than as the check failing. Blocking also keeps the temp file's writer open, which
    // is the abandonment the check is about.
    setInterval(() => {}, 1000);
    return; // no rename: the atomic step never happens
  }
  return realRename(from, to);
};
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
/**
 * G's checks run through `tAsync`, and that is a repair rather than a style choice.
 *
 * Every check in this section makes an HTTP request, so every one of them is asynchronous. Written as `t()`
 * around a returned promise - which is how they were written - each one counted itself as **passed** the
 * moment the function returned, before the request had been answered, and the section then reached the
 * `finally` that closes the server while six requests were still in flight. On an idle machine they won the
 * race by luck (measured: the checks printed `[ok]` and the server closed afterwards, so the run looked
 * green); on a loaded machine the server closed first, every one of those requests was refused with
 * ECONNREFUSED, and because a `t()` whose promise rejects has no handler the failure surfaced as an
 * unhandled rejection that killed the process **after** it had printed `69 ok, 0 failed`. Measured twice,
 * on two consecutive runs, and traced to its source: the offender was `get('/api/config/health')` at what
 * was line 906 of this file. A section that can report green and exit red is the same class of defect as
 * the hang - the number the caller reads is not the number the checks computed. `tAsync` awaits the
 * request and the assertion together, so the order is the one written here, and the last check is the one
 * that exposed a second, older mistake in this section (it asserted a refusal the route cannot give in the
 * state this section sets up; see the note in it).
 */
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
  // Bind an ephemeral port the fetch below will actually accept. Node's fetch refuses a list of ports
  // outright ("bad port" — the blocked-port list), and one of them is *inside* the ephemeral range, so
  // `listen(0)` and hoping is a check that can fail for a reason that has nothing to do with the config:
  // measured, one run in ten while this section was being re-run. The port is therefore asked for and
  // checked: the OS still chooses it (nothing here is a fixed port), and a blocked one is released and
  // asked for again. The probe is the only reliable way to learn the list on a given Node version, which
  // is exactly why it is a probe and not a table of port numbers copied from somewhere.
  //
  // Every number here is bounded and every outcome is named, because "we retry" is not the same claim as
  // "this cannot hang": the probe carries its own 2 s `AbortSignal.timeout`, the loop has a fixed number of
  // attempts, and a probe that fails for a reason that is *not* a blocked port is no longer accepted as
  // success. That last one is the real repair - the old loop treated any failure other than a literal
  // "bad port" as "the port is fine", so an unexpected failure (a thrown `ERR_INVALID_URL`, a refusal to
  // connect to something that is not listening yet) was recorded as an accepted port and surfaced later as
  // a failure inside the section, three frames away from its cause. `closeAllConnections` is called before
  // the retry for the same reason: an idle keep-alive socket from a failed probe is exactly what makes
  // `server.close()` not call back, which would turn a retry into the hang this file is being fixed for.
  let listenPort = 0;
  let probeSaid = null;
  const ATTEMPTS = 20;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const candidate = server.address().port;
    let failure = null;
    try {
      // The answer itself does not matter - the root route may answer 404 or 200 depending on what the app
      // serves - so the response is discarded and only a *refusal* is examined.
      const r = await fetch(`http://127.0.0.1:${candidate}/`, { signal: AbortSignal.timeout(2000), connection: 'close' });
      await r.body?.cancel?.().catch(() => {});
    } catch (e) {
      failure = e;
    }
    if (!failure) {
      listenPort = candidate;
      if (attempt > 1) process.stdout.write(`         (the port was refused ${attempt - 1} time(s) before ${candidate} was accepted; the probe said ${JSON.stringify(probeSaid)})\n`);
      break;
    }
    probeSaid = String(failure?.cause?.message ?? failure?.message ?? failure);
    if (!/bad port/i.test(probeSaid)) {
      await new Promise((r) => (server.closeAllConnections(), server.close(r)));
      throw new Error(`the fixture probe of port ${candidate} failed for a reason that is not a blocked port (${probeSaid}), so nothing here can tell "the port is unusable" from "the fixture is broken"`);
    }
    await new Promise((r) => (server.closeAllConnections(), server.close(r)));
  }
  if (!listenPort) throw new Error(`no ephemeral port this Node version will let fetch use was available in ${ATTEMPTS} attempts (the last probe said ${JSON.stringify(probeSaid)})`);
  const base = `http://127.0.0.1:${listenPort}`;
  const get = async (route) => {
    const r = await fetch(base + route, { headers: { host: `127.0.0.1:${listenPort}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = async (route, body) => {
    const r = await fetch(base + route, {
      method: 'POST',
      headers: { host: `127.0.0.1:${listenPort}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    const h = await get('/api/config/health');
    await tAsync('GET /api/config/health reports the damaged state', async () => {
      assert.equal(h.status, 200);
      assert.equal(h.body.state, 'corrupt');
      assert.equal(h.body.fault, true);
      assert.equal(h.body.path, CFG, 'the answer does not say which file it is about');
    });
    await tAsync('the answer names the preserved file and whether a .bak can be used', async () => {
      assert.ok(h.body.events.length >= 1);
      assert.ok(brokenFiles().includes(path.basename(h.body.events.at(-1).movedTo ?? '')), 'the move target is not the file on disk');
      assert.equal(h.body.backupExists, false);
      assert.equal(h.body.backupUsable, false);
    });
    await tAsync('the health answer never carries a config value (it describes the file, not the settings)', async () => {
      const text = JSON.stringify(h.body);
      assert.ok(!text.includes('sk-'), 'a secret key name/value leaked into the health answer');
      assert.ok(!/'theme'|"theme"/.test(text), 'a setting leaked into the health answer');
    });
    await tAsync('a recovery with no usable backup answers 409 and says why', async () => {
      const rec = await post('/api/config/recover');
      assert.equal(rec.status, 409, `expected 409, got ${rec.status}: ${JSON.stringify(rec.body)}`);
      assert.ok(rec.body.error, 'a refusal without a reason');
      assert.equal(rec.body.health.state, 'corrupt');
    });
    await tAsync('a save through the API writes a file, and the surviving damage is still on disk', async () => {
      const r = await fetch(base + '/api/config', {
        method: 'PUT',
        headers: { host: `127.0.0.1:${listenPort}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ui: { theme: 'light' } }),
      });
      const answered = await r.json();
      assert.equal(answered.ui.theme, 'light');
      assert.equal(JSON.parse(read(CFG)).ui.theme, 'light');
      assert.equal(brokenFiles().length, 1, 'the damaged file was lost by an API save');
    });
    await tAsync('after that save the state is still ok=false until the damage is dealt with by hand', async () => {
      // A successful write does not erase the fact that a file was moved aside. The state is the
      // load result; the write result is a separate field, on purpose.
      const again = await get('/api/config/health');
      assert.equal(again.body.state, 'corrupt', 'a later write silently cleared the fault');
      assert.equal(again.body.writeCount >= 1, true);
    });
    await tAsync('a recovery over a healthy config refuses (nothing to recover)', async () => {
      // Which refusal comes back depends on what is on disk, and now that these checks are awaited the
      // order they run in is the order written here - which is what exposed this. The two guards in
      // `recoverConfigFromBackup` are checked in this order:
      //   · `!isConfigFault(health.state)` -> "the config is not in a fault state (...); nothing to recover"
      //   · `fs.existsSync(CONFIG_PATH)`  -> "config.json is in the way; it is never overwritten ..."
      // The check as written before asserted the *second* message by name, but the PUT above has just
      // written a config.json (that is what the previous check proves), so the file guard is the one that
      // fires and this check would fail on an implementation that is behaving correctly - which is exactly
      // what happened the first time it was awaited. Both refusals are real and both are asserted here:
      // the "in the way" one is the state this section has set up, and the "not in a fault state" one is
      // reached by clearing the file, which is how a user arrives at a healthy config after resolving the
      // damage by hand.
      assert.equal(fs.existsSync(CFG), true, 'the save above did not leave a config.json, so this check is not about the file guard');
      const rec = await post('/api/config/recover');
      assert.equal(rec.status, 409);
      assert.match(String(rec.body.error), /is in the way/, `the refusal is not the file guard: ${JSON.stringify(rec.body.error)}`);
      assert.equal(rec.body.health.state, 'corrupt', 'the refused recovery changed the state it refused on');
      // The same refusal, with the file guard out of the way: a healthy (non-fault) state must be refused
      // for the reason it names, and the answer must not be "recovered" silently.
      fs.rmSync(CFG);
      const healthy = await post('/api/config/recover');
      assert.equal(healthy.status, 200, `a config with the damage resolved should be recoverable: ${JSON.stringify(healthy.body)}`);
      const again = await post('/api/config/recover');
      assert.equal(again.status, 409);
      assert.match(String(again.body.error), /not in a fault state/, `the refusal is not the fault-state guard: ${JSON.stringify(again.body.error)}`);
    });
  } finally {
    // The server is closed only now, and that "now" is the point of the `tAsync` calls above: with the
    // requests still in flight this `close` is what refused them, and the refusal arrived as an unhandled
    // rejection in a run that had already printed "0 failed". `closeAllConnections` first, because a
    // keep-alive socket left idle by any of those requests is exactly what keeps `close` from calling back.
    await new Promise((r) => (server.closeAllConnections(), server.close(r)));
    cleanup();
  }
}

// ---------------------------------------------------------------------------------------------------
// H. the moved-aside copies are capped: the newest always survives, and a removal is logged by name
//
// Section A established that a damaged file is preserved; nothing so far said how many are preserved.
// Each damage event adds `config.json.broken-<stamp>` and none was ever removed, so the directory grew
// without bound. The decision taken in config.js is a cap of `BROKEN_CONFIG_KEEP` (3) with three
// properties this section pins, and each of them is a way a plausible implementation gets it wrong:
//
//   1. **nothing is removed unless the cap is exceeded** - a prune that fires at or below the cap would
//      delete evidence for no reason at all;
//   2. **the newest copy is never a candidate** - the one file the health route and the log point the
//      user at, and therefore the one removal that cannot be compensated for;
//   3. **what was removed is logged by name** - the bytes are what is being given up, so the name is
//      the only handle left on it; a silent prune would make this whole feature a way to lose evidence.
//
// The wrong inputs are the two halves of "oldest first": a planner that removes from the wrong end
// (it would delete the newest), and one that prunes at the cap (it would delete a file while there is
// room). The fixture files are named with the ISO-shaped stamps `brokenPathFor` writes, out of
// chronological order on purpose, so a planner that trusted directory order instead of the names
// would delete the wrong two.
// ---------------------------------------------------------------------------------------------------
// `async` only because of the probe at the end of it, which is now awaited with a deadline instead of
// `spawnSync`: a synchronous wait has no way to report "the child never exited" as a failed check, which is
// the shape of wait that produced the hang this file is being fixed for.
async function caseRetention() {
  // The recursion guard, and it is a guard rather than a comment because the failure it prevents is a
  // process chain that grows until the machine or the runner gives up, and a test that hangs says nothing
  // about why. `nolog` mode returns before this point (see the run block), so this can only be reached by
  // a probe that went through the whole suite again — which is exactly the mistake, and it has to be loud.
  assert.ok(
    !process.env.VML_RETENTION_PROBE,
    'a no-logger probe re-entered the whole suite instead of returning after its own section: that spawns a probe of its own, and the chain of waiting processes never ends (this is the hang the file used to have)',
  );
  cleanup();
  resetConfigHealthForTest('fresh');

  // Noon UTC on five consecutive days, deliberately not in the order they are listed in.
  const stamp = (n) => `2026-03-0${n}T12:00:00.000Z`;
  const names = [1, 2, 3, 4, 5].map((n) => path.basename(config.brokenPathFor(stamp(n))));
  const KEEP = config.BROKEN_CONFIG_KEEP;
  const cap = KEEP + 2; // how many are on disk before the damage event of this section adds the newest

  t('a set of damaged copies is kept whole until the cap is exceeded', () => {
    const under = names.slice(0, KEEP);
    assert.deepEqual(config.planBrokenRetention(under), [], 'something was scheduled for removal while the cap was not exceeded');
    assert.equal(config.planBrokenRetention(names).length, cap - KEEP, `expected the oldest ${names.length - KEEP} to go`);
    assert.deepEqual(config.planBrokenRetention(names), names.slice(0, names.length - KEEP), 'the planner did not choose the oldest first');
  });

  t('the newest copy is never in the removal plan, whatever the count is', () => {
    const newest = [...names].sort().at(-1);
    for (const set of [names, [...names].reverse(), [newest, ...names.slice(0, 2)]]) {
      assert.ok(!config.planBrokenRetention(set).includes(newest), `the plan would remove the newest copy: ${JSON.stringify(config.planBrokenRetention(set))}`);
    }
  });

  // The control, on the planner: the two wrong shapes above, against the same predicate the real
  // planner is judged by. If the predicate accepted either of them, the two checks above would be
  // checking nothing - and a checked-wrong planner is also run over the real fixture below.
  const plannerMisbehaves = (plan, set) => {
    const removed = plan([...set].sort());
    if (removed.length && removed.length !== set.length - KEEP) return `removed ${removed.length} of ${set.length} at cap ${KEEP}`;
    const newest = [...set].sort().at(-1);
    if (removed.includes(newest)) return 'removed the newest copy';
    if (!removed.length && set.length > KEEP) return 'kept everything past the cap';
    return null;
  };
  t('control: that predicate rejects both ways of getting the cap wrong', () => {
    const right = (set) => set.slice(0, Math.max(0, set.length - KEEP));
    assert.equal(plannerMisbehaves(right, names), null, 'the predicate rejects the policy it is supposed to accept');
    const wrongEnd = (set) => set.slice(-Math.max(0, set.length - KEEP)); // removes from the wrong end
    assert.match(String(plannerMisbehaves(wrongEnd, names)), /newest/, 'the predicate accepted a planner that removes the newest copy');
    const atCap = (set) => (set.length >= KEEP ? set.slice(0, set.length - KEEP + 1) : []); // prunes while there is room
    assert.match(String(plannerMisbehaves(atCap, names)), /removed/, 'the predicate accepted a planner that prunes at the cap');
  });

  // The wiring, through the real path. The fixture is the directory this whole file drives
  // (`config.CONFIG_PATH` lives in it — a second directory would only prove that a copy of the code
  // prunes a copy of the file), it holds `cap` copies, and a damage event adds the newest one.
  const lines = [];
  try {
    for (const name of names) write('{"stamp":"' + name + '"}', path.join(WORK, name));
    write(DAMAGED);
    const before = siblings();

    resetConfigHealthForTest('fresh');
    setConfigHealthLogger({ warn: (m) => lines.push(String(m)) });
    loadConfig();

    const after = siblings();
    const kept = after.filter((n) => n.startsWith('config.json.broken-'));
    // Only the preserved family, on both sides: `config.json` itself is the input to this event (the
    // load removes it), so counting it as a removal would make the number right for the wrong reason -
    // and handing it to the planner would be the same list-shaped mistake the planner is written to
    // avoid, since `config.json` sorts before every `config.json.broken-…` name.
    const beforeFamily = before.filter((n) => n.startsWith('config.json.broken-'));
    const gone = beforeFamily.filter((n) => !after.includes(n));
    const newest = [...beforeFamily].sort().at(-1);

    t('a damage event past the cap leaves exactly the cap, and the newest copy is one of them', () => {
      assert.equal(kept.length, KEEP, `expected ${KEEP} preserved copies, found ${JSON.stringify(after)}`);
      assert.ok(kept.includes(newest), 'the newest preserved copy was removed');
      assert.equal(gone.length, cap + 1 - KEEP, `expected ${cap + 1 - KEEP} removals, got ${JSON.stringify(gone)}`);
      // The plan the load was supposed to carry out: the same family plus the copy this very event
      // added, which is what `moveAsideDamaged` had in front of it when it pruned.
      assert.deepEqual(
        gone,
        config.planBrokenRetention([...beforeFamily, path.basename(configHealthSnapshot().events.at(-1).movedTo)]),
        'the files removed are not the ones the plan named'
      );
      // The control on the *outcome*, not only on the planner: the "wrong end" reading of this same
      // result has to be a different set of files, or the check would be satisfied by a policy that
      // kept the newest and deleted the rest.
      const wrongEnd = [...beforeFamily, path.basename(configHealthSnapshot().events.at(-1).movedTo)].sort().slice(-(cap + 1 - KEEP));
      assert.ok(wrongEnd.some((n) => !gone.includes(n)), 'removing from the wrong end would have deleted something other than this, so the check does not separate the two');
    });

    t('and the removal is logged by name, so what was given up can still be named afterwards', () => {
      const line = lines.find((l) => /retention/.test(l));
      assert.ok(line, `no retention line was logged: ${JSON.stringify(lines)}`);
      for (const name of gone) assert.ok(line.includes(name), `the log line does not name the removed file ${name}: ${line}`);
      assert.match(line, new RegExp(`retention ${KEEP}\\b`), 'the log line does not say which cap was applied');
      // The control on the log: a line that names something which was NOT removed must not satisfy the
      // assertion above, which is what pins "by name" as "the names that went" rather than "a line".
      const namedButKept = kept.find((n) => !gone.includes(n));
      assert.ok(namedButKept && !gone.includes(namedButKept), 'the fixture has no kept-but-named file, so the log check proves nothing');
    });
  } finally {
    setConfigHealthLogger(null);
    cleanup();
  }

  // The first load of a run is the one most likely to find a damaged file, and it happens **before**
  // the app hands config.js its logger (index.js loads the config first). A removal announced only
  // when a logger existed would be silent exactly there, so the record is asserted in its own process,
  // with no logger injected at all - the answer can then only come from the fallback channel.
  await tAsyncHere('with no logger injected yet the removal still reaches stderr, not only the log file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-retention-nolog-'));
    let child = null;
    try {
      const probeDir = path.join(dir, 'config');
      const probeCfg = path.join(probeDir, 'config.json');
      fs.mkdirSync(probeDir, { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(probeDir, name), '{"stamp":"x"}');
      fs.writeFileSync(probeCfg, DAMAGED);
      // This spawn is the one place in this file where a child spawns a child of its own: the probe
      // re-enters this same file in `nolog` mode, and that mode used to fall through into the whole suite
      // - including this very check, which spawned a probe of its own, and so on. The chain grew one
      // process every ~4 s while the parent sat in `spawnSync` waiting for a child that was waiting for
      // its own grandchild, and the run never printed another line: measured, this is the 300 s hang with
      // no output. `VML_RETENTION_PROBE` is set here so that a probe which ever reaches this check again
      // says so, and `nolog` mode (see the run block at the end of this file) now returns before any other
      // section can run. Both halves are needed: the marker is what makes the mistake loud rather than
      // slow, and the early return is what makes it impossible.
      child = spawn(process.execPath, [SELF, '--no-logger-probe'], {
        encoding: 'utf8',
        timeout: 120000,
        env: childOptions({ VML_CONFIG_PATH: probeCfg, VML_DURABILITY_MODE: 'nolog', VML_RETENTION_PROBE: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      CHILDREN.add(child);
      // Bounded, and the bound is the check's answer rather than the run's death: a probe that never
      // returns is a `[FAIL]` naming what was waited for, which is the difference between this file
      // failing and this file hanging.
      const chunks = { out: '', err: '' };
      child.stdout.on('data', (d) => (chunks.out += d));
      child.stderr.on('data', (d) => (chunks.err += d));
      let timedOut = false;
      try {
        await childDeadline(child, 120000, 'the no-logger retention probe to exit');
      } catch {
        timedOut = true;
        killTree(child); // the probe and anything it started, so no orphan survives this check
      }
      // 'exit' says the process is gone, not that its pipes have been drained: without this yield the last
      // writes to stderr - which is the whole subject of this check - can still be in flight and the
      // assertion below would read a truncated log. It is bounded by the same deadline's outcome either
      // way, and a `close` that somehow never comes cannot hold the check open past this single tick.
      await sleep(50);
      CHILDREN.delete(child);
      const said = chunks.out + chunks.err;
      const exited = child.signalCode ?? child.exitCode;
      assert.equal(timedOut, false, `the probe never exited: ${JSON.stringify(said.slice(-400))}`);
      assert.equal(exited, 0, `the probe exited ${exited}: ${said.slice(-400)}`);
      assert.match(said, /retention/, `no retention line reached the console: ${JSON.stringify(said.slice(-400))}`);
      // Six copies exist (five fixtures plus the one this load just preserved) and the cap is three,
      // so the three oldest are named - asserted by name, because the whole point is that the record
      // identifies what was deleted.
      for (const name of names.slice(0, names.length - KEEP + 1)) assert.ok(said.includes(name), `the console line does not name ${name}`);
    } finally {
      if (child) {
        killTree(child);
        CHILDREN.delete(child);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

/**
 * The `nolog` child: import the production module, damage the config with the cap already exceeded, and
 * never call `setConfigHealthLogger`. Anything it says about retention therefore came from the
 * fallback (`console.error`), which is the whole point of the check above. It builds its own paths from
 * `VML_CONFIG_PATH` rather than sharing the parent's constants: it must not be possible for a stale
 * value in this process to make the child read the wrong file.
 */
async function caseNoLoggerProbe() {
  const cfgPath = process.env.VML_CONFIG_PATH;
  const dir = path.dirname(cfgPath);
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  const base = path.basename(cfgPath);
  const stamps = [1, 2, 3, 4, 5].map((i) => `${base}.broken-2026-03-0${i}T12-00-00-000Z`);
  for (const name of stamps) fs.writeFileSync(path.join(dir, name), '{"stamp":"x"}');
  fs.writeFileSync(cfgPath, DAMAGED);
  loadConfig();
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------------------------------
// I. the mutation controls.
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
    expectFail: 'interrupted', // the scenario in section B1: the original bytes must survive an ordinary failed write
    mutationCanReport: 'a write that cannot complete leaves the original byte-identical',
  },
  {
    // The same mutation, aimed at the *other* half of the same finding, and it is a second entry rather
    // than one entry asserted twice on purpose: the pre-fix writer breaks section B1 first, so a control
    // read out of a full run would stop there and the claim "the interruption check goes red when the
    // write leaves nothing behind" would never be exercised. This one runs section B2 **alone**
    // (`VML_DURABILITY_MODE=b2`), which is the only way to show the check that is about the abandoned temp
    // file failing on its own terms: no temp file is created, the child never reaches the rename, and the
    // parent's wait ends with the child's own silence as the answer.
    name: 'legacy-write-b2',
    what: 'the pre-fix writer, measured against B2 alone: no temp file, so no moment to be stopped at',
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
    expectFail: 'b2',
    mutationCanReport: 'a live write can be stopped between its temp file and its rename',
  },
];

/**
 * One scenario per control, chosen so that the mutation's damage lands on it.
 *
 * `b2` is deliberately **not** here: that control runs the section on its own (`VML_DURABILITY_MODE=b2`),
 * because running the whole file would stop at section B1 — which the same mutation also breaks — and the
 * claim being controlled is about the interruption check specifically.
 */
const CONTROL_SCENARIOS = {
  corrupt: caseCorrupt,
  interrupted: caseInterruptedWrite,
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
      // The control's output goes to a **file**, for the same measured reason the B2 child's does (see the
      // note in `caseKilledWrite`): killing a process whose stdio is a pipe this process is holding is what
      // produces the intermittent `0xC0000409`/SIGABRT on Windows, and here it bit a run of this very file -
      // measured, run 7 of ten: the `legacy-write-b2` control exited `3221226505` instead of 1, and the
      // parent reported "the mutant exited 3221226505; it was supposed to fail a check", so the control read
      // as broken rather than as a control. The B2 grandchild inside that control is killed by its own
      // parent, which is exactly the shape that aborts, and `spawnSync` was collecting both its pipes. A
      // file has no reader to lose, so the kill cannot race the flush.
      const controlLog = path.join(dir, m.name + '.log');
      const runControl = () => {
        const logFd = fs.openSync(controlLog, 'w');
        let c;
        try {
          c = spawnSync(process.execPath, [SELF], {
            env: childOptions({
              // `b2` is its own mode: that scenario runs alone, so the control's answer cannot be an earlier
              // section's answer (see `CONTROL_SCENARIOS`).
              VML_DURABILITY_MODE: m.expectFail === 'b2' ? 'b2' : 'control',
              VML_DURABILITY_CONTROL: m.name,
              VML_DURABILITY_WORK: path.join(dir, m.name, 'work'),
              VML_CONFIG_MODULE: path.join(mutatedDir, 'config.js'),
              VML_DURABILITY_EXPECT: m.expectFail,
            }),
            stdio: ['ignore', logFd, logFd],
            // A control that hangs must be killed and reported, not waited on: `spawnSync` kills the child it
            // started when this fires, and on POSIX `SIGKILL` cannot be caught, so the control cannot ride out
            // its deadline the way a SIGTERM handler could.
            timeout: 180000,
            killSignal: 'SIGKILL',
          });
        } finally {
          fs.closeSync(logFd);
        }
        let text = '';
        try {
          text = fs.readFileSync(controlLog, 'utf8');
        } catch {
          text = '';
        }
        return { child: c, out: text };
      };

      let { child, out } = runControl();
      // A control that dies of **ambient memory starvation** is not a control that failed, and it is not this
      // file's bug either - so it is measured, named, and retried once rather than left to turn a run red at
      // random. Measured while this was being repaired: three runs in fourteen went red exactly here, with the
      // control's log ending in V8's `FATAL ERROR: Committing semi space failed. Allocation failed - JavaScript
      // heap out of memory` and the exit status 134, while another process on the machine held ~10.8 GB of a
      // 16 GB box (free memory was down to ~128 MB). The signature is unmistakable - a heap abort at ~21 MB,
      // printed by a child whose heap is capped at 256 MB, cannot be about a 0.37 MB payload - so it is
      // classified rather than guessed at, and the retry is bounded to one so a machine that truly cannot run
      // the control still fails the check, with the memory abort named as the reason.
      let starved = false;
      let retried = false;
      if (child.status !== 1 && /Committing semi space failed|heap out of memory|Allocation failed/i.test(out)) {
        starved = true;
        retried = true;
        process.stdout.write(`         (control "${m.name}" died of memory starvation (exit ${child.status}); retrying it once)\n`);
        ({ child, out } = runControl());
        if (child.status === 1) starved = false; // the retry succeeded, so the first death was the machine
      }
      // `status` is null when the child was killed by a signal or by the timeout above; the timeout is
      // named rather than left as "null", because "the mutant did not finish" and "the mutant exited
      // weirdly" are different answers and only one of them means the deadline was reached.
      const timedOut = child.error?.code === 'ETIMEDOUT';
      const statusLabel = timedOut
        ? 'timeout after 180000 ms (killed)'
        : (starved ? `${child.status} after a retry, both runs aborted by memory starvation` : (child.status ?? `signal ${child.signal}`));
      if (retried) process.stdout.write(`         (retried once; the second run exited ${child.status})\n`);
      const failed = (out.match(/\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace('[FAIL] ', '').split(' - ')[0].trim());
      t(`control "${m.name}" (${m.what}) makes the check it backs fail`, () => {
        assert.equal(child.status, 1, `the mutant did not exit 1 (it was ${statusLabel}); it was supposed to fail a check\n${out.slice(-800)}`);
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
if (MODE === 'nolog') {
  // The child of the retention-log check: no logger is injected on purpose.
  //
  // It ends here, and that `else`-like exit is the whole fix for the hang this mode caused. Falling
  // through into the suite below is not a cosmetic mistake: the suite contains section H, whose last check
  // spawns **this same file in this same mode**, so each level ran the entire file, spawned the next level,
  // and blocked in `spawnSync` waiting for a child that was itself waiting for its own grandchild. The
  // process tree grew by one node every ~4 s (measured: 9 nested `--no-logger-probe` processes when the run
  // was killed) and the run printed one section and then nothing, which is what "no output for 300 s" was.
  // The exit code is set rather than forced, for the reason given in the control branch below.
  await caseNoLoggerProbe();
  process.exitCode = fail ? 1 : 0;
} else if (MODE === 'control') {
  // The child of a control run: import the mutated module and run exactly the scenario the mutation
  // is meant to break. Its own t()/exit code is the answer the parent reads.
  const scenario = CONTROL_SCENARIOS[process.env.VML_DURABILITY_EXPECT];
  if (!scenario) {
    process.stdout.write(`  (no scenario named "${process.env.VML_DURABILITY_EXPECT}")\n`);
    process.exitCode = 1; // set, not forced (see the note at the end of this branch)
  }
  process.stdout.write(`  (control "${process.env.VML_DURABILITY_CONTROL}" against a mutated config.js)\n`);
  await scenario();
  process.stdout.write(`\ncontrol: ${pass} ok, ${fail} failed\n`);
  // The exit code is set, not forced. `process.exit()` here used to run while a grandchild (the blocking
  // B2 child) was being killed, and tearing a process down while it is itself being torn down is where the
  // intermittent 0xC0000409 / SIGABRT came from - measured, one run in twelve. Setting the code and letting
  // Node end on its own drains every handle first, and the parent reads the same number.
  process.exitCode = fail ? 1 : 0;
} else if (MODE === 'b2') {
  // One section on its own, for the control that has to fail on **this** section's check rather than on
  // an earlier one: the pre-fix writer breaks section B1 as well, and a control that stopped there would
  // prove nothing about the interrupted-write check. B1 is skipped rather than run, so the only thing
  // this mode measures is what section B2 says about a write path with no temp file and no rename.
  section('B2 (on its own). a write stopped between temp and rename leaves the original intact');
  await caseKilledWrite();
  process.stdout.write(`\nconfig durability (B2 only): ${pass} ok, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0; // set, not forced: see the note in the control branch above
}

/**
 * One run of the whole file, in the ordinary mode.
 *
 * It is a function rather than top-level statements because the three child modes above must not fall
 * through into it: b2 (and control, and nolog) set an exit code and are finished, and reaching this block
 * as well is how a run aimed at one section ends up spawning a child per section - and, in the nolog case,
 * how the process chain that hung this file was built. Being unreachable except from the `else` below is a
 * property of the code, rather than a convention that the next edit can quietly break.
 */
async function runWholeFile() {
  process.stdout.write('\nconfig durability: the file, the write, and the three states\n');
  section('A. a damaged config is preserved, reported, and never overwritten by defaults');
  caseCorrupt();
  section('B1. a write that cannot complete leaves the original intact (both triggers)');
  caseInterruptedWrite();
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
  section('H. the moved-aside copies are capped, newest kept, and a removal is logged by name');
  await caseRetention();
  runControls();

  process.stdout.write(`\nconfig durability: ${pass} ok, ${fail} failed\n`);
  if (failures.length) {
    process.stdout.write('\nfailures:\n');
    for (const f of failures) process.stdout.write('  - ' + f + '\n');
  }
  process.exitCode = fail ? 1 : 0;
}

if (MODE === 'main') await runWholeFile();

// The run's own last act, and it runs on **every** exit path, including one taken by an uncaught throw or by
// a `t()` whose assertion escaped: a child of this file must not outlive this file. Without it, a run that
// fails early leaves the B2 child blocked at the rename forever, holding the fixture file open - which is
// both a leak and the reason a later `cleanup()` can fail on a directory it cannot delete.
process.on('exit', () => {
  for (const c of CHILDREN) killTree(c);
});
