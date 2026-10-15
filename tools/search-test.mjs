// search-test.mjs — the search window: `days` is a calendar window ending today, and "all" is unbounded
//
// The defect this pins down (BUGS #108, measured before any of it was changed):
//   · `listRunDirs` was `readdirSync().filter(date-shaped).sort().reverse().slice(0, days)` — **the
//     newest N run directories**, which is not the same statement as "the last N days". On a machine
//     dated 2026-10-15, `days: 3` was answered with 2026-08-20 through 2026-08-22: correct as "three
//     newest directories", two months wrong as "three days". A user who stops running for a while and
//     then asks for the last week is handed stale data while the honest answer is the empty set.
//   · `search()` read the argument through `Number(query.days) || 60`, and the search page sends `0`
//     for its "all" option — so "all" silently became "the newest 60 runs".
//
// Both halves are silent: the endpoint answers 200 with a plausible-looking corpus either way.
//
// Every check below is paired with a **control**, and the controls are two different kinds:
//   · the pre-fix implementation, written out inline (`legacyListRunDirs`) and asserted to answer
//     *differently* — if the shipped code ever drifts back toward it, these go red;
//   · a measurement that the assertion would be vacuous without (a corpus where 0 and 60 happen to
//     agree proves nothing about the falsy collapse, so B3 uses one where they cannot).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Loaded through a resolver rather than a static specifier, for the reason archive-day-test does the same:
// the mutation controls at the bottom point `VML_SEARCH_MODULE` at a mutated **copy** in a temporary
// directory, so the real server/src/search.js is never written. A control that edited the tracked file and
// restored it with `git checkout` would restore the *commit* rather than the working tree - which is how a
// control once deleted the very work it was meant to back.
const SEARCH_MODULE = process.env.VML_SEARCH_MODULE ?? new URL('../server/src/search.js', import.meta.url).href;
const { buildIndex, resolveDays, search } = await import(SEARCH_MODULE);
// day.js is not mutated by any control here, so it is imported normally.
import { dayOfInstant, dayStamp, todayIn } from '../server/src/day.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const DAY_MS = 86_400_000;

// The zone is pinned rather than taken from the machine, so the fixture's dates mean the same thing on
// any host and in CI. `feeds/` directory names come from `todayIn(cfg)` (reports.js:12), so pinning the
// zone here pins exactly what the module under test reads.
const ZONE = 'UTC';

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
const show = (s) => process.stdout.write(s + '\n');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-search-window-'));

/** The day `k` days before today, as the fixture (and the product) writes it */
const dayAgo = (k) => dayOfInstant(dayStamp(todayIn({ calendar: { timeZone: ZONE } })) - k * DAY_MS, ZONE);

/**
 * A feeds tree with one run directory per offset, each carrying exactly one item.
 *
 * One item per directory matters: it makes `items.length` equal the number of directories inside the
 * window, so a check can name the window it got instead of only the count.
 */
function makeFeeds(offsets) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'feeds-'));
  for (const k of offsets) {
    const d = dayAgo(k);
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(
      path.join(root, d, '_items.json'),
      JSON.stringify({
        generatedAt: `${d}T12:00:00.000Z`,
        items: [{ id: `it-${d}`, sourceId: 'src', title: `item collected on ${d}`, text: 'body' }],
      }),
      'utf8',
    );
  }
  return root;
}
const cfgFor = (root) => ({ paths: { feedsDir: root }, calendar: { timeZone: ZONE } });
const windowOf = (root, days) => buildIndex(cfgFor(root), { days }).runs.map((r) => r.date);

/**
 * The pre-fix rule, written out on purpose and used only as a control.
 *
 * It is inline rather than imported because the whole point is that it no longer exists in the product:
 * a control that called the shipped code would be asserting the new rule against itself.
 */
function legacyListRunDirs(root, days) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()
    .slice(0, days);
}

// ───────────────────────────────────────────── A. the window is a calendar window

show('A. `days` is a calendar window ending today, not a count of directories');

{
  // One directory, dated 100 days ago. A 7-day window contains it no more than a 100-day window
  // contains a directory dated last year.
  const root = makeFeeds([100]);
  const got = windowOf(root, 7);
  t('a 7-day window excludes a directory dated 100 days ago (even though it is the only one present)', () =>
    assert.deepEqual(got, [], `expected nothing inside the window, got ${JSON.stringify(got)}`));

  // The control: the pre-fix rule answers with it, because it counts directories instead of reading the
  // calendar. If this ever stops being true the check above has lost its meaning, so it is asserted too.
  const legacy = legacyListRunDirs(root, 7);
  t('control: the pre-fix "newest N directories" rule DOES return it', () =>
    assert.equal(legacy.length, 1, `the control must disagree with the fix, got ${JSON.stringify(legacy)}`));
}

{
  const root = makeFeeds([0]);
  t('a directory dated today is inside a 7-day window', () => assert.equal(windowOf(root, 7).length, 1));
  const legacy = legacyListRunDirs(root, 7);
  t('control: on this corpus the two rules agree, which is why the check above is not the load-bearing one', () =>
    assert.deepEqual(windowOf(root, 7), legacy));
}

{
  const root = makeFeeds([-1]);
  t('the window has an upper bound: a directory dated tomorrow is outside a 7-day window', () =>
    assert.deepEqual(windowOf(root, 7), []));
  const legacy = legacyListRunDirs(root, 7);
  t('control: the pre-fix rule cannot see the upper bound at all, so it returns the future directory', () =>
    assert.equal(legacy.length, 1));
}

{
  // Both ends, one day apart: with `days: 7` the window is today-6 .. today inclusive.
  const root = makeFeeds([6, 7]);
  const got = windowOf(root, 7);
  t('the window includes its far end (today-6 in a 7-day window) and excludes the day after it (today-7)', () => {
    assert.equal(got.length, 1, `expected exactly one directory, got ${JSON.stringify(got)}`);
    assert.equal(got[0], dayAgo(6));
  });
}

{
  // The whole point of the entry, expressed as the user meets it: a gap in running must not resurrect
  // old data under a recent label. The nearest directory is 8 days old, so a 7-day window - the closed
  // range today-6 .. today - is genuinely empty.
  const root = makeFeeds([8, 40, 88]);
  t('a gap in runs leaves a recent window empty rather than filling it with older directories', () => {
    assert.deepEqual(windowOf(root, 7), [], 'nothing ran inside the last 7 days');
    assert.equal(windowOf(root, 90).length, 3, 'a 90-day window (today-89 .. today) does contain all three');
  });
  const near = makeFeeds([6, 88]);
  t('the window is inclusive at both ends, so "n days ago" needs a window of n+1 to be reached', () => {
    assert.equal(windowOf(near, 7).length, 1, 'today-6 is inside a 7-day window');
    assert.equal(windowOf(near, 88).length, 1, 'today-88 is still outside an 88-day window');
    assert.equal(windowOf(near, 89).length, 2, 'an 89-day window (today-88 .. today) is the first that holds both');
  });
  t('control: the pre-fix rule answers the 7-day question with data from 40 days ago', () =>
    assert.equal(legacyListRunDirs(root, 7).length, 3));
}

// ───────────────────────────────────────────── B. "all" is unbounded

show('\nB. an explicit 0 means no bound, which is what the search page sends for "all"');

{
  const root = makeFeeds([0, 30, 100, 400]);
  const all = windowOf(root, 0);
  const sixty = windowOf(root, 60);
  t('`days: 0` indexes every directory present', () => assert.equal(all.length, 4, JSON.stringify(all)));
  t('omitting `days` still means the 60-day default', () => assert.equal(sixty.length, 2, JSON.stringify(sixty)));
  // The corpus is chosen so the two cannot agree: two directories sit outside 60 days. Without that,
  // "0 behaves like 60" would pass this check while being exactly the bug.
  t('control: 0 and 60 cannot agree on this corpus (two directories are older than 60 days)', () => {
    assert.notDeepEqual(all, sixty);
    assert.ok(all.length > sixty.length, `all=${all.length} sixty=${sixty.length}`);
  });
}

{
  const root = makeFeeds([0, 100]);
  const r = search(cfgFor(root), { days: 0 });
  t('the answer reports the window it actually used, and says when there is none', () => {
    assert.equal(r.corpus.days, 0);
    assert.equal(r.corpus.unbounded, true);
    assert.equal(r.corpus.runs, 2);
  });
  const r60 = search(cfgFor(root), {});
  t('a request that omits `days` reports the default and is not unbounded', () => {
    assert.equal(r60.corpus.days, 60);
    assert.equal(r60.corpus.unbounded, false);
    assert.equal(r60.corpus.runs, 1);
  });
  t('control: the pre-fix expression turned the same input into 60', () => {
    // `Number(0) || 60` — the expression that used to sit in search.js, asserted here so the two
    // readings of 0 stay visibly different.
    assert.equal(Number(0) || 60, 60);
    assert.notEqual(resolveDays(0), Number(0) || 60);
  });
}

{
  t('resolveDays: omitted means the default, 0 and negatives mean unbounded, a number means itself', () => {
    assert.equal(resolveDays(undefined), 60);
    assert.equal(resolveDays(null), 60);
    assert.equal(resolveDays(''), 60);
    assert.equal(resolveDays(0), 0);
    assert.equal(resolveDays(-5), -5);
    assert.equal(resolveDays(7), 7);
    assert.equal(resolveDays('30'), 30);
    assert.equal(resolveDays(7.9), 7);
  });
  t('resolveDays: garbage falls back to the default rather than to "unbounded"', () => {
    // Failing open matters here: a typo must not silently turn into "read every run directory ever",
    // which is the opposite mistake from the one this entry is about.
    assert.equal(resolveDays('seven'), 60);
    assert.equal(resolveDays(NaN), 60);
    assert.equal(resolveDays({}), 60);
  });
}

// ───────────────────────────────────────────── C. what the window is asked for survives to the answer

show('\nC. the resolved window is the one the index was built from');

{
  const root = makeFeeds([0, 1, 5, 10, 199]);
  const r = search(cfgFor(root), { days: 7 });
  t('a search with `days: 7` searches the directories of the last 7 days and no others', () => {
    const dates = r.items.map((i) => i.runDate).sort();
    assert.deepEqual(dates, [dayAgo(5), dayAgo(1), dayAgo(0)].sort(), JSON.stringify(dates));
  });
  const r200 = search(cfgFor(root), { days: 200 });
  t('control: widening the window changes the answer (the check above is not "everything is excluded")', () => {
    assert.equal(r200.corpus.runs, 5);
    assert.ok(r200.total > r.total, `${r200.total} should exceed ${r.total}`);
  });
}

{
  // A windowed search and an explicit range are two different questions, and both still work: the range
  // filters items by their own time, the window decides which directories are read.
  const root = makeFeeds([0, 400]);
  const ranged = search(cfgFor(root), { days: 0, from: dayAgo(2), to: dayAgo(0) });
  t('a day window and an item range compose without either hiding the other', () => {
    assert.equal(ranged.corpus.runs, 2, 'both directories are read');
    assert.equal(ranged.items.length, 1, 'only the item inside the range is returned');
    assert.equal(ranged.outsideTimeRange, 1, 'and the excluded one is reported, not silently dropped');
  });
}

// ───────────────────────────────────────────── the controls
//
// Every mutation below is applied to a **copy of the whole server/src directory** in a temporary directory,
// and the suite is re-run against that copy through VML_SEARCH_MODULE; the real file is never written. The
// copy is of the whole directory rather than of one file because the module graph reaches ./day.js and
// ./config.js by relative specifier, so a mutant sitting by itself in a temp directory cannot resolve them
// (and would die with ERR_MODULE_NOT_FOUND, which says nothing about the check it is meant to back).
//
// A control that edits the tracked file and restores it from git restores the *commit*, not the working
// tree - which is how a control once deleted the work it was meant to back. Here the real file's sha256 is
// compared after the run instead, and no restore is ever attempted.

const MUTATIONS = [
  {
    name: 'newest-directories',
    word: 'the pre-fix rule that counts directories instead of reading the calendar',
    from: '  return all.filter((d) => {\n    const t = dayStamp(d);\n    return t >= cutoff && t <= today;\n  });',
    to: '  return all.slice(0, n);',
    expect: 'a 7-day window excludes a directory dated 100 days ago',
  },
  {
    name: 'unbounded-window',
    word: 'a window with no upper end',
    from: '    return t >= cutoff && t <= today;',
    to: '    return t >= cutoff;',
    expect: 'the window has an upper bound',
  },
  {
    name: 'off-by-one-window',
    word: 'a window n days wide instead of n-1',
    from: '  const cutoff = today - (n - 1) * DAY_MS;',
    to: '  const cutoff = today - n * DAY_MS;',
    expect: 'the window is inclusive at both ends',
  },
  {
    name: 'falsy-collapse',
    word: 'the `Number(x) || 60` collapse that turned "all" into 60',
    from: '  const days = resolveDays(query.days);',
    to: '  const days = Number(query.days) || 60;',
    expect: 'the answer reports the window it actually used',
  },
];

if (!process.env.VML_SEARCH_MUTANT) {
  const SRC = path.join(ROOT, 'server', 'src');
  const realSearch = path.join(SRC, 'search.js');
  const originalHash = createHash('sha256').update(fs.readFileSync(realSearch)).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-search-mutants-'));

  show('\nthe controls (each assertion must be able to fail)');
  try {
    for (const m of MUTATIONS) {
      const work = path.join(dir, m.name);
      fs.cpSync(SRC, path.join(work, 'server', 'src'), { recursive: true });
      const target = path.join(work, 'server', 'src', 'search.js');
      const source = fs.readFileSync(target, 'utf8');
      if (!source.includes(m.from)) {
        t(`control "${m.name}" is applicable (its anchor is still in the source)`, () => {
          throw new Error('the mutation anchor is gone from search.js, so this control no longer backs anything');
        });
        continue;
      }
      // The MUTATION marker rides the generated copy only; the grep at the end proves it never reached the
      // real tree, which is the failure the first version of this kind of proof produced elsewhere.
      fs.writeFileSync(target, `// MUTATION ${m.name}\n${source.split(m.from).join(m.to)}`, 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: { ...process.env, VML_SEARCH_MODULE: pathToFileURL(target).href, VML_SEARCH_MUTANT: m.name },
        encoding: 'utf8',
        timeout: 120000,
        killSignal: 'SIGKILL',
      });
      const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      const failures = (out.match(/^\s*\[FAIL\] (.+)$/gm) ?? []).map((l) => l.replace(/^\s*\[FAIL\] /, ''));
      t(`control "${m.name}" (${m.word}) turns the suite red`, () => {
        assert.equal(child.status, 1, `the mutant exited ${child.status}, not 1\n${out.slice(-600)}`);
        assert.ok(failures.length > 0, `the mutant reported no [FAIL] at all, so it proves nothing\n${out.slice(-600)}`);
      });
      t(`control "${m.name}" breaks the check it is meant to: ${m.expect}`, () => {
        assert.ok(
          failures.some((f) => f.includes(m.expect)),
          `it failed for another reason (${JSON.stringify(failures.slice(0, 3))}), so it does not back that check\n${out.slice(-600)}`,
        );
      });
      fs.rmSync(work, { recursive: true, force: true });
    }
    t('the real server/src/search.js was never modified by the controls', () => {
      const now = createHash('sha256').update(fs.readFileSync(realSearch)).digest('hex');
      assert.equal(now, originalHash, 'search.js changed while the controls ran');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  t('no mutation marker is left anywhere in the tree', () => {
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'pw-browsers', 'logs', 'reports', 'feeds', 'thumbs', 'advice']);
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) return skip.has(e.name) ? [] : walk(full);
        return /\.(js|jsx|mjs|cjs)$/.test(e.name) ? [full] : [];
      });
    const dirty = walk(ROOT)
      .filter((f) => !f.endsWith('search-test.mjs'))
      .filter((f) => /^\/\/ MUTATION \S/m.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    assert.deepEqual(dirty, [], 'a mutation marker is in the tree');
  });
}

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
show(`\nsearch window: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
