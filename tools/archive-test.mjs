// archive-test.mjs — self-test for the incremental archive
//
// The archive layer has two big "fails quietly" traps that must be pinned down:
//   · **Not idempotent**: runs re-run and backfill, and duplicate writes make the chart numbers grow out of thin air
//   · **Parameter concatenation**: source ids / dates come from outside, so building SQL by string concatenation means injection
// It also verifies: migration can pick up an old database, gap-filling by day never breaks the line, and large volumes are not slow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  archivePath,
  dayOf,
  healthSeries,
  ingestItems,
  keywordSeries,
  migrate,
  openArchive,
  peopleSeries,
  queryItems,
  recentSeries,
  recordHealth,
  recordRun,
  series,
  stats,
} from '../server/src/archive.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-archive-'));
const dbPath = path.join(tmp, 'archive.db');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mk = (n, day, sourceId = 'src-a', extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `it-${day}-${sourceId}-${i}`,
    sourceId,
    title: `第 ${i} 条 · ${sourceId}`,
    text: '正文',
    url: `https://example.com/${i}`,
    publishedAt: `${day}T0${i % 10}:00:00Z`,
    ...extra,
  }));

process.stdout.write('\narchive: schema and migration\n');
t('user_version is the current version after creating the database', () => {
  const db = openArchive({}, { file: dbPath });
  const v = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(v, SCHEMA_VERSION);
  db.close();
});

t('reopening does not re-create tables and migration is re-entrant', () => {
  const db = openArchive({}, { file: dbPath });
  const r = migrate(db);
  assert.equal(r.from, SCHEMA_VERSION, 'already at the current version, so it must not migrate again');
  assert.equal(r.to, SCHEMA_VERSION);
  db.close();
});

t('an old database (user_version=0) can be picked up by migration', () => {
  const oldPath = path.join(tmp, 'old.db');
  const raw = openArchive({}, { file: oldPath });
  raw.exec('PRAGMA user_version = 0'); // simulate an old database
  raw.exec('DROP TABLE IF EXISTS source_health'); // simulate a missing new table
  raw.close();
  const db = openArchive({}, { file: oldPath });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM source_health').get());
  db.close();
});

process.stdout.write('\narchive: increment and idempotence\n');
const db = openArchive({}, { file: dbPath });

t('first write of N items', () => {
  const r = ingestItems(db, mk(10, '2026-09-01'), { day: '2026-09-01' });
  assert.equal(r.inserted, 10);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.days, ['2026-09-01']);
});

t('re-running the same day (same batch) does not double-count', () => {
  const r = ingestItems(db, mk(10, '2026-09-01'), { day: '2026-09-01' });
  assert.equal(r.inserted, 0, 'all of them should be skipped');
  assert.equal(r.skipped, 10);
  const row = db.prepare('SELECT items FROM daily WHERE day = ? AND source_id = ?').get('2026-09-01', 'src-a');
  assert.equal(Number(row.items), 10, 'the daily count must not double');
});

t('incremental run: 5 new items add exactly 5', () => {
  const more = mk(15, '2026-09-01').slice(10);
  const r = ingestItems(db, more, { day: '2026-09-01' });
  assert.equal(r.inserted, 5);
  assert.equal(stats(db).items, 15);
});

t('empty input and items missing an id do not blow up', () => {
  assert.deepEqual(ingestItems(db, [], { day: '2026-09-02' }).inserted, 0);
  const r = ingestItems(db, [{ title: 'no id' }, null, undefined], { day: '2026-09-02' });
  assert.equal(r.inserted, 0);
});

t('the publish day wins over the run day (old content caught across midnight belongs to its own date)', () => {
  assert.equal(dayOf({ publishedAt: '2026-08-30T12:00:00Z' }, '2026-09-01'), '2026-08-30');
  assert.equal(dayOf({}, '2026-09-01'), '2026-09-01');
  assert.equal(dayOf({ publishedAt: 'not a time' }, '2026-09-01'), '2026-09-01');
});

t('multiple sources are counted separately', () => {
  ingestItems(db, mk(4, '2026-09-03', 'src-x'), { day: '2026-09-03' });
  ingestItems(db, mk(6, '2026-09-03', 'src-y'), { day: '2026-09-03' });
  const s = series(db, { days: 7, endDay: '2026-09-03' });
  const d3 = s.days.find((d) => d.day === '2026-09-03');
  assert.equal(d3.items, 10);
});

process.stdout.write('\narchive: chart queries\n');
t('the by-day series fills in empty days (the chart must not break its line)', () => {
  const s = series(db, { days: 5, endDay: '2026-09-03' });
  assert.equal(s.days.length, 5);
  assert.deepEqual(
    s.days.map((d) => d.day),
    ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']
  );
  assert.equal(s.days.find((d) => d.day === '2026-08-31').items, 0, 'a day with no run should be 0, not absent');
});

t('the series grouped by source, plus the totals', () => {
  const s = series(db, { days: 7, endDay: '2026-09-03', groupBy: 'source' });
  assert.equal(s.totals[0].sourceId, 'src-a');
  assert.equal(s.totals[0].items, 15);
  // Note: when grouped by source, days only contains **days with real data** (a sparse view, so 30 empty maps are not stuffed into 30 days)
  assert.ok(s.days.length >= 2, 'actual ' + s.days.length);
  const d3 = s.days.find((d) => d.day === '2026-09-03');
  assert.equal(d3.sources['src-x'], 4);
  assert.equal(d3.sources['src-y'], 6);
  assert.equal(d3.items, 10, 'the per-day total has to be right');
});

t('the activity series for followed people', () => {
  ingestItems(db, mk(3, '2026-09-04', 'src-z', { people: ['jaran'] }), { day: '2026-09-04' });
  ingestItems(db, mk(2, '2026-09-04', 'src-z2', { people: ['jaran', 'rei'] }), { day: '2026-09-04' });
  const p = peopleSeries(db, { days: 7, endDay: '2026-09-04' });
  assert.equal(p.totals.find((x) => x.personId === 'jaran').items, 5);
  assert.equal(p.totals.find((x) => x.personId === 'rei').items, 2);
  assert.equal(p.byDay.jaran['2026-09-04'], 5);
});

t('keyword trend', () => {
  ingestItems(db, mk(2, '2026-09-05', 'src-k', { keywords: ['3D披露'] }), { day: '2026-09-05' });
  const k = keywordSeries(db, { days: 7, endDay: '2026-09-05' });
  assert.equal(k.keywords[0].keyword, '3D披露');
  assert.equal(k.keywords[0].total, 2);
});

t('source health: success rate and average duration', () => {
  for (let i = 0; i < 4; i++) recordHealth(db, { day: '2026-09-05', sourceId: 'src-a', ok: i < 3, ms: 100 + i * 10 });
  const h = healthSeries(db, { days: 7, endDay: '2026-09-05' });
  const a = h.sources.find((x) => x.sourceId === 'src-a');
  assert.equal(a.checks, 4);
  assert.equal(a.ok, 3);
  assert.equal(a.rate, 0.75);
  assert.equal(a.avgMs, 110);
});

t('run records are written', () => {
  recordRun(db, { runId: 'r1', day: '2026-09-05', mode: 'daily', sourcesOk: 2, sources: 3, items: 7, alerts: 1 });
  recordRun(db, { runId: 'r1', day: '2026-09-05', mode: 'daily', sourcesOk: 3, sources: 3, items: 7, alerts: 0 });
  const s = stats(db);
  assert.equal(s.runs, 1, 'the same runId should overwrite, not add');
});

process.stdout.write('\narchive: query safety and overview\n');
t('a malicious source id cannot inject (parameterized)', () => {
  const evil = "src-a'; DROP TABLE items; --";
  ingestItems(db, [{ id: 'evil-1', sourceId: evil, title: 'x' }], { day: '2026-09-06' });
  const s = series(db, { days: 7, endDay: '2026-09-06', groupBy: 'source' });
  assert.ok(s.totals.some((x) => x.sourceId === evil), 'it should be stored as a plain string');
  assert.ok(stats(db).items > 0, 'the items table must still be there');
});

t('a malicious query string cannot inject', () => {
  const rows = queryItems(db, { q: "%' OR '1'='1" });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0, 'it should match as a plain string, not match every row');
});

t('the per-person query (LIKE-based) matches correctly too', () => {
  const rows = queryItems(db, { personId: 'jaran', limit: 50 });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.people.includes('jaran')));
});

t('pagination parameters are clamped (you cannot ask for a million rows)', () => {
  const rows = queryItems(db, { limit: 10 ** 6 });
  assert.ok(rows.length <= 1000);
});

t('archive overview', () => {
  const s = stats(db);
  assert.ok(s.items >= 30, 'actual ' + s.items);
  assert.ok(s.firstDay <= s.lastDay);
  assert.ok(s.bySource.length > 0);
});

process.stdout.write('\narchive: performance\n');
t('1000 writes + queries stay within a reasonable duration', () => {
  const t0 = Date.now();
  const big = Array.from({ length: 1000 }, (_, i) => ({
    id: 'big-' + i,
    sourceId: 'src-big-' + (i % 20),
    title: 'bulk item ' + i,
    publishedAt: new Date(Date.UTC(2026, 8, 10, i % 24)).toISOString(),
  }));
  ingestItems(db, big, { day: '2026-09-10' });
  const s = series(db, { days: 30, endDay: '2026-09-10', groupBy: 'source' });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `took ${ms}ms`);
  assert.equal(s.totals.reduce((n, x) => n + x.items, 0) >= 1000, true, 'the totals should include those 1000 items');
  process.stdout.write(`         (1000 items + 30-day aggregation ${ms}ms)\n`);
});

db.close();

t('the database file really lands on disk', () => {
  assert.ok(fs.existsSync(dbPath));
  assert.ok(fs.statSync(dbPath).size > 0);
});

t('archivePath follows the configured feedsDir', () => {
  const p = archivePath({ paths: { feedsDir: tmp } });
  assert.ok(p.startsWith(tmp));
  assert.ok(p.endsWith('archive.db'));
});

process.stdout.write('\narchive: sub-day ranges for the trend chart\n');
// The daily table cannot see below a day, so the chart's short ranges are counted from the items and
// grouped into buckets. These checks pin the two things that could quietly go wrong: a bucket count that
// does not match the window, and a bucket label the axis cannot read.
t('a sub-day window is bucketed by minutes, and the items land inside it', () => {
  const db = openArchive({}, { file: dbPath });
  try {
    const now = Date.now();
    const ins = db.prepare(
      'INSERT OR IGNORE INTO items (id, day, source_id, title, published_at, first_seen_at, people, keywords, image_count) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    for (let i = 0; i < 5; i++) {
      const at = new Date(now - i * 6 * 60000).toISOString();
      ins.run(`sub-${i}`, at.slice(0, 10), 'src-sub', 'x', at, at, JSON.stringify(['p1']), JSON.stringify(['k1']), i === 0 ? 1 : 0);
    }
    const r = recentSeries(db, { minutes: 30, bucketMinutes: 1 });
    // 30 buckets of one minute, give or take the one the window boundary lands in
    assert.ok(r.days.length >= 30 && r.days.length <= 31, `expected 30 or 31 buckets, got ${r.days.length}`);
    assert.match(r.days[0].day, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'the bucket label is a minute-precision timestamp');
    assert.equal(r.bucket.minutes, 1);
    assert.equal(r.bucket.alertGranularity, 'day', 'alerts stay day-granular and the answer says so');
    const counted = r.days.reduce((a, b) => a + b.items, 0);
    assert.ok(counted >= 1, `the items written inside the window should be counted, got ${counted}`);
    assert.equal(r.days.reduce((a, b) => a + b.media, 0), 1, 'the item with an image is counted as media');
    assert.ok(r.totals.some((x) => x.sourceId === 'src-sub'), 'totals carry the source');
    assert.ok(r.peopleTotals.some((x) => x.personId === 'p1'), 'people totals are parsed from the text column');
    assert.ok(r.keywords.some((x) => x.keyword === 'k1'), 'keyword totals are parsed from the text column');
    const four = recentSeries(db, { minutes: 240, bucketMinutes: 15 });
    assert.ok(four.days.length >= 16 && four.days.length <= 17, `4h in 15-minute buckets: got ${four.days.length}`);
    assert.equal(four.bucket.minutes, 15);
    const three = recentSeries(db, { minutes: 4320, bucketMinutes: 360 });
    assert.ok(three.days.length >= 12 && three.days.length <= 13, `3d in 6-hour buckets: got ${three.days.length}`);
    // And the day-based path still answers a day range with one row per day.
    assert.equal(series(db, { days: 7 }).days.length, 7);
  } finally {
    // Close it even when an assertion above fails: a handle left open makes the temp directory
    // undeletable, and the cleanup error would then hide the real one.
    db.close();
  }
});

t('the chart offers exactly the ranges the server knows', () => {
  // Two lists that have to agree, in two files that cannot see each other: a range in the selector with no
  // entry in the server's table silently falls back to 30 days, which looks like the selector being
  // ignored rather than like a mistake.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const chartSrc = fs.readFileSync(path.join(ROOT, 'web/src/pages/Charts.jsx'), 'utf8');
  const serverBlock = /const RANGES = \{([\s\S]*?)\n\s*\};/.exec(serverSrc)?.[1] ?? '';
  const serverKeys = [...serverBlock.matchAll(/'([0-9]+[mhd])':\s*\{/g)].map((m) => m[1]).sort();
  const chartBlock = /const RANGES = \[([\s\S]*?)\n\s*\];/.exec(chartSrc)?.[1] ?? '';
  const chartKeys = [...chartBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.ok(serverKeys.length >= 11, `expected the server to know the ranges, parsed ${serverKeys.length}`);
  assert.deepEqual(chartKeys, serverKeys, 'the selector and the server must offer the same ranges');
  for (const want of ['30m', '1h', '4h', '12h', '1d', '3d', '360d']) {
    assert.ok(chartKeys.includes(want), `${want} should be offered`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
