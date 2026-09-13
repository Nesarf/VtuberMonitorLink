// silence-test.mjs — self-test for silence/absence detection
// The thing this capability fears most is "reporting noise": treating a normal gap as an anomaly is
// worse than not reporting at all. So it is pinned down with constructed timelines.
import assert from 'node:assert/strict';
import {
  SILENCE_DEFAULTS,
  agencyFromSourceUrl,
  baselineOf,
  detectSilence,
  membersOfAgency,
  silenceSummary,
  toleranceDays,
} from '../server/src/silence.js';

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

const NOW = new Date('2026-03-30T12:00:00Z');
/** Build a timeline "one item every gap days starting at startDay" */
function daily({ from = '2026-03-01', until = '2026-03-30', gap = 1, count = 1 } = {}) {
  const out = {};
  const start = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(until + 'T00:00:00Z');
  for (let ts = start; ts <= end; ts += gap * 86400000) {
    const key = new Date(ts).toISOString().slice(0, 10);
    out[key] = count;
  }
  return out;
}

process.stdout.write('\nsilence: baseline\n');

t('daily poster: gap 1 day, last active is today', () => {
  const b = baselineOf(daily(), { now: NOW });
  assert.equal(b.gapDays, 1);
  assert.equal(b.lastDay, '2026-03-30');
  assert.equal(b.quietDays, 0);
  assert.ok(b.activeDays >= 28, 'active days ' + b.activeDays);
});

t('monthly poster: a gap of about 30 days widens the tolerance to their own rhythm (the maxDays cap must not override it)', () => {
  const sparse = { '2026-01-05': 1, '2026-02-04': 1, '2026-03-06': 1 };
  const b = baselineOf(sparse, { now: NOW });
  assert.ok(b.gapDays >= 29 && b.gapDays <= 31, 'the gap should be about 30 days, actual ' + b.gapDays);
  const tol = toleranceDays(b, SILENCE_DEFAULTS);
  assert.equal(tol, 75, '30 days x 2.5 = 75 days (maxDays=90 is only a fallback and must not clamp a monthly poster down to 21 days); actual ' + tol);
});

t('a single day of records -> the rhythm cannot be estimated -> stay silent (better no report than a false alarm)', () => {
  const b = baselineOf({ '2026-03-29': 2 }, { now: NOW });
  assert.equal(b.gapDays, null);
  assert.equal(toleranceDays(b, SILENCE_DEFAULTS), null);
  assert.equal(b.lastDay, '2026-03-29');
});

t('no history -> no baseline, hence no tolerance range', () => {
  const b = baselineOf({}, { now: NOW });
  assert.equal(b.lastDay, null);
  assert.equal(toleranceDays(b, SILENCE_DEFAULTS), null);
});

t('the tolerance range is clamped by the floor: a daily poster is not reported for a 1-day gap', () => {
  const b = baselineOf(daily({ until: '2026-03-29' }), { now: NOW });
  const tol = toleranceDays(b, SILENCE_DEFAULTS);
  assert.equal(tol, SILENCE_DEFAULTS.minDays, 'should be clamped by minDays, actual ' + tol);
});

process.stdout.write('\nsilence: personal silence\n');

const people = [
  { id: 'p1', name: '甲', agency: 'Box-A' },
  { id: 'p2', name: '乙', agency: 'Box-A' },
  { id: 'p3', name: '丙', agency: 'Box-A' },
  { id: 'p4', name: '丁', agency: 'Box-A' },
  { id: 'solo', name: '戊', agency: null },
];

t('daily poster stopped for 4 days -> warn; stopped for 6 days (>= 2x tolerance) -> high; still posting -> no report', () => {
  const res = detectSilence({
    byDay: {
      p1: daily({ until: '2026-03-26' }), // quiet for 4 days
      p2: daily({ until: '2026-03-30' }), // normal
    },
    people,
    now: NOW,
  });
  assert.equal(res.person.length, 1, JSON.stringify(res.person));
  assert.equal(res.person[0].personId, 'p1');
  assert.equal(res.person[0].quietDays, 4);
  assert.equal(res.person[0].level, 'warn');
  assert.match(res.person[0].reason, /已 4 天没有新条目/);
  assert.equal(res.checked, 2);

  const worse = detectSilence({ byDay: { p1: daily({ until: '2026-03-24' }) }, people, now: NOW });
  assert.equal(worse.person[0].quietDays, 6);
  assert.equal(worse.person[0].level, 'high', 'silence >= 2x the tolerance range counts as high');
});

t('the longer the stop the higher the level (>= 2x the tolerance range counts as high)', () => {
  const res = detectSilence({ byDay: { p1: daily({ until: '2026-03-20' }) }, people, now: NOW });
  assert.equal(res.person[0].quietDays, 10);
  assert.equal(res.person[0].level, 'high');
});

t('someone with only one day of records is not reported, but is counted as "no baseline" (so you know it was not judged rather than found fine)', () => {
  const res = detectSilence({ byDay: { solo: { '2026-03-29': 1 } }, people, now: NOW });
  assert.equal(res.person.length, 0);
  assert.equal(res.checked, 0, 'if the rhythm cannot be estimated it must not count towards "checked"');
  assert.equal(res.skippedNoBaseline, 1);
  const none = detectSilence({ byDay: {}, people, now: NOW });
  assert.equal(none.skippedNoBaseline, 0);
  // summary() is a diagnostic/log line (nothing in the UI renders it), so it is English
  assert.match(silenceSummary(none), /no baseline available/);
});

t('a monthly poster quiet for 24 days must not be reported, 87 days must be (the threshold follows their own rhythm)', () => {
  const sparse = { '2026-01-05': 1, '2026-02-04': 1, '2026-03-06': 1 };
  const early = detectSilence({ byDay: { p1: sparse }, people, now: NOW });
  assert.equal(early.person.length, 0, 'quiet for 24 days (tolerance 75 days) must not be reported, actual ' + JSON.stringify(early.person));
  const late = detectSilence({ byDay: { p1: sparse }, people, now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(late.person.length, 1, 'quiet for 87 days is when it should be reported');
  assert.ok(late.person[0].quietDays > 75);
});

t('turning the switch off disables detection entirely', () => {
  const res = detectSilence({ byDay: { p1: daily({ until: '2026-03-01' }) }, people, now: NOW, rules: { enabled: false } });
  assert.deepEqual(res, { person: [], group: [], checked: 0, skippedNoBaseline: 0 });
});

process.stdout.write('\nsilence: agency-wide simultaneous quiet\n');

t('3 of 4 members of one agency quiet for >= 5 days at the same time -> an agency-level signal', () => {
  const res = detectSilence({
    byDay: {
      p1: daily({ until: '2026-03-24' }), // quiet for 6 days
      p2: daily({ until: '2026-03-23' }), // quiet for 7 days
      p3: daily({ until: '2026-03-25' }), // quiet for 5 days
      p4: daily(), // normal
    },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 1, JSON.stringify(res.group));
  assert.equal(res.group[0].agency, 'Box-A');
  assert.equal(res.group[0].memberCount, 4);
  assert.deepEqual(res.group[0].members.sort(), ['丙', '乙', '甲'].sort());
  assert.equal(res.group[0].quietDays, 5);
  assert.match(res.group[0].reason, /同时安静了/);
});

t('everyone quiet -> high; only one or two quiet -> not an agency-level signal', () => {
  const all = detectSilence({
    byDay: { p1: daily({ until: '2026-03-24' }), p2: daily({ until: '2026-03-24' }), p3: daily({ until: '2026-03-24' }) },
    people,
    now: NOW,
  });
  assert.equal(all.group[0].level, 'high');
  const few = detectSilence({
    byDay: { p1: daily({ until: '2026-03-24' }), p2: daily(), p3: daily(), p4: daily() },
    people,
    now: NOW,
  });
  assert.equal(few.group.length, 0, 'one person being quiet is normal and must not be reported as agency level');
});

t('an "agency" with too few members does not take part in agency-level judgement (2 people are not an agency)', () => {
  const res = detectSilence({
    byDay: { p1: daily({ until: '2026-03-20' }), p2: daily({ until: '2026-03-20' }) },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 0);
  assert.equal(res.person.length, 2, 'personal silence is still reported');
});

t('people with no agency filled in do not take part in agency-level judgement (but personal silence is still reported)', () => {
  const res = detectSilence({
    byDay: { solo: daily({ from: '2026-02-01', until: '2026-03-01' }) },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 0);
  assert.equal(res.person.length, 1);
  assert.equal(res.person[0].agency, null);
});

process.stdout.write('\nsilence: misc\n');

t('summary: the agency-level line comes first when present, otherwise the personal one', () => {
  const s = silenceSummary({ group: [{ agency: 'Box-A' }], person: [{ name: '甲' }], checked: 3 });
  assert.match(s, /agency-level quiet 1: Box-A/);
  assert.match(s, /personal silence 1: 甲/);
  assert.match(silenceSummary({ group: [], person: [], checked: 3 }), /all within the normal range/);
});

t('fetch members by agency; infer the agency domain from an official source URL', () => {
  assert.deepEqual(membersOfAgency(people, 'Box-A').map((p) => p.name), ['甲', '乙', '丙', '丁']);
  assert.equal(membersOfAgency(people, 'Box-B').length, 0);
  assert.equal(agencyFromSourceUrl('https://hololivepro.com/talents/'), 'hololivepro.com');
  assert.equal(agencyFromSourceUrl('https://vspo.jp/'), 'vspo.jp');
  assert.equal(agencyFromSourceUrl('https://api.bilibili.com/x'), null);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
