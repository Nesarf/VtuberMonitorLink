// calendar-test.mjs — 日历算法的自检 / self-test for the countdown calendar
//
// 这里专门盯两类「安静地错」的情况：
//   · 闰日：2/29 的生日在平年怎么算
//   · 时区/夏令时：用毫秒差算天数会在切换日附近差一天
// 另外验证本地关键词抽取（不联网、不用 LLM）不会把无关日期当成纪念日。
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
t('闰年判定', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
});

t('2/29 的生日在闰年就在当天', () => {
  const r = nextOccurrence({ date: '02-29' }, '2028-01-10');
  assert.equal(r.day, '2028-02-29');
  assert.equal(r.leapAdjusted, false);
});

t('2/29 的生日在平年顺延到 3/1 并明确标出', () => {
  const r = nextOccurrence({ date: '02-29' }, '2026-01-10');
  assert.equal(r.day, '2026-03-01');
  assert.equal(r.leapAdjusted, true);
});

t('2/29 已过顺延日 → 找下一年（而不是回退）', () => {
  const r = nextOccurrence({ date: '02-29' }, '2026-03-02');
  assert.equal(r.day, '2027-03-01');
});

t('2/29 在闰年当天之后 → 下一年是平年，顺延 3/1', () => {
  const r = nextOccurrence({ date: '02-29' }, '2028-03-02');
  assert.equal(r.day, '2029-03-01');
});

process.stdout.write('\ncalendar: 天数与时区\n');
t('日历日差是整数，不受夏令时影响', () => {
  // 2026-03-08 是美国夏令时开始日（当地那天只有 23 小时）
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
});

t('跨时区取「今天」用的是目标时区的日历日', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(dayInTz(at, 'UTC'), '2026-03-05');
  assert.equal(dayInTz(at, 'Asia/Tokyo'), '2026-03-06'); // 东京已经是 6 号
  assert.equal(dayInTz(at, 'America/Los_Angeles'), '2026-03-05');
});

t('东京时区下的倒计时比 UTC 少一天（正好跨日）', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '03-06' }] } };
  const jp = upcoming(cfg, { now: at, timeZone: 'Asia/Tokyo' });
  const utc = upcoming(cfg, { now: at, timeZone: 'UTC' });
  assert.equal(jp.all[0].days, 0);
  assert.equal(utc.all[0].days, 1);
});

t('今天是纪念日本身 → days = 0', () => {
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '03-05' }] } };
  assert.equal(upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' }).all[0].days, 0);
});

t('过期的一次性日期不再参与倒计时', () => {
  const cfg = { calendar: { entries: [{ id: 'a', name: 'A', date: '2020-01-01' }] } };
  const u = upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' });
  assert.equal(u.all[0].past, true);
  assert.equal(u.due.length, 0);
});

process.stdout.write('\ncalendar: 周年与排序\n');
t('算得出第几周年', () => {
  const r = nextOccurrence({ date: '05-20', since: 2021 }, '2026-01-01');
  assert.equal(r.day, '2026-05-20');
  assert.equal(r.turns, 5);
});

t('按剩余天数排序', () => {
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

t('提醒窗口只包含窗口内的条目', () => {
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

t('隐藏的条目不出现在倒计时里', () => {
  const cfg = { calendar: { entries: [{ id: 'x', name: 'X', date: '03-06', hidden: true }] } };
  assert.equal(upcoming(cfg, { now: new Date('2026-03-05T10:00:00Z'), timeZone: 'UTC' }).all.length, 0);
});

process.stdout.write('\ncalendar: 月历网格\n');
t('网格始终是 7 的整数倍，且首行按 weekStart 对齐', () => {
  const sun = monthGrid(2026, 3, 0);
  const mon = monthGrid(2026, 3, 1);
  assert.equal(sun.cells.length % 7, 0);
  assert.equal(mon.cells.length % 7, 0);
  // 2026-03-01 是周日：周日开始时它就在第一格；周一开始时它前面有 6 个占位
  assert.equal(sun.cells[0].day, '2026-03-01');
  assert.equal(mon.cells.filter((c) => !c.inMonth).length >= 6, true);
});

t('monthGrid 的总天数覆盖整月并含相邻月补位', () => {
  const g = monthGrid(2026, 2, 1);
  const feb = g.cells.filter((c) => c.inMonth);
  assert.equal(feb.length, 28);
});

t('月历标记落在正确的日子上（含闰日顺延）', () => {
  const cfg = { calendar: { entries: [{ id: 'b', name: 'B', date: '02-29', kind: 'birthday' }] } };
  const marks = marksFor(cfg, 2026, 3);
  assert.ok(marks['2026-03-01'], '平年应标在 3/1');
  const leap = marksFor(cfg, 2028, 2);
  assert.ok(leap['2028-02-29'], '闰年应标在 2/29');
});

process.stdout.write('\ncalendar: 线索抽取（本地、无 LLM）\n');
t('认得 3D披露 + 日期', () => {
  const r = detectFromItems([{ title: '【3D披露】3月15日 晚上八点见！', sourceId: 'bili-opus-jaran' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, '3d');
  assert.equal(r[0].date, '03-15');
});

t('认得日语生日', () => {
  const r = detectFromItems([{ title: '誕生日配信 5月20日 21:00〜', sourceId: 'x' }]);
  assert.equal(r[0].kind, 'birthday');
  assert.equal(r[0].date, '05-20');
});

t('带年份的完整日期', () => {
  const r = detectFromItems([{ title: 'デビュー記念 2026年4月1日 お知らせ' }]);
  assert.equal(r[0].kind, 'debut');
  assert.equal(r[0].date, '2026-04-01');
});

t('没有纪念日关键词的日期不被当成线索', () => {
  assert.equal(detectFromItems([{ title: '3月15日 服务器维护公告' }]).length, 0);
});

t('不把时间戳误当日期', () => {
  assert.equal(detectFromItems([{ title: '生日 12:30:45 开始' }]).length, 0);
});

t('同一类型同一日期只留一条', () => {
  const r = detectFromItems([
    { title: '生日 5月20日', sourceId: 'a' },
    { title: '生日配信 5月20日', sourceId: 'b' },
  ]);
  assert.equal(r.length, 1);
});

process.stdout.write('\ncalendar: 条目校验\n');
t('接受每年重复与一次性两种格式', () => {
  assert.ok(sanitizeEntry({ name: 'X', date: '03-05' }).entry);
  assert.ok(sanitizeEntry({ name: 'X', date: '2026-03-05' }).entry);
});

t('拒绝坏日期与空名字', () => {
  assert.ok(sanitizeEntry({ name: '', date: '03-05' }).error);
  assert.ok(sanitizeEntry({ name: 'X', date: '13-45' }).error);
  assert.ok(sanitizeEntry({ name: 'X', date: 'tomorrow' }).error);
});

t('提醒天数被夹在合理范围', () => {
  assert.equal(sanitizeEntry({ name: 'X', date: '03-05', remindDaysBefore: 999 }).entry.remindDaysBefore, 60);
  assert.equal(sanitizeEntry({ name: 'X', date: '03-05', remindDaysBefore: -5 }).entry.remindDaysBefore, 0);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
