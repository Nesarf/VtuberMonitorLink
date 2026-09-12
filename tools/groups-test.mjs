// groups-test.mjs — 箱视角聚合的自检
// 聚合最怕「看起来对」：日期轴错位一格、同一天算重复、没填 agency 的人被悄悄丢掉，
// 都会让热力图与信号变成假的。用构造出来的时间线把这些钉死。
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

process.stdout.write('\ngroups: 日期轴\n');

t('日期轴升序、含今天、长度正确', () => {
  const axis = dayAxis(5, '2026-03-30');
  assert.deepEqual(axis, ['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30']);
  assert.equal(dayAxis(1, '2026-03-30').length, 1);
});

process.stdout.write('\ngroups: 单个箱\n');

const byDay = {
  a1: span('2026-03-01', '2026-03-30'), // 日更
  a2: span('2026-03-01', '2026-03-26'), // 停了 4 天
  a3: { '2026-03-02': 2, '2026-03-09': 1, '2026-03-16': 1, '2026-03-23': 1 }, // 周更
  a4: { '2026-03-15': 1 }, // 只有一天记录 → 没基线
  b1: span('2026-03-25', '2026-03-30'),
  u1: span('2026-03-28', '2026-03-30'),
};

t('成员的每日条数与日期轴一一对应（错位一格热力图就全错了）', () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(10, '2026-03-30'), now: NOW });
  const a1 = block.members.find((m) => m.id === 'a1');
  assert.equal(a1.counts.length, 10, 'counts 长度必须等于轴长度');
  assert.deepEqual(a1.counts, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], '日更的人最后 10 天都该是 1');
  const a2 = block.members.find((m) => m.id === 'a2');
  assert.deepEqual(a2.counts.slice(-4), [0, 0, 0, 0], '停更的 4 天应当是 0');
  assert.equal(a2.quietDays, 4);
});

t('等级跟着个人节奏：日更的人停 4 天 warn；只有一天记录的人 unknown', () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.equal(block.members.find((m) => m.id === 'a2').level, 'warn');
  assert.equal(block.members.find((m) => m.id === 'a1').level, 'ok');
  const a4 = block.members.find((m) => m.id === 'a4');
  assert.equal(a4.level, 'unknown', '没有基线就不该给等级');
  assert.equal(a4.toleranceDays, null);
});

t('周更的人停 7 天不算异常（他自己的节奏就是 7 天）', () => {
  const block = agencyBlock({ agency: 'BOX', members: [people[2]], byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  const a3 = block.members[0];
  assert.ok(a3.gapDays >= 6.5 && a3.gapDays <= 7.5, '节奏应约 7 天，实际 ' + a3.gapDays);
  assert.equal(a3.level, 'ok', '周更的人停 7 天不该报警');
});

t('同刻出现：同一天 ≥2 人活跃才计入，并带上是哪几个人', () => {
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 4), byDay, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.ok(block.coActiveDays > 0);
  for (const c of block.coActive) {
    assert.ok(c.count >= 2, JSON.stringify(c));
    assert.equal(c.members.length, c.count);
  }
  // 3-30 之后没人动：最后几天不该有同刻出现
  const last = block.coActive[0];
  assert.ok(last.day <= '2026-03-26', '最近的同刻出现应当不晚于 3-26，实际 ' + last.day);
});

t('整箱安静：轴尾连续没人动的天数（成员够多时才是「信号」）', () => {
  const onlyOld = {
    a1: span('2026-03-01', '2026-03-20'),
    a2: span('2026-03-01', '2026-03-18'),
    a3: span('2026-03-01', '2026-03-19'),
  };
  const block = agencyBlock({ agency: 'BOX', members: people.slice(0, 3), byDay: onlyOld, axis: dayAxis(30, '2026-03-30'), now: NOW });
  assert.equal(block.quietStreak, 10, '3-21 到 3-30 共 10 天没人动');
  assert.equal(block.groupSignal.kind, 'all-quiet');
  assert.equal(block.groupSignal.level, 'high');
  assert.match(block.groupSignal.reason, /整箱 3 人已经 10 天/);
});

t('多数人安静（但不是全员）→ warn 级箱信号；只有一两个人安静 → 没有箱信号', () => {
  const most = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 4),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-01', '2026-03-19'), a3: span('2026-03-01', '2026-03-21'), a4: span('2026-03-28', '2026-03-30') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(most.silent.length, 3);
  assert.ok(most.groupSignal, '3/4 人同时安静应当有信号');
  assert.equal(most.groupSignal.kind, 'most-quiet');
  assert.equal(most.groupSignal.level, 'warn');

  const few = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 4),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-28', '2026-03-30'), a3: span('2026-03-28', '2026-03-30'), a4: span('2026-03-28', '2026-03-30') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(few.groupSignal, null, '一个人安静是常态，不该出箱信号');
});

t('成员太少（<minMembers）不出箱信号', () => {
  const block = agencyBlock({
    agency: 'BOX',
    members: people.slice(0, 2),
    byDay: { a1: span('2026-03-01', '2026-03-20'), a2: span('2026-03-01', '2026-03-19') },
    axis: dayAxis(30, '2026-03-30'),
    now: NOW,
  });
  assert.equal(block.groupSignal, null);
  assert.equal(block.silent.length, 2, '个人静默照报');
});

process.stdout.write('\ngroups: 多个箱\n');

t('按 agency 分块，按条数排序；没填 agency 的进「未分组」而不是消失', () => {
  const view = groupView({ byDay, people, days: 30, now: NOW, endDay: '2026-03-30' });
  assert.deepEqual(view.groups.map((g) => g.agency), ['BOX', 'Other']);
  assert.ok(view.groups[0].totals.items >= view.groups[1].totals.items, '按条数降序');
  assert.ok(view.ungrouped, '未分组块必须存在');
  assert.deepEqual(view.ungrouped.members.map((m) => m.name), ['己']);
  assert.equal(view.people, 6, '总数要等于全部关注对象');
  const accounted = view.groups.reduce((a, g) => a + g.totals.members, 0) + view.ungrouped.totals.members;
  assert.equal(accounted, 6, '每个人都要被算进去（不能漏）');
});

t('空配置不炸：0 个关注对象 → 空视图', () => {
  const view = groupView({ byDay: {}, people: [], days: 7, now: NOW, endDay: '2026-03-30' });
  assert.deepEqual(view.groups, []);
  assert.equal(view.ungrouped, null);
  assert.equal(view.axis.length, 7);
});

t('箱级聚合的每日合计 = 成员当日之和', () => {
  const view = groupView({ byDay, people, days: 10, now: NOW, endDay: '2026-03-30' });
  const box = view.groups.find((g) => g.agency === 'BOX');
  for (let i = 0; i < box.perDay.length; i++) {
    assert.equal(box.perDay[i], box.members.reduce((a, m) => a + m.counts[i], 0), '第 ' + i + ' 天合计不符');
  }
  assert.equal(box.activeLast7, box.members.filter((m) => m.counts.slice(-7).some((n) => n > 0)).length);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
