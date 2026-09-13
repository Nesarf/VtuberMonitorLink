// groups-test.mjs — self-test for box-level (agency) aggregation
// Aggregation is easy to break while still looking right: the day axis shifted by one slot, the same
// day counted twice, people without an agency quietly dropped — any of those turns the heatmap and the
// signals into fakes. Constructed timelines pin all of that down.
import assert from 'node:assert/strict';
import { agencyBlock, dayAxis, groupView } from '../server/src/groups.js';

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

const NOW = new Date('2026-03-30T23:00:00Z');
const span = (from, until, gap = 1) => {
  const out = {};
  for (let ts = Date.parse(from + 'T00:00:00Z'); ts <= Date.parse(until + 'T00:00:00Z'); ts += gap * 86400000) {
    out[new Date(ts).toISOString().slice(0, 10)] = 1;
  }
  return out;
};

const people = [
  { id: 'a1', name: '甲', agency: 'BOX' },
  { id: 'a2', name: '乙', agency: 'BOX' },
  { id: 'a3', name: '丙', agency: 'BOX' },
  { id: 'a4', name: '丁', agency: 'BOX' },
  { id: 'b1', name: '戊', agency: 'Other' },
  { id: 'u1', name: '己', agency: '' },
];

process.stdout.write('\ngroups: day axis\n');

t('day axis is ascending, includes today, and has the correct length', () => {
  const axis = dayAxis(5, '2026-03-30');
  assert.deepEqual(axis, ['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30']);
  assert.equal(dayAxis(1, '2026-03-30').length, 1);
});

process.stdout.write('\ngroups: a single agency\n');

const byDay = {
  a1: span('2026-03-01', '2026-03-30'), // posts daily
  a2: span('2026-03-01', '2026-03-26'), // stopped for 4 days
  a3: { '2026-03-02': 2, '2026-03-09': 1, '2026-03-16': 1, '2026-03-23': 1 }, // posts weekly
  a4: { '2026-03-15': 1 }, // only one day of records -> no baseline
  b1: span('2026-03-25', '2026-03-30'),
  u1: span('2026-03-28', '2026-03-30'),
};

t('each member daily count corresponds one-to-one with the day axis (one slot off and the whole heatmap is wrong)', () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(10, '2026-03-30'), now: NOW });
  const a1 = block.members.find((m) => m.id === 'a1');
  assert.equal(a1.counts.length, 10, 'counts length must equal the axis length');
  assert.deepEqual(a1.counts, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'a daily poster should be 1 on each of the last 10 days');
  const a2 = block.members.find((m) => m.id === 'a2');
  assert.deepEqual(a2.counts.slice(-4), [0, 0, 0, 0], 'the 4 quiet days should be 0');
  assert.equal(a2.quietDays, 4);
});

t("levels follow each person's own cadence: a daily poster quiet for 4 days is warn; someone with only one day of records is unknown", () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.equal(block.members.find((m) => m.id === 'a2').level, 'warn');
  assert.equal(block.members.find((m) => m.id === 'a1').level, 'ok');
  const a4 = block.members.find((m) => m.id === 'a4');
  assert.equal(a4.level, 'unknown', 'with no baseline no level should be assigned');
  assert.equal(a4.toleranceDays, null);
});

t('a weekly poster quiet for 7 days is not anomalous (their own cadence is 7 days)', () => {
  const block = agencyBlock({ agency: 'BOX', members: [people[2]], byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  const a3 = block.members[0];
  assert.ok(a3.gapDays >= 6.5 && a3.gapDays <= 7.5, 'the cadence should be about 7 days, actual ' + a3.gapDays);
  assert.equal(a3.level, 'ok', 'a weekly poster quiet for 7 days should not raise an alarm');
});

t('co-active days: only days with >= 2 active people count, and each one names who was active', () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.ok(block.coActiveDays > 0);
  for (const c of block.coActive) {
    assert.ok(c.count >= 2, JSON.stringify(c));
    assert.equal(c.members.length, c.count);
  }
  // a2's last post is 3-26 and nobody else is active after that, so the recent days hold only one
  // person and cannot form a co-active day
  const last = block.coActive[0];
  assert.ok(last.day <= '2026-03-26', 'the most recent co-active day should be no later than 3-26, actual ' + last.day);
});

t('whole agency quiet: the number of consecutive dead days at the tail of the axis (only a "signal" when there are enough members)', () => {
  const onlyOld = {
    a1: span('2026-03-01', '2026-03-20'),
    a2: span('2026-03-01', '2026-03-18'),
    a3: span('2026-03-01', '2026-03-19'),
  };
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 3), byDay: onlyOld, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.equal(block.quietStreak, 10, '3-21 through 3-30 is 10 days with nobody moving');
  assert.equal(block.groupSignal.kind, 'all-quiet');
  assert.equal(block.groupSignal.level, 'high');
  assert.match(block.groupSignal.reason, /整箱 3 人已经 10 天/);
});

t('most people quiet (but not everyone) -> a warn-level agency signal; only one or two quiet -> no agency signal', () => {
  const most = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 4),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-01', '2026-03-19'), a3: span('2026-03-01', '2026-03-21'), a4: span('2026-03-28', '2026-03-30') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(most.silent.length, 3);
  assert.ok(most.groupSignal, '3/4 people quiet at the same time should produce a signal');
  assert.equal(most.groupSignal.kind, 'most-quiet');
  assert.equal(most.groupSignal.level, 'warn');

  const few = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 4),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-28', '2026-03-30'), a3: span('2026-03-28', '2026-03-30'), a4: span('2026-03-28', '2026-03-30') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(few.groupSignal, null, 'one person being quiet is normal; no agency signal should appear');
});

t('too few members (<minMembers) -> no agency signal', () => {
  const block = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 2),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-01', '2026-03-19') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(block.groupSignal, null);
  assert.equal(block.silent.length, 2, 'per-person silence is still reported');
});

process.stdout.write('\ngroups: multiple agencies\n');

t('split into one block per agency, sorted by item count; people with no agency land in "ungrouped" instead of disappearing', () => {
  const view = groupView({ byDay, people, days: 30, now: NOW, endDay: '2026-03-30' });
  assert.deepEqual(view.groups.map((g) => g.agency), ['BOX', 'Other']);
  assert.ok(view.groups[0].totals.items >= view.groups[1].totals.items, 'sorted by item count descending');
  assert.ok(view.ungrouped, 'the ungrouped block must exist');
  assert.deepEqual(view.ungrouped.members.map((m) => m.name), ['己']);
  assert.equal(view.people, 6, 'the total must equal every watch target');
  const accounted = view.groups.reduce((a, g) => a + g.totals.members, 0) + view.ungrouped.totals.members;
  assert.equal(accounted, 6, 'everyone must be accounted for (nobody may be dropped)');
});

t('an empty config does not blow up: 0 watch targets -> an empty view', () => {
  const view = groupView({ byDay: {}, people: [], days: 7, now: NOW, endDay: '2026-03-30' });
  assert.deepEqual(view.groups, []);
  assert.equal(view.ungrouped, null);
  assert.equal(view.axis.length, 7);
});

t('the agency-level per-day total equals the sum of its members for that day', () => {
  const view = groupView({ byDay, people, days: 10, now: NOW, endDay: '2026-03-30' });
  const box = view.groups.find((g) => g.agency === 'BOX');
  for (let i = 0; i < box.perDay.length; i++) {
    assert.equal(box.perDay[i], box.members.reduce((a, m) => a + m.counts[i], 0), 'day ' + i + ' total mismatch');
  }
  assert.equal(box.activeLast7, box.members.filter((m) => m.counts.slice(-7).some((n) => n > 0)).length);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
