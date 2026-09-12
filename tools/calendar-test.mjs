// calendar-test.mjs - self-test for the countdown calendar
//
// This focuses on two classes of "quietly wrong" cases:
//   - leap day: how a 2/29 birthday resolves in a common year
//   - time zones/DST: counting days from a millisecond difference is off by one near a switch
// It also verifies that local keyword extraction (no network, no LLM) does not mistake
// unrelated dates for anniversaries.
import assert from 'node:assert/strict';
import {
  dayInTz,
  daysBetween,
  isLeapYear,
  monthGrid,
  marksFor,
  nextOccurrence,
  sanitizeEntry,
  upcoming,
  detectFromItems,
} from '../server/src/calendar.js';

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

process.stdout.write('\ncalendar: leap years\n');
t('leap-year detection', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
});

t('a 2/29 birthday lands on that day in a leap year', () => {
  const r = nextOccurrence({ date: '02-29' }, '2028-01-10');
  assert.equal(r.day, '2028-02-29');
  assert.equal(r.leapAdjusted, false);
});

t('a 2/29 birthday shifts to 3/1 in a common year and is explicitly flagged', () => {
  const r = nextOccurrence({ date: '02-29' }, '2026-01-10');
  assert.equal(r.day, '2026-03-01');
  assert.equal(r.leapAdjusted, true);
});

t('2/29 already past its shifted day -> look at the next year (not fall back)', () => {
  const r = nextOccurrence({ date: '02-29' }, '2026-03-02');
  assert.equal(r.day, '2027-03-01');
});

t('2/29 after its leap-year day -> the next year is common, so shift to 3/1', () => {
  const r = nextOccurrence({ date: '02-29' }, '2028-03-02');
  assert.equal(r.day, '2029-03-01');
});

process.stdout.write('\ncalendar: day counts and time zones\n');
t('the calendar-day difference is an integer and unaffected by DST', () => {
  // 2026-03-08 is the US DST start date (that local day has only 23 hours)
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
});

t('"today" across time zones uses the calendar day of the target zone', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(dayInTz(at, 'UTC'), '2026-03-05');
  assert.equal(dayInTz(at, 'Asia/Tokyo'), '2026-03-06'); // Tokyo is already on the 6th
  assert.equal(dayInTz(at, 'America/Los_Angeles'), '2026-03-05');
});

t('the countdown under the Tokyo zone is one day less than under UTC (right across midnight)', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '03-06' }] } };
  const jp = upcoming(cfg, { now: at, timeZone: 'Asia/Tokyo' });
  const utc = upcoming(cfg, { now: at, timeZone: 'UTC' });
  assert.equal(jp.all[0].days, 0);
  assert.equal(utc.all[0].days, 1);
});

t('today is the anniversary itself -> days = 0', () => {
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '03-05' }] } };
  assert.equal(upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' }).all[0].days, 0);
});

t('an expired one-off date no longer takes part in the countdown', () => {
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '2020-01-01' }] } };
  const u = upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' });
  assert.equal(u.all[0].past, true);
  assert.equal(u.due.length, 0);
});

process.stdout.write('\ncalendar: anniversaries and sorting\n');
t('the anniversary number is computed', () => {
  const r = nextOccurrence({ date: '05-20', since: 2021 }, '2026-01-01');
  assert.equal(r.day, '2026-05-20');
  assert.equal(r.turns, 5);
});

t('sorted by days remaining', () => {
  const cfg = {
    calendar: {
      entries: [
        { id: 'far', name: 'far', date: '12-31' },
        { id: 'near', name: 'near', date: '03-06' },
        { id: 'mid', name: 'mid', date: '04-01' },
      ],
    },
  };
  const u = upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(u.all.map((x) => x.id), ['near', 'mid', 'far']);
});

t('the reminder window only holds entries inside the window', () => {
  const cfg = {
    calendar: {
      entries: [
        { id: 'soon', name: 'soon', date: '03-07', remindDaysBefore: 3 },
        { id: 'later', name: 'later', date: '03-20', remindDaysBefore: 3 },
      ],
    },
  };
  const u = upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(u.reminders.map((x) => x.id), ['soon']);
});

t('hidden entries do not show up in the countdown', () => {
  const cfg = { calendar: { entries: [{ id: 'x', name: 'X', date: '03-06', hidden: true }] } };
  assert.equal(upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' }).all.length, 0);
});

process.stdout.write('\ncalendar: month grid\n');
t('the grid is always a multiple of 7, and the first row aligns to weekStart', () => {
  const sun = monthGrid(2026, 3, 0);
  const mon = monthGrid(2026, 3, 1);
  assert.equal(sun.cells.length % 7, 0);
  assert.equal(mon.cells.length % 7, 0);
  // 2026-03-01 is a Sunday: with a Sunday start it is the first cell, with a Monday start six
  // blanks precede it
  assert.equal(sun.cells[0].day, '2026-03-01');
  assert.equal(mon.cells.filter((c) => !c.inMonth).length >= 6, true);
});

t('monthGrid covers the whole month and includes adjacent-month padding', () => {
  const g = monthGrid(2026, 2, 1);
  const feb = g.cells.filter((c) => c.inMonth);
  assert.equal(feb.length, 28);
});

t('calendar marks land on the correct days (including the leap-day shift)', () => {
  const cfg = { calendar: { entries: [{ id: 'b', name: 'B', date: '02-29', kind: 'birthday' }] } };
  const marks = marksFor(cfg, 2026, 3);
  assert.ok(marks['2026-03-01'], 'a common year must mark 3/1');
  const leap = marksFor(cfg, 2028, 2);
  assert.ok(leap['2028-02-29'], 'a leap year must mark 2/29');
});

process.stdout.write('\ncalendar: clue extraction (local, no LLM)\n');
t('recognizes a 3D reveal plus a date', () => {
  const r = detectFromItems([{ title: '【3D披露】3月15日 晚上八点见！', sourceId: 'bili-opus-jaran' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, '3d');
  assert.equal(r[0].date, '03-15');
});

t('recognizes a Japanese birthday post', () => {
  const r = detectFromItems([{ title: '誕生日配信 5月20日 21:00〜', sourceId: 'x' }]);
  assert.equal(r[0].kind, 'birthday');
  assert.equal(r[0].date, '05-20');
});

t('a full date carrying a year', () => {
  const r = detectFromItems([{ title: 'デビュー記念 2026年4月1日 お知らせ' }]);
  assert.equal(r[0].kind, 'debut');
  assert.equal(r[0].date, '2026-04-01');
});

t('a date with no anniversary keyword is not treated as a clue', () => {
  assert.equal(detectFromItems([{ title: '3月15日 服务器维护公告' }]).length, 0);
});

t('a timestamp is not mistaken for a date', () => {
  assert.equal(detectFromItems([{ title: '生日 12:30:45 开始' }]).length, 0);
});

t('the same kind plus the same date keeps only one entry', () => {
  const r = detectFromItems([
    { title: '生日 5月20日', sourceId: 'a' },
    { title: '生日配信 5月20日', sourceId: 'b' },
  ]);
  assert.equal(r.length, 1);
});

process.stdout.write('\ncalendar: entry validation\n');
t('accepts both the yearly-recurring and the one-off format', () => {
  assert.ok(sanitizeEntry({ name: 'X', date: '03-05' }).entry);
  assert.ok(sanitizeEntry({ name: 'X', date: '2026-03-05' }).entry);
});

t('rejects bad dates and an empty name', () => {
  assert.ok(sanitizeEntry({ name: '', date: '03-05' }).error);
  assert.ok(sanitizeEntry({ name: 'X', date: '13-45' }).error);
  assert.ok(sanitizeEntry({ name: 'X', date: 'tomorrow' }).error);
});

t('reminder days are clamped to a sane range', () => {
  assert.equal(sanitizeEntry({ name: 'X', date: '03-05', remindDaysBefore: 999 }).entry.remindDaysBefore, 60);
  assert.equal(sanitizeEntry({ name: 'X', date: '03-05', remindDaysBefore: -5 }).entry.remindDaysBefore, 0);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
