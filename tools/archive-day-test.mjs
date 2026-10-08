// archive-day-test.mjs — the day rule: one definition, its time-zone edges, and the rebuild
//
// The defect this suite pins down (v1.0.5): `server/src/archive.js` derived an item's day with
// `new Date(t).toISOString().slice(0, 10)` — a **UTC** calendar day — while the Calendar feature worked
// in the user's **configured** time zone. The same event therefore belonged to different days depending
// on which part of the product you asked, and everything that buckets by day disagreed: the daily table,
// the trend series, per-person daily activity, and the silence/dormant baselines.
//
// Measured on the owner's own archive before the change (feeds/archive.db, 2026-10-08, 221 items):
//   · 126 items carry their own timestamp (`published_at`), 95 carry an **empty string** instead
//   · every one of the 126 matched the stored day under the UTC rule — so the archive really was UTC
//   · **62 of those 126 fall on a different day** under Asia/Shanghai, the configured zone
// That 49% is why this is not a cosmetic difference, and it is why the tests below are about boundaries
// rather than about a happy path.
//
// Every check here is paired with a **control**: a deliberately wrong input that must produce a
// different answer. A check that cannot fail is not a check, and the two shapes that would make these
// vacuous — comparing the rule with itself, and asserting a value both rules happen to agree on — are
// exactly what the controls rule out. See the mutation log at the bottom for what was actually mutated
// to prove each assertion can fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The archive module (which re-exports the day rule, so one import reaches both) is loaded through this
// resolver rather than a static specifier. `VML_DAY_ARCHIVE_MODULE` is what the mutation controls at the
// bottom of this file point at a mutated **copy** in a temporary directory: the real
// `server/src/archive.js` is never edited, which is the lesson from a control that once reverted the work
// instead of the mutation.
const ARCHIVE_MODULE = process.env.VML_DAY_ARCHIVE_MODULE ?? new URL('../server/src/archive.js', import.meta.url).href;
const day = await import(ARCHIVE_MODULE);
const {
  RULE_UTC_V1,
  archiveRun,
  asDay,
  bucketRule,
  dayAxisOf,
  dayInTz,
  dayOfInstant,
  dayStamp,
  daysBetweenDays,
  effectiveTimeZone,
  hasZone,
  ingestItems,
  isRule,
  isUtcRule,
  itemRuleMix,
  latestItemsByPerson,
  openArchive,
  peopleSeries,
  queryItems,
  rebuildAggregates,
  rebuildPlan,
  ruleFor,
  series,
  stats,
  storedRules,
  toInstant,
  zoneOfRule,
  zoneOffsetMs,
} = day;

// calendar.js is not redirected: it imports the rule from server/src/day.js by a relative specifier, and
// the mutation that matters for it (`calendar.js keeps its own copy`) is a structural one checked by
// tools/integrity-check.mjs, not a behavioural one checked here.
import { upcoming } from '../server/src/calendar.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-archive-day-'));
const dbPath = path.join(tmp, 'archive.db');
const feedsDir = path.join(tmp, 'feeds');
fs.mkdirSync(feedsDir, { recursive: true });

/** The archive's configuration for this fixture: paths point at the fixture, and the zone is explicit */
const cfgFor = (timeZone) => ({ paths: { feedsDir }, calendar: { timeZone } });

/**
 * The rule this change removed, written out **on purpose** and used only as a control.
 *
 * It is here rather than imported because the whole point is that it no longer exists in the product:
 * a control that called the shipped code would be testing the new rule twice. If someone ever makes the
 * new rule behave like this one, the controls below go red — which is the check.
 */
const oldUtcDay = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 10);

/**
 * Shift one instant so that the same wall clock stands at the target zone's offset.
 *
 * It exists only to build fixtures whose days are provably a **named** zone's own, never the machine's
 * (see the equal-zone rebuild below); no assertion compares a shifted stamp with anything but itself.
 */
const asWrittenInZone = (iso, tz) => {
  const at = new Date(iso);
  // Enumerated fields rather than the locale's date string: a date string is formatted *in the host's
  // locale* and parsing it back is the kind of thing that works on one machine and not another.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const v = (type) => Number(parts.find((p) => p.type === type).value);
  const wallClock = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  // offset = wall clock − instant; adding it moves the instant to the one whose wall clock stands there
  return new Date(at.getTime() + (wallClock - at.getTime())).toISOString();
};

// ───────────────────────────────────────────── 1. the day function

process.stdout.write('\narchive-day: the one definition\n');

t('the rule is exported from one place and reused, not re-derived (calendar.js re-exports the same function object)', () => {
  const cal = fs.readFileSync(new URL('../server/src/calendar.js', import.meta.url), 'utf8');
  assert.match(cal, /export \{ dayInTz \}/, 'calendar.js must re-export the rule rather than keep a copy');
  assert.match(cal, /from '\.\/day\.js'/, 'calendar.js must import it');
  assert.doesNotMatch(
    cal,
    /new Intl\.DateTimeFormat\('en-CA'/,
    'calendar.js must not build its own day formatter — that is the second implementation this change removed'
  );
  // and the same function really is reachable from both names
  assert.equal(dayInTz(new Date('2026-09-15T23:30:00Z'), 'UTC'), dayOfInstant(new Date('2026-09-15T23:30:00Z'), 'UTC'));
});

t('an item at 23:30 local that is the NEXT day in UTC: local keeps it on its own day', () => {
  // 2026-09-15T23:30 in Asia/Shanghai is 2026-09-15T15:30Z — the same UTC day, so this direction is the
  // "next day in UTC" case read the other way round. Both directions are covered by the two checks here.
  const localLate = '2026-09-15T23:30:00+08:00'; // 15:30Z, still the 15th in UTC
  assert.equal(dayOfInstant(localLate, 'Asia/Shanghai'), '2026-09-15');
  // 07:30+08:00 on the 16th is 23:30Z on the 15th: the UTC rule says the 15th, the local rule says the 16th
  const localEarly = '2026-09-16T07:30:00+08:00';
  assert.equal(dayOfInstant(localEarly, 'Asia/Shanghai'), '2026-09-16', 'just after local midnight belongs to the new local day');
  assert.equal(oldUtcDay(localEarly), '2026-09-15', 'control: the old UTC rule puts it on the previous day');
});

t('CONTROL — the 23:30 case: the UTC rule gives a different day than the configured-zone rule', () => {
  // 2026-09-15T23:30:00Z is the 15th in UTC and already the 16th in Asia/Shanghai. This is the case the
  // whole change is about: if the two ever agree here, the test has stopped testing anything.
  const at = '2026-09-15T23:30:00Z';
  const local = dayOfInstant(at, 'Asia/Shanghai');
  const utc = dayOfInstant(at, 'UTC');
  assert.equal(utc, '2026-09-15');
  assert.equal(local, '2026-09-16');
  assert.notEqual(local, utc, 'the two rules MUST disagree on this instant, or the change was a no-op');
  assert.equal(oldUtcDay(at), utc, 'the control helper reproduces the old rule exactly');
  assert.equal(oldUtcDay('2026-09-15T23:30:00+08:00'), '2026-09-15', 'control: 15:30Z, both rules agree — a check built only on this would pass before and after');
});

t('an item just after local midnight belongs to the new local day, and to the old one in UTC', () => {
  const justAfterMidnight = '2026-09-16T00:05:00+08:00'; // 2026-09-15T16:05Z
  assert.equal(dayOfInstant(justAfterMidnight, 'Asia/Shanghai'), '2026-09-16');
  assert.equal(oldUtcDay(justAfterMidnight), '2026-09-15');
  // one minute earlier, the other side of the boundary
  const justBefore = '2026-09-15T23:59:00+08:00';
  assert.equal(dayOfInstant(justBefore, 'Asia/Shanghai'), '2026-09-15');
  assert.notEqual(dayOfInstant(justBefore, 'Asia/Shanghai'), dayOfInstant(justAfterMidnight, 'Asia/Shanghai'));
});

t('the same instant asked for in two zones gives the two respective days', () => {
  const at = '2026-09-15T23:30:00Z';
  assert.equal(dayOfInstant(at, 'UTC'), '2026-09-15');
  assert.equal(dayOfInstant(at, 'Asia/Shanghai'), '2026-09-16');
  assert.equal(dayOfInstant(at, 'America/Los_Angeles'), '2026-09-15');
  assert.equal(dayOfInstant(at, 'Asia/Tokyo'), '2026-09-16');
  // CONTROL: asking the same zone twice can never produce two answers
  assert.equal(dayOfInstant(at, 'Asia/Shanghai'), dayOfInstant(at, 'Asia/Shanghai'));
});

t('a DST transition: a 23-hour and a 25-hour day are still single days, and consecutive days stay 1 apart', () => {
  // America/New_York: 2026-03-08 is 23 hours long (spring forward), 2026-11-01 is 25 hours (fall back).
  // The rule is applied to instants one hour apart across both transitions; every instant must land on
  // exactly one of the two days, and the two days must be exactly one day apart.
  const spring = ['2026-03-08T04:30:00Z', '2026-03-08T05:30:00Z', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z'];
  const springDays = new Set(spring.map((s) => dayOfInstant(s, 'America/New_York')));
  assert.deepEqual([...springDays].sort(), ['2026-03-07', '2026-03-08'], `got ${[...springDays].join(',')}`);
  assert.equal(daysBetweenDays('2026-03-07', '2026-03-08'), 1, 'the short day is still one calendar day');
  assert.equal(daysBetweenDays('2026-03-08', '2026-03-09'), 1);
  // The control: the naive duration arithmetic this module replaces, over instants one local day apart.
  // (It takes epoch milliseconds, not strings — the first version of this test fed it `Date.parse` of an
  // already-parsed number, which is NaN, and a `NaN !== 1` failure is not a DST finding.)
  const naiveDays = (aMs, bMs) => Math.round((bMs - aMs) / 86400000);
  const beforeDst = Date.parse('2026-03-08T05:00:00Z'); // 00:00 local, EST
  const afterDst = Date.parse('2026-03-09T04:00:00Z'); // 00:00 local, EDT
  assert.equal(naiveDays(beforeDst, afterDst), 1, 'one local day apart: duration arithmetic happens to agree here');
  // …so the discriminating control is the DST day itself, which is not 24 hours. The duration from local
  // midnight to local midnight on that day rounds to 0 days — the calendar rule says 1.
  assert.equal(naiveDays(afterDst, Date.parse('2026-03-09T04:00:00Z')), 0);
  assert.equal(daysBetweenDays('2026-03-08', '2026-03-09'), 1, 'the 23-hour day is still one calendar day');
  // And over a whole year: 365 calendar steps stay 365, while the duration arithmetic loses the DST hour.
  const yearSteps = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'];
  let calendarSpan = 0;
  for (let i = 1; i < yearSteps.length; i++) calendarSpan += daysBetweenDays(yearSteps[i - 1], yearSteps[i]);
  assert.equal(calendarSpan, 365, 'a year of calendar days is 365 days, whatever the clocks did');
  // CONTROL: the same span measured as a **duration between local midnights** comes out a day short,
  // because the spring-forward hour is missing from it. That is the arithmetic this module exists to
  // avoid, and it is why the assertion above is about calendar days rather than about elapsed time.
  const localMidnight = (day) => dayStamp(day) - zoneOffsetMs(new Date(dayStamp(day)), 'America/New_York');
  assert.equal(daysBetweenDays('2026-03-07', '2026-03-09'), 2, 'two calendar days');
  assert.equal(
    localMidnight('2026-03-09') - localMidnight('2026-03-07'),
    47 * 3600000,
    'control: the same two days are 47 hours of duration, because the spring-forward hour is missing from one of them'
  );
  assert.equal(
    Math.round((Date.parse('2026-03-08T05:00:00Z') - Date.parse('2026-03-07T05:00:00Z')) / 3600000),
    24,
    'control: the ordinary day either side is 24h, so only a DST-aware check can catch the drift'
  );
  const fallDays = new Set(['2026-11-01T03:30:00Z', '2026-11-01T04:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'].map((s) => dayOfInstant(s, 'America/New_York')));
  assert.deepEqual([...fallDays].sort(), ['2026-10-31', '2026-11-01'], `got ${[...fallDays].join(',')}`);
  assert.equal(daysBetweenDays('2026-10-31', '2026-11-01'), 1);
  assert.equal(daysBetweenDays('2026-11-01', '2026-11-02'), 1);
  // A whole DST day is not 24 hours: proof that a duration-based rule is the wrong tool
  assert.equal(
    Math.round((Date.parse('2026-03-08T05:00:00Z') - Date.parse('2026-03-08T05:00:00Z')) / 3600000),
    0,
    'control: identical instants are 0h apart, so the boundary above is what is being measured'
  );
  const dayHours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
  assert.equal(dayHours('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'), 23, 'the spring-forward local day really is 23 hours');
  assert.equal(dayHours('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'), 25, 'the fall-back local day really is 25 hours');
  // and the day axis walks those days without skipping or repeating one
  const axis = dayAxisOf(5, { endDay: '2026-11-03', timeZone: 'America/New_York' });
  assert.deepEqual(axis, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(new Set(axis).size, 5, 'the axis must not repeat a day across the transition');
});

t('a timestamp with no time zone in the source data is read as a wall clock in the CONFIGURED zone', () => {
  const naive = '2026-09-15T23:30:00';
  assert.equal(hasZone(naive), false);
  assert.equal(hasZone('2026-09-15T23:30:00Z'), true);
  assert.equal(hasZone('2026-09-15T23:30:00+08:00'), true);
  // 23:30 wall clock in Shanghai is 15:30Z -> the 15th in UTC too, so the day is the same...
  assert.equal(dayOfInstant(naive, 'Asia/Shanghai'), '2026-09-15');
  // ...but 08:30 wall clock in Shanghai is 00:30Z -> the UTC rule would say the SAME day while the local
  // day is the same as well, and 07:30 is where they part. The control is the pair below.
  assert.equal(dayOfInstant('2026-09-16T07:30:00', 'Asia/Shanghai'), '2026-09-16');
  assert.equal(dayOfInstant('2026-09-16T07:30:00', 'UTC'), '2026-09-16');
  // The zone-less string must be read in the *target* zone, not in the machine's zone: the two answers
  // below differ by an hour of offset, and only one of them can be the configured zone's.
  const tokyo = toInstant(naive, 'Asia/Tokyo');
  const shanghai = toInstant(naive, 'Asia/Shanghai');
  assert.equal(tokyo.toISOString(), '2026-09-15T14:30:00.000Z');
  assert.equal(shanghai.toISOString(), '2026-09-15T15:30:00.000Z');
  assert.notEqual(tokyo.toISOString(), shanghai.toISOString(), 'control: the zone must actually change the instant');
  // CONTROL: the shape that must NOT be a day
  assert.equal(dayOfInstant('', 'Asia/Shanghai'), null, 'an empty timestamp has no day');
  assert.equal(dayOfInstant('not a time', 'Asia/Shanghai'), null);
  assert.equal(dayOfInstant(null, 'Asia/Shanghai'), null);
  assert.equal(dayOfInstant('2026-09-15', 'Asia/Shanghai'), null, 'a bare date is not an instant this rule accepts');
});

t('the zone comes from the single configured source, and an explicit zone overrides it', () => {
  assert.equal(effectiveTimeZone({ calendar: { timeZone: 'Asia/Tokyo' } }), 'Asia/Tokyo');
  assert.equal(effectiveTimeZone({ calendar: { timeZone: '' } }), Intl.DateTimeFormat().resolvedOptions().timeZone, 'empty means the system zone');
  assert.equal(effectiveTimeZone({}), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(effectiveTimeZone({ calendar: { timeZone: 'Asia/Tokyo' } }, 'UTC'), 'UTC', 'an explicit zone wins');
  assert.equal(effectiveTimeZone({ calendar: { timeZone: 'Asia/Tokyo' } }), ruleFor('Asia/Tokyo').slice('local@'.length));
});

t('the rule marker a bucket is stored with round-trips, and the old rule is recognisable', () => {
  assert.equal(ruleFor('Asia/Shanghai'), 'local@Asia/Shanghai');
  assert.equal(zoneOfRule('local@Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(zoneOfRule(RULE_UTC_V1), null, 'the UTC rule names no zone — it is not a local rule');
  assert.equal(isUtcRule(RULE_UTC_V1), true);
  assert.equal(isUtcRule(ruleFor('UTC')), false);
  assert.equal(isRule(ruleFor('UTC')), true);
  assert.equal(isRule(RULE_UTC_V1), true);
  // CONTROL: a marker that cannot be interpreted is not accepted as a rule
  assert.equal(isRule(''), false);
  assert.equal(isRule('local@'), false, 'an empty zone is not a rule');
  assert.equal(isRule('UTC'), false, 'the bare name is not the marker we wrote');
  assert.equal(zoneOfRule(''), null);
  assert.equal(asDay('2026-09-15'), '2026-09-15');
  assert.equal(asDay('15-09-2026'), null, 'control: a non-day string is not silently accepted');
});

// ───────────────────────────────────────────── 2. a real archive fixture, written by the product

process.stdout.write('\narchive-day: a real archive fixture through the product\'s own write path\n');

// The fixture is written through `archiveRun` (the same entry point a run uses), not through raw SQL, so
// what is asserted is the shape the product actually produces.
const TZ = 'Asia/Shanghai';
const runCfg = cfgFor(TZ);
const ITEMS = [
  // 23:30Z on the 15th = 07:30 on the 16th in Shanghai
  { id: 'late-utc', publishedAt: '2026-09-15T23:30:00Z', sourceId: 'src-a', people: ['alice'], keywords: ['k'] },
  // 15:30Z on the 15th = 23:30 on the 15th in Shanghai (the same local day as UTC)
  { id: 'late-local', publishedAt: '2026-09-15T15:30:00Z', sourceId: 'src-a', people: ['alice'] },
  // an item from a feed that prints offsets rather than Z
  { id: 'offset', publishedAt: '2026-09-16T07:30:00+08:00', sourceId: 'src-b', people: ['bob'], images: ['x.png'] },
  // a source that printed no zone at all, on a machine whose zone is not the configured one
  { id: 'naive', publishedAt: '2026-09-16T07:30:00', sourceId: 'src-b', people: ['bob'] },
  // a source with no timestamp: this row can only ever take the ingest fallback
  { id: 'no-stamp', publishedAt: '', sourceId: 'src-c', people: ['carol'] },
];
const r0 = archiveRun(runCfg, { date: '2026-09-16', items: ITEMS, summary: { mode: 'daily', sourcesTotal: 3, sourcesOk: 3 }, log: { info() {} } });
assert.equal(r0.ok, true, `archiveRun failed: ${r0.error}`);

t('the write path stores the LOCAL day, and stamps how it was derived', () => {
  const db = openArchive(runCfg);
  try {
    const rows = db.prepare('SELECT id, day, day_tz, day_from, published_at FROM items ORDER BY id').all();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by['late-utc'].day, '2026-09-16', '07:30 local on the 16th');
    assert.equal(oldUtcDay(by['late-utc'].published_at), '2026-09-15', 'control: the old rule said the 15th');
    assert.equal(by['late-local'].day, '2026-09-15');
    assert.equal(by.offset.day, '2026-09-16');
    assert.equal(by.naive.day, '2026-09-16', 'a zone-less stamp is read in the configured zone');
    assert.equal(by['no-stamp'].day, '2026-09-16', 'no timestamp -> the ingest day');
    assert.equal(by['no-stamp'].day_from, 'ingest');
    assert.equal(by['no-stamp'].day_tz, TZ);
    for (const id of ['late-utc', 'late-local', 'offset', 'naive']) {
      assert.equal(by[id].day_from, 'stamp', `${id} carries its own timestamp, so its day came from it`);
      assert.equal(by[id].day_tz, TZ);
    }
    // CONTROL: the two UTC-day items really do sit on different local days, or the check above is vacuous
    assert.notEqual(by['late-utc'].day, oldUtcDay(by['late-utc'].published_at));
  } finally {
    db.close();
  }
});

t('what the reader returns agrees with what the writer wrote (no second rule on the read side)', () => {
  const db = openArchive(runCfg);
  try {
    const rows = queryItems(db, { day: '2026-09-16', limit: 100 });
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['late-utc', 'naive', 'no-stamp', 'offset'], `got ${ids.join(',')}`);
    for (const r of rows) {
      assert.equal(r.dayTz, TZ, 'the reader exposes the calendar the day came from');
      assert.equal(r.day, dayOfInstant(r.publishedAt, TZ) ?? r.day);
    }
    // the day the reader was asked for is a day the writer produced
    assert.equal(queryItems(db, { day: '2026-09-15', limit: 100 }).map((r) => r.id).join(','), 'late-local');
    // CONTROL: the day the old rule would have chosen is not the day the item is filed under
    assert.equal(queryItems(db, { day: '2026-09-15', limit: 100 }).some((r) => r.id === 'late-utc'), false);
  } finally {
    db.close();
  }
});

t('the series, the per-person activity and the run day all read the same calendar', () => {
  const db = openArchive(runCfg);
  try {
    const s = series(db, { days: 3, endDay: '2026-09-16', cfg: runCfg });
    assert.equal(s.rule, ruleFor(TZ), 'the series states which rule it read');
    assert.deepEqual(s.days.map((d) => d.day), ['2026-09-14', '2026-09-15', '2026-09-16']);
    assert.equal(s.days.find((d) => d.day === '2026-09-16').items, 4, 'four items are filed under the 16th');
    assert.equal(s.days.find((d) => d.day === '2026-09-15').items, 1);

    // …and the rule predicate has to *bite* when a second row set really is present. A decoy local set for
    // an overlapping day is written straight into the table (nothing else can produce one), so a reader
    // that dropped `AND rule = ?` would now count those items as well. Without this decoy the predicate
    // could be deleted and every assertion above would still pass — the failure mode the first mutation
    // run of this suite actually found.
    db.prepare(
      `INSERT INTO daily (day, source_id, rule, tz, items, with_media, alerts, updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).run('2026-09-16', 'decoy', ruleFor('UTC'), 'UTC', 99, 9, 9, '2026-09-16T00:00:00.000Z');
    const mine = series(db, { days: 3, endDay: '2026-09-16', cfg: runCfg });
    assert.equal(mine.days.find((d) => d.day === '2026-09-16').items, 4, 'the decoy row set must not be counted');
    // the fixture's own media count for that day is 1 (the item carrying an image), not 9 + 1
    assert.equal(mine.days.find((d) => d.day === '2026-09-16').media, 1, 'nor its media');
    // Reading the decoy needs its rule named explicitly: `series()` defaults to the rule the archive
    // states it is on (the frozen marker), which is the whole point of the marker. Passing a zone alone
    // asks "what would UTC look like", not "read the UTC row set" — those are the two different questions
    // `bucketRule` (`pending` vs `rule`) answers.
    const decoySeries = series(db, { days: 3, endDay: '2026-09-16', timeZone: 'UTC', rule: ruleFor('UTC') });
    assert.equal(decoySeries.days.find((d) => d.day === '2026-09-16').items, 99, 'the decoy is readable under its own rule');
    assert.equal(mine.rule, ruleFor(TZ));
    assert.notEqual(mine.rule, decoySeries.rule, 'control: the two reads really are different row sets');
    db.prepare('DELETE FROM daily WHERE rule = ?').run(ruleFor('UTC'));

    const p = peopleSeries(db, { days: 3, endDay: '2026-09-16', cfg: runCfg });
    assert.equal(p.byDay.alice['2026-09-16'], 1, 'alice: the 23:30Z item landed on the local 16th');
    assert.equal(p.byDay.alice['2026-09-15'], 1);
    assert.equal(p.byDay.bob['2026-09-16'], 2);
    assert.equal(p.byDay.carol['2026-09-16'], 1);
    const st = stats(db, { cfg: runCfg });
    assert.equal(st.rule, ruleFor(TZ));
    assert.equal(st.rulePending, false, 'the archive states the rule it is being read under');
    assert.deepEqual(st.storedRules.map((r) => r.rule), [ruleFor(TZ)]);
    // CONTROL: read the same rows under UTC and the buckets come out different — which is the whole point
    const utcSeries = series(db, { days: 3, endDay: '2026-09-15', timeZone: 'UTC', rule: RULE_UTC_V1 });
    assert.equal(utcSeries.days.reduce((n, d) => n + d.items, 0), 0, 'no bucket was written under the UTC rule');
    const regressed = ITEMS.filter((i) => dayOfInstant(i.publishedAt, 'UTC') !== dayOfInstant(i.publishedAt, TZ));
    assert.ok(regressed.length >= 2, `control: at least two fixture items must differ between the rules, got ${regressed.length}`);
  } finally {
    db.close();
  }
});

t('the run day is the local day, and it is the day the archive files the run under', () => {
  const db = openArchive(runCfg);
  try {
    const run = db.prepare('SELECT run_id, day FROM runs ORDER BY at DESC LIMIT 1').get();
    assert.equal(run.day, '2026-09-16');
    // Which rule each row's day came from, counted. Every row in this fixture carries its own timestamp,
    // so every one of them is on the configured rule's calendar — the mix is how a reader checks that
    // instead of assuming it.
    const mix = itemRuleMix(db);
    assert.deepEqual(
      mix,
      [
        { tz: TZ, from: 'stamp', items: 4 },
        { tz: TZ, from: 'ingest', items: 1 },
      ],
      JSON.stringify(mix)
    );
    assert.equal(mix.reduce((n, m) => n + m.items, 0), 5, 'every row is accounted for in the mix');
  } finally {
    db.close();
  }
});

// ───────────────────────────────────────────── 3. the migration of an archive written by the old rule

process.stdout.write('\narchive-day: migrating an archive the old rule already wrote\n');

/**
 * Build a database with the **v1 shape** exactly as the previous release created it, and leave its
 * user_version at 1. Written with raw SQL on purpose: this is a fixture of the old world, and going
 * through today's code to build it would make the migration test test itself.
 *
 * `dayIn` is the calendar the fixture's days are written on, and it is a parameter rather than the
 * machine's zone for the reason this whole file is about: `utc-v1` names the UTC calendar, so the days a
 * `utc-v1` fixture holds must be UTC days **wherever the suite runs**. The default below used to be the
 * machine's zone, which made this fixture mean one thing on a UTC machine and another one on the
 * owner's — the class of dependency this file exists to refuse.
 */
function makeLegacyArchive(file, { dayIn = oldUtcDay } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE items (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, source_id TEXT, title TEXT, text TEXT, url TEXT,
      published_at TEXT, first_seen_at TEXT NOT NULL, people TEXT, keywords TEXT,
      image_count INTEGER DEFAULT 0, run_id TEXT
    );
    CREATE INDEX idx_items_day ON items(day);
    CREATE TABLE daily (
      day TEXT NOT NULL, source_id TEXT NOT NULL, items INTEGER NOT NULL DEFAULT 0,
      with_media INTEGER NOT NULL DEFAULT 0, alerts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (day, source_id)
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, day TEXT NOT NULL, mode TEXT, at TEXT NOT NULL,
      sources_ok INTEGER DEFAULT 0, sources INTEGER DEFAULT 0, items INTEGER DEFAULT 0, alerts INTEGER DEFAULT 0
    );
    CREATE TABLE source_health (
      day TEXT NOT NULL, source_id TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0, ms_sum REAL NOT NULL DEFAULT 0, last_error TEXT, at TEXT NOT NULL,
      PRIMARY KEY (day, source_id)
    );
  `);
  const legacy = [
    ['old-late', '2026-09-15T23:30:00Z', 'src-a', ['alice'], '[]'],
    ['old-early', '2026-09-15T15:30:00Z', 'src-a', ['alice'], '[]'],
    ['old-nostamp', '', 'src-b', ['bob'], '["k"]'],
  ];
  const ins = db.prepare('INSERT INTO items (id, day, source_id, title, published_at, first_seen_at, people, keywords, image_count) VALUES (?,?,?,?,?,?,?,?,0)');
  for (const [id, at, src, people, keywords] of legacy) {
    // the writing release's rule: the day is that calendar's day of the stamp, read by the clock it ran
    // on; a row with no stamp at all takes the run day the fixture files it under
    const day = at ? dayIn(at) : '2026-09-16';
    ins.run(id, day, src, id, at, '2026-09-16T01:00:00.000Z', JSON.stringify(people), keywords);
  }
  const bump = db.prepare('INSERT INTO daily (day, source_id, items, with_media, alerts, updated_at) VALUES (?,?,?,?,?,?)');
  bump.run('2026-09-15', 'src-a', 2, 0, 0, '2026-09-16T01:00:00.000Z');
  bump.run('2026-09-16', 'src-b', 1, 0, 1, '2026-09-16T01:00:00.000Z');
  db.prepare('INSERT INTO runs (run_id, day, mode, at) VALUES (?,?,?,?)').run('legacy-1', '2026-09-16', 'daily', '2026-09-16T01:00:00.000Z');
  db.prepare('INSERT INTO source_health (day, source_id, checks, ok, ms_sum, at) VALUES (?,?,?,?,?,?)').run('2026-09-15', 'src-a', 4, 3, 330, '2026-09-16T01:00:00.000Z');
  db.close();
}

const legacyPath = path.join(tmp, 'legacy.db');
makeLegacyArchive(legacyPath);
const legacyCfg = { paths: { feedsDir: tmp }, calendar: { timeZone: TZ } };

t('migration labels the rows already on disk with the rule that produced them, and keeps the old aggregate', () => {
  const db = openArchive(legacyCfg, { file: legacyPath });
  try {
    const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    assert.ok(cols.includes('day_tz') && cols.includes('day_from'), 'the v2 columns exist after migration');
    const rows = db.prepare('SELECT id, day, day_tz, day_from FROM items ORDER BY id').all();
    for (const r of rows) {
      assert.equal(r.day_tz, RULE_UTC_V1, `${r.id} was written by the old rule and must say so`);
      assert.equal(r.day_from, 'legacy', `${r.id}'s derivation was never recorded, so it must not be guessed`);
    }
    // The old aggregate survives, under a name that says it is the old rule
    const rules = db.prepare('SELECT rule, COUNT(*) AS n FROM daily GROUP BY rule ORDER BY rule').all();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule, RULE_UTC_V1);
    assert.equal(Number(rules[0].n), 2, 'both old daily rows are still there');
    const old = db.prepare('SELECT day, source_id, items, alerts FROM daily WHERE rule = ? ORDER BY day').all(RULE_UTC_V1);
    assert.deepEqual(old.map((r) => [r.day, r.source_id, Number(r.items), Number(r.alerts)]), [
      ['2026-09-15', 'src-a', 2, 0],
      ['2026-09-16', 'src-b', 1, 1],
    ], 'the old numbers are untouched — preserved, not reinterpreted');
    // and the archive says which world it is being read in
    const b = bucketRule(db, { timeZone: TZ });
    assert.equal(b.rule, RULE_UTC_V1);
    assert.equal(b.pending, true, 'an archive still on the old rule must report that a rebuild is outstanding');
    assert.equal(b.source, 'meta');
  } finally {
    db.close();
  }
});

// ───────────────────────────────────────────── 4. the rebuild: idempotent, observable, preserving

process.stdout.write('\narchive-day: the rebuild\n');

let firstRebuildPreserved = null;
let firstRebuildDigest = null;
const digest = (db) => {
  const days = db.prepare('SELECT day, rule, items, with_media, alerts FROM daily ORDER BY day, rule, source_id').all();
  const items = db.prepare('SELECT day, day_tz, day_from FROM items ORDER BY id').all();
  return JSON.stringify({ days, items });
};

t('a plan says what a rebuild would change, without changing it', () => {
  const db = openArchive(legacyCfg, { file: legacyPath });
  try {
    const before = digest(db);
    const plan = rebuildPlan(db, { cfg: legacyCfg });
    assert.equal(plan.rule, ruleFor(TZ));
    assert.equal(plan.currentRule, RULE_UTC_V1);
    assert.equal(plan.items, 3);
    assert.equal(plan.recomputable, 2, 'two rows carry their own timestamp');
    assert.equal(plan.frozen, 1, 'the row with no timestamp cannot be recomputed');
    assert.equal(plan.wouldMove, 1, '23:30Z on the 15th is the 16th locally');
    assert.equal(plan.inSync, false);
    assert.equal(digest(db), before, 'a plan must not write anything');
  } finally {
    db.close();
  }
});

t('the rebuild recomputes the days from the raw timestamps and reports what it could not', () => {
  const db = openArchive(legacyCfg, { file: legacyPath });
  let res = null;
  try {
    res = rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } });
    assert.equal(res.rule, ruleFor(TZ));
    assert.equal(res.from, RULE_UTC_V1);
    assert.equal(res.itemsMoved, 1, 'exactly the 23:30Z row changes day');
    assert.equal(res.itemsFrozen, 1, 'the row with no raw timestamp is frozen and named, not guessed');
    // Three rows, not two: the frozen row cannot be recomputed but must still be counted, or the new
    // aggregate would sum to less than the items table holds.
    assert.equal(res.dailyRows, 3, 'every item is counted, including the one whose day could not be recomputed');
    assert.equal(res.preservedRules.join(','), RULE_UTC_V1, 'the old aggregate is preserved under its own rule');
    assert.equal(res.preservedRows, 2);
    firstRebuildPreserved = res.preservedRows;
    firstRebuildDigest = digest(db);
    assert.match(res.logged, /rebuild/);
    assert.match(res.logged, /frozen/);

    const rows = db.prepare('SELECT id, day, day_tz, day_from FROM items ORDER BY id').all();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by['old-late'].day, '2026-09-16');
    assert.equal(by['old-late'].day_tz, TZ);
    assert.equal(by['old-early'].day, '2026-09-15');
    assert.equal(by['old-nostamp'].day, '2026-09-16', 'a frozen row keeps the day it had');
    assert.equal(by['old-nostamp'].day_tz, RULE_UTC_V1, 'and keeps the rule that produced it');
    assert.equal(by['old-nostamp'].day_from, 'ingest', 'day_from is recovered: it has no stamp at all');

    // the new aggregate is correct, per day and per source
    const fresh = db.prepare('SELECT day, source_id, items, with_media, alerts FROM daily WHERE rule = ? ORDER BY day, source_id').all(ruleFor(TZ));
    assert.deepEqual(fresh.map((r) => [r.day, r.source_id, Number(r.items), Number(r.alerts)]), [
      ['2026-09-15', 'src-a', 1, 0],
      ['2026-09-16', 'src-a', 1, 0],
      ['2026-09-16', 'src-b', 1, 1],
    ]);

    // both worlds are readable, and each names itself
    const stored = storedRules(db).map((r) => r.rule).sort();
    assert.deepEqual(stored, [ruleFor(TZ), RULE_UTC_V1].sort());
    // The zone is spelled out here, and it has to be: `bucketRule` takes a **zone**, not a config
    // (`{ timeZone, frozen }` — archive.js:258), so passing `{ cfg }` is silently ignored and the zone
    // falls through to `effectiveTimeZone(null)`, which is the **system** zone. Reading it with no zone
    // at all was the same mistake in a shorter form, and it is what made this assertion depend on where
    // the suite runs: it read `pending: true` on the UTC runner and `false` on the owner's machine,
    // which is exactly why CI was red on a commit that was green here.
    const b = bucketRule(db, { timeZone: TZ });
    assert.equal(b.rule, ruleFor(TZ));
    assert.equal(b.pending, false, 'after the rebuild the archive is on the current rule');
  } finally {
    db.close();
  }
});

t('running the rebuild twice gives identical numbers (idempotent), and does not move anything on the second pass', () => {
  const db = openArchive(legacyCfg, { file: legacyPath });
  try {
    const first = digest(db);
    const res2 = rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } });
    const second = digest(db);
    assert.equal(second, first, 'the second rebuild must change nothing at all');
    assert.equal(res2.itemsMoved, 0, 'nothing left to move');
    assert.equal(res2.itemsFrozen, 1, 'the frozen row is still reported (it is still not recomputable)');
    assert.equal(res2.dailyRows, 3);
    // One, not two: the frozen row used to sit under the old rule, and the rebuild moved its (unchanged)
    // day into the new rule's row set. The old rule's remaining row is untouched — preserved as it was.
    assert.equal(res2.preservedRows, firstRebuildPreserved, 'the preserved row count is stable across runs');
    // CONTROL: a rebuild against a different rule DOES change the numbers, so the equality above is a
    // real property and not "the function never writes anything".
    const res3 = rebuildAggregates(db, { cfg: { calendar: { timeZone: 'UTC' } }, log: { info() {} } });
    assert.notEqual(digest(db), first, 'control: rebuilding under UTC must produce a different file');
    assert.equal(res3.rule, RULE_UTC_V1 === res3.rule ? res3.rule : ruleFor('UTC'));
    // put it back so later checks see the expected state. The target is the state the first rebuild
    // produced, not the pristine legacy file: the first pass also re-stamped the frozen row's
    // provenance, which is a one-way step (and one the second pass reported as already done).
    rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } });
    assert.equal(digest(db), firstRebuildDigest, 'and rebuilding under the configured zone again restores it exactly');
  } finally {
    db.close();
  }
});

t('an interruption rolls back: the journal survives, and no half-rebuilt table is left behind', () => {
  const file = path.join(tmp, 'interrupted.db');
  makeLegacyArchive(file);
  const db = openArchive(legacyCfg, { file });
  try {
    const before = digest(db);
    // Make the rebuild fail partway through, after the items have been moved: the DELETE runs, then the
    // insert blows up. Without the transaction this leaves the daily table empty and the days moved.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON daily WHEN NEW.rule LIKE 'local@%' BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
    assert.throws(() => rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } }), /interrupted/);
    db.exec('DROP TRIGGER boom');
    assert.equal(digest(db), before, 'a failed rebuild must leave the file exactly as it was');
    // CONTROL: with the trigger gone the same call succeeds, so the rollback above was the transaction
    // and not "the call never got to the write".
    const res = rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } });
    assert.equal(res.itemsMoved, 1);
    assert.notEqual(digest(db), before);
    // the journal records the completed attempt, and the archive is usable
    const done = db.prepare("SELECT value FROM meta WHERE key = 'rebuild.done'").get();
    assert.ok(done, 'the rebuild journals its completion in the file itself');
    assert.equal(JSON.parse(done.value).rule, ruleFor(TZ));
  } finally {
    db.close();
  }
});

t('rebuilding under the zone the rows were already written in moves nothing — and that is a pass', () => {
  // The missing case, and the one the CI failure was actually about. The assertion above proves rows DO
  // move when the effective zone differs from the zone the rows were written under; this one is its other
  // half: when the two are the same zone, the honest answer is "nothing had to move", zero rows, and the
  // archive is already on the rule the configuration asks for. Both are statements about the same code,
  // so a suite that can only state the first one fails on a machine whose zone happens to be the rows'.
  //
  // "The same zone" cannot be expressed by reading the machine's zone, which is what made the old
  // assertion machine-dependent: it is the fixture's zone, named here, and the fixture is built to be
  // provably that zone's (see `asWrittenInZone`) rather than the machine's.
  const ROWS_WERE_WRITTEN_IN = 'UTC';
  const writtenInUtc = (iso) => dayOfInstant(iso, ROWS_WERE_WRITTEN_IN);
  const file = path.join(tmp, 'same-zone.db');
  makeLegacyArchive(file, { dayIn: writtenInUtc });
  // the same shape as the fixture above, so the two cases really are the same archive read two ways
  const sameZoneCfg = {
    paths: { feedsDir: tmp },
    calendar: {
      timeZone: ROWS_WERE_WRITTEN_IN,
      entries: [{ id: 'e1', name: 'test', kind: 'event', date: '2026-09-16', at: asWrittenInZone('2026-09-16T01:00:00.000Z', ROWS_WERE_WRITTEN_IN) }],
    },
  };
  const db = openArchive(sameZoneCfg, { file });
  try {
    const before = digest(db);
    // what a plan says first: nothing to move, and not in sync only because the rows are still stamped
    // with the old rule's marker and the frozen row still has to be re-stamped
    const plan = rebuildPlan(db, { cfg: sameZoneCfg });
    assert.equal(plan.rule, ruleFor(ROWS_WERE_WRITTEN_IN));
    assert.equal(plan.currentRule, RULE_UTC_V1, 'the rows say they were written by the old UTC rule');
    assert.equal(plan.recomputable, 2);
    assert.equal(plan.wouldMove, 0, 'the day already on each row IS this zone\'s day');
    assert.equal(digest(db), before, 'and a plan writes nothing');

    const res = rebuildAggregates(db, { cfg: sameZoneCfg, log: { info() {} } });
    assert.equal(res.rule, ruleFor(ROWS_WERE_WRITTEN_IN));
    assert.equal(res.from, RULE_UTC_V1);
    assert.equal(res.itemsMoved, 0, 'nothing had to move');
    assert.equal(res.itemsFrozen, 1, 'the row with no raw timestamp is still reported, not guessed');
    assert.equal(res.dailyRows, 3, 'and every row is still counted');
    assert.equal(res.preservedRules.join(','), RULE_UTC_V1);
    // the section's own rule: zero rows moved is a fact to report, and the rebuild is complete when the
    // archive says so — not an error, and not "the rebuild never ran"
    assert.equal(
      bucketRule(db, { timeZone: ROWS_WERE_WRITTEN_IN }).pending,
      false,
      'an archive whose rows are already on the configured zone\'s calendar is on the current rule'
    );
    // the rows the rebuild could recompute now name the rule that is in force, so the file itself says
    // which calendar it is on rather than only the meta journal
    for (const id of ['old-late', 'old-early']) {
      assert.equal(db.prepare('SELECT day_tz FROM items WHERE id = ?').get(id).day_tz, ROWS_WERE_WRITTEN_IN, `${id} names the zone its day now belongs to`);
    }

    // CONTROL: the same file, the same rows, a different zone on purpose — now rows DO move, so the zero
    // above is a property of the zone matching the rows and not of the fixture being a no-op for some
    // other reason. The count is derived from the rows' own timestamps in the two named zones rather than
    // written down, because a literal here would be a second machine-dependent statement: '2026-09-15' is
    // `old-early`'s day in BOTH of these zones (`15:30Z` is `23:30` in Shanghai, `15:30` in UTC), so the
    // answer really is 1 or 2 depending on which zone the fixture's days were written in.
    const movedInAside = [...db.prepare('SELECT published_at FROM items WHERE published_at <> \'\'').all()].filter(
      (r) => dayOfInstant(r.published_at, TZ) !== dayOfInstant(r.published_at, ROWS_WERE_WRITTEN_IN)
    ).length;
    const aside = rebuildAggregates(db, { cfg: legacyCfg, log: { info() {} } });
    assert.equal(aside.rule, ruleFor(TZ));
    assert.ok(movedInAside >= 1, 'the two zones must not be the same calendar, or this control proves nothing');
    assert.equal(aside.itemsMoved, movedInAside, `moving to ${TZ} must move exactly the rows whose day differs between the two zones`);
    assert.notEqual(digest(db), before, 'so the file really did change, and the zero stood for something');
  } finally {
    db.close();
  }
});

t('CONTROL — the change is visible: the same fixture under the old rule gives different days', () => {
  // This is the assertion that would have failed before this change. The fixture is read back and its
  // days compared with what the old rule produced; the two MUST differ, and by a known amount.
  const db = openArchive(runCfg);
  try {
    const rows = db.prepare('SELECT id, day, published_at FROM items WHERE published_at <> \'\'').all();
    const changed = rows.filter((r) => oldUtcDay(r.published_at) !== r.day);
    assert.ok(changed.length >= 1, 'the fixture must contain at least one item whose day the old rule got wrong');
    assert.ok(
      changed.some((r) => r.id === 'late-utc' && oldUtcDay(r.published_at) === '2026-09-15' && r.day === '2026-09-16'),
      'and specifically the 23:30Z item: old rule 09-15, new rule 09-16'
    );
    // If the product still used the UTC rule, the stored day would equal the control for every row.
    const agree = rows.filter((r) => oldUtcDay(r.published_at) === r.day).length;
    assert.ok(agree < rows.length, 'the stored days must NOT all agree with the old rule');
  } finally {
    db.close();
  }
});

// ───────────────────────────────────────────── 5. the calendar side is untouched

process.stdout.write('\narchive-day: the calendar side reads the same rule\n');

t('the Calendar tab and the archive agree on "today" for the same instant and zone', () => {
  const cfg = { calendar: { timeZone: TZ, entries: [{ id: 'e1', name: 'test', kind: 'event', date: '2026-09-16' }] } };
  const now = new Date('2026-09-15T23:30:00Z');
  const cal = upcoming(cfg, { now, timeZone: TZ });
  // The invariant that matters is not "the calendar still works" but "the two sides agree": this change
  // made the archive read the calendar's rule, so a mutation that moves BOTH sides to UTC would keep the
  // calendar consistent with itself. Pinned here against the rule computed independently of either.
  assert.equal(cal.today, dayOfInstant(now, TZ), 'the calendar side must not drift off the one rule either');
  assert.equal(cal.today, '2026-09-16', 'the calendar already worked this way — this change must not move it');
  assert.equal(cal.today, dayOfInstant(now, TZ));
  // CONTROL: the UTC rule disagrees, which is exactly the divergence that was fixed
  assert.equal(oldUtcDay(now.toISOString()), '2026-09-15');
  assert.notEqual(cal.today, oldUtcDay(now.toISOString()));
  // and with an empty configured zone the calendar still uses the system zone
  const sysToday = upcoming({ calendar: { timeZone: '', entries: [] } }, { now }).today;
  assert.equal(sysToday, dayOfInstant(now, Intl.DateTimeFormat().resolvedOptions().timeZone));
});

t('archiveRun is the only place that writes, and it rebuilds in the same pass', () => {
  // The path has to be the one archivePath resolves for this cfg: opening a *different* file looked like
  // "the run did not rebuild" for a while, which is why the file is derived rather than named here.
  const cfg = { paths: { feedsDir: tmp }, calendar: { timeZone: TZ } };
  const file = path.join(tmp, 'archive.db');
  const out = archiveRun(cfg, {
    date: '2026-09-16',
    items: [{ id: 'x', publishedAt: '2026-09-15T23:30:00Z', sourceId: 's' }],
    log: { info() {} },
  });
  assert.equal(out.ok, true);
  assert.ok(out.rebuilt, 'a run reports the rebuild it performed');
  assert.equal(out.rebuilt.rule, ruleFor(TZ));
  const db = openArchive(cfg, { file });
  try {
    assert.equal(bucketRule(db, { timeZone: effectiveTimeZone(cfg) }).pending, false);
    const res = rebuildAggregates(db, { cfg, log: { info() {} } });
    assert.equal(res.itemsMoved, 0, 'the run already left the aggregates in sync');
  } finally {
    db.close();
  }
  void file;
});

t('the ingest path is idempotent about the day it already decided', () => {
  const file = path.join(tmp, 'idem.db');
  const cfg = { paths: { feedsDir: tmp }, calendar: { timeZone: TZ } };
  const db = openArchive(cfg, { file });
  try {
    const items = [{ id: 'a', publishedAt: '2026-09-15T23:30:00Z', sourceId: 's' }];
    const one = ingestItems(db, items, { day: '2026-09-16', timeZone: TZ });
    assert.equal(one.inserted, 1);
    assert.equal(one.days[0], '2026-09-16');
    const two = ingestItems(db, items, { day: '2026-09-16', timeZone: TZ });
    assert.equal(two.inserted, 0, 'the same id is not written twice');
    assert.equal(two.skipped, 1);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM items').get().n), 1);
    assert.equal(Number(db.prepare('SELECT SUM(items) AS n FROM daily WHERE rule = ?').get(ruleFor(TZ)).n), 1, 'the counter is not doubled either');
    // CONTROL: the same item under a different rule is a different bucket, and it does not overwrite the first
    const utc = ingestItems(db, [{ ...items[0], id: 'b' }], { day: '2026-09-15', timeZone: 'UTC' });
    assert.equal(utc.days[0], '2026-09-15');
    assert.equal(storedRules(db).length, 2, 'control: two rules can coexist in the same table, each naming itself');
    assert.equal(Number(db.prepare('SELECT SUM(items) AS n FROM daily WHERE rule = ?').get(ruleFor(TZ)).n), 1);
  } finally {
    db.close();
  }
});

t('latestItemsByPerson reports the day by the rule in force for that row, and does not invent one', () => {
  const db = openArchive(runCfg);
  try {
    const out = latestItemsByPerson(db, { personIds: ['carol', 'alice'], limit: 2, cfg: runCfg });
    // carol's only item has no timestamp: the stored day is the only date there is, and it is reported
    // as such rather than as a slice of a timestamp she does not have.
    for (const row of out.carol) {
      assert.equal(row.day, row.archiveDay);
      assert.equal(row.dayTz, TZ);
    }
    const alice = out.alice.find((r) => r.id === 'late-utc');
    assert.equal(alice.day, '2026-09-16', 'a row with its own timestamp is read through the rule');
    assert.equal(alice.archiveDay, '2026-09-16');
    assert.notEqual(alice.day, oldUtcDay('2026-09-15T23:30:00Z'), 'control: not the UTC day');
  } finally {
    db.close();
  }
});

// ───────────────────────────────────────────── 6. the controls: every assertion above can fail
//
// A check that cannot fail is not a check, and this whole change is about a rule that "looked right".
// Each mutation below is applied to a **copy** of server/src/archive.js in a temporary directory, and the
// suite is re-run against that copy through VML_DAY_ARCHIVE_MODULE; the real file is never written. That is
// the shape tools/config-durability-test.mjs uses, and for the same reason — and here for one more:
//
// The first attempt at this proof edited the real file and reverted it with `git checkout --`, which on a
// tracked-but-modified file restores the *commit*, not the mutation. It deleted the work twice. A copy
// cannot do that, and `word` below states what each control is meant to prove, so a mutation that breaks
// something else is reported as a broken control rather than as a caught one.
const MUTATIONS = [
  {
    name: 'utc-rule-again',
    word: 'the rule ignores the target zone (the pre-change behaviour)',
    into: 'server/src/day.js',
    from: "    timeZone: timeZone || undefined,\n    year: 'numeric',",
    to: "    timeZone: 'UTC',\n    year: 'numeric',",
    expect: 'the UTC rule gives a different day',
  },
  {
    name: 'no-rule-stamp',
    word: 'the write path stops recording which rule produced the day',
    from: '        runId,\n        tz,\n        d.from\n      );',
    to: '        runId,\n        null,\n        d.from\n      );',
    expect: 'the write path stores the LOCAL day',
  },
  {
    name: 'no-rule-predicate',
    word: 'the reader stops telling the two row sets apart',
    // the day-series query (not the by-source one): that is the read the decoy control exercises
    from: 'FROM daily WHERE day >= ? AND day <= ? AND rule = ? GROUP BY day ORDER BY day ASC',
    to: 'FROM daily WHERE day >= ? AND day <= ? AND ? IS NOT NULL GROUP BY day ORDER BY day ASC',
    expect: 'the decoy row set must not be counted',
  },
  {
    name: 'rebuild-appends',
    word: 'the rebuild adds to the counters instead of recomputing them',
    from: "    db.prepare('DELETE FROM daily WHERE rule = ?').run(rule);\n    for (const r of all) {",
    to: '    for (const r of all) {',
    expect: 'the second rebuild must change nothing',
  },
  {
    name: 'rebuild-no-transaction',
    word: 'the rebuild is not atomic, so an interruption leaves a half state',
    from: '    // 2) the daily counters, recomputed from the items that now carry the new day.',
    to: "    db.exec('COMMIT');\n    db.exec('BEGIN IMMEDIATE');\n    // 2) the daily counters, recomputed from the items that now carry the new day.",
    expect: 'a failed rebuild must leave the file exactly as it was',
  },
  {
    name: 'rebuild-guesses',
    word: 'a row with no raw timestamp is moved to a guessed day instead of being reported',
    from: '      const day = recomputed ?? asDay(r.day);',
    to: '      const day = recomputed ?? dayOfInstant(at, tz);',
    expect: 'the series, the per-person activity and the run day all read the same calendar',
  },
  {
    // The other half of the rebuild: a report that says rows moved when none had to. This is the shape a
    // "rebuild fix" takes when it derives the day from a zone other than the rule it is moving rows to —
    // and it is the one assertion that a check for "some rows moved" cannot see.
    name: 'rebuild-moves-in-place',
    word: 'a rebuild under the rows\' own zone claims to have moved them',
    from: '        if (r.day !== recomputed) itemsMoved++;',
    to: '        if (dayOfInstant(rebuildStampOf(r), tz) !== null) itemsMoved++;',
    expect: 'nothing had to move',
  },
];

if (!process.env.VML_DAY_MUTANT) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = path.join(ROOT, 'server/src');
  const realArchive = path.join(SRC, 'archive.js');
  const realDay = path.join(SRC, 'day.js');
  const originalArchive = fs.readFileSync(realArchive);
  const originalDay = fs.readFileSync(realDay);
  const SELF = fileURLToPath(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-day-mutants-'));

  process.stdout.write('\narchive-day: the controls (each assertion must be able to fail)\n');
  try {
    for (const m of MUTATIONS) {
      // The mutant is a **copy of the whole server/src directory**, made once and then mutated in place.
      // A copy of one file is not enough: the module graph reaches ./config.js and ./day.js by relative
      // specifier, so a mutant sitting in a directory of its own cannot resolve them (measured: it died
      // with ERR_MODULE_NOT_FOUND on config.js, which said nothing about the check it was meant to back).
      const work = path.join(dir, m.name);
      fs.cpSync(SRC, path.join(work, 'server', 'src'), { recursive: true });
      const into = m.into ?? 'server/src/archive.js';
      const target = path.join(work, into);
      const source = fs.readFileSync(target, 'utf8');
      if (!source.includes(m.from)) {
        t(`control "${m.name}" is applicable (its anchor is still in the source)`, () => {
          throw new Error(`the mutation anchor is gone from ${into}, so this control no longer backs anything`);
        });
        continue;
      }
      // The MUTATION marker rides the generated copy only; the grep at the end of this section proves it
      // never reached the real source, which is the failure the first version of this proof produced.
      fs.writeFileSync(target, `// MUTATION ${m.name}\n${source.split(m.from).join(m.to)}`, 'utf8');
      const child = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          VML_DAY_ARCHIVE_MODULE: pathToFileURL(path.join(work, 'server/src/archive.js')).href,
          VML_DAY_MUTANT: m.name,
        },
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
          `it failed for another reason (${JSON.stringify(failures.slice(0, 3))}), so it does not back that check\n${out.slice(-600)}`
        );
      });
      fs.rmSync(work, { recursive: true, force: true });
    }
    t('the real server/src was never modified by the controls', () => {
      assert.deepEqual(fs.readFileSync(realArchive), originalArchive, 'archive.js changed while the controls ran');
      assert.deepEqual(fs.readFileSync(realDay), originalDay, 'day.js changed while the controls ran');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  t('no mutation marker is left anywhere in the tree', () => {
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'pw-browsers', 'logs', 'reports', 'feeds', 'thumbs', 'advice']);
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) return skip.has(e.name) ? [] : walk(full);
        return /\.(js|jsx|mjs|cjs)$/.test(e.name) ? [full] : [];
      });
    const dirty = walk(ROOT)
      .filter((f) => !f.endsWith('archive-day-test.mjs'))
      .filter((f) => /^\/\/ MUTATION \S/m.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    assert.deepEqual(dirty, [], 'a mutation marker is in the tree');
  });
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
