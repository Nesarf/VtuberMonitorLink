// silence-test.mjs — 静默/缺失检测的自检
// 这条能力最怕「乱报」：把正常间隔当成异常，比不报还糟。所以用构造出来的时间线把它钉住。
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
/** 构造「从 startDay 起，每隔 gap 天有一条」的时间线 */
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

process.stdout.write('\nsilence: 基线\n');

t('日更的人：间隔 1 天、最后活跃就是今天', () => {
  const b = baselineOf(daily(), { now: NOW });
  assert.equal(b.gapDays, 1);
  assert.equal(b.lastDay, '2026-03-30');
  assert.equal(b.quietDays, 0);
  assert.ok(b.activeDays >= 28, '活跃天数 ' + b.activeDays);
});

t('月更的人：间隔约 30 天 → 容忍区间按他的节奏放长（不被小上限压死）', () => {
  const sparse = { '2026-01-05': 1, '2026-02-04': 1, '2026-03-06': 1 };
  const b = baselineOf(sparse, { now: NOW });
  assert.ok(b.gapDays >= 29 && b.gapDays <= 31, '间隔应约 30 天，实际 ' + b.gapDays);
  const tol = toleranceDays(b, SILENCE_DEFAULTS);
  assert.equal(tol, 75, '30 天 × 2.5 = 75 天（maxDays=90 只是兜底，不该把月更的人压到 21 天）；实际 ' + tol);
});

t('只有一天记录 → 估不出节奏 → 不判断（宁可不报，也不乱报）', () => {
  const b = baselineOf({ '2026-03-29': 2 }, { now: NOW });
  assert.equal(b.gapDays, null);
  assert.equal(toleranceDays(b, SILENCE_DEFAULTS), null);
  assert.equal(b.lastDay, '2026-03-29');
});

t('没有历史 → 没有基线，也就没有容忍区间', () => {
  const b = baselineOf({}, { now: NOW });
  assert.equal(b.lastDay, null);
  assert.equal(toleranceDays(b, SILENCE_DEFAULTS), null);
});

t('容忍区间被下限夹住：日更的人不会因为隔了 1 天就报', () => {
  const b = baselineOf(daily({ until: '2026-03-29' }), { now: NOW });
  const tol = toleranceDays(b, SILENCE_DEFAULTS);
  assert.equal(tol, SILENCE_DEFAULTS.minDays, '应被 minDays 夹住，实际 ' + tol);
});

process.stdout.write('\nsilence: 个人静默\n');

const people = [
  { id: 'p1', name: '甲', agency: 'Box-A' },
  { id: 'p2', name: '乙', agency: 'Box-A' },
  { id: 'p3', name: '丙', agency: 'Box-A' },
  { id: 'p4', name: '丁', agency: 'Box-A' },
  { id: 'solo', name: '戊', agency: null },
];

t('日更的人停了 4 天 → warn；停了 6 天（≥2 倍容忍）→ high；一直在更 → 不报', () => {
  const res = detectSilence({
    byDay: {
      p1: daily({ until: '2026-03-26' }), // 静默 4 天
      p2: daily({ until: '2026-03-30' }), // 正常
    },
    people,
    now: NOW,
  });
  assert.equal(res.person.length, 1, JSON.stringify(res.person));
  assert.equal(res.person[0].personId, 'p1');
  assert.equal(res.person[0].quietDays, 4);
  assert.equal(res.person[0].level, 'warn');
  assert.match(res.person[0].reason, /甲 已 4 天/);
  assert.equal(res.checked, 2);

  const worse = detectSilence({ byDay: { p1: daily({ until: '2026-03-24' }) }, people, now: NOW });
  assert.equal(worse.person[0].quietDays, 6);
  assert.equal(worse.person[0].level, 'high', '静默 ≥2 倍容忍区间算 high');
});

t('停得越久等级越高（≥ 2 倍容忍区间算 high）', () => {
  const res = detectSilence({ byDay: { p1: daily({ until: '2026-03-20' }) }, people, now: NOW });
  assert.equal(res.person[0].quietDays, 10);
  assert.equal(res.person[0].level, 'high');
});

t('只有一天记录的人不报，但会被记为「没有基线」（知道是没判断，而不是没问题）', () => {
  const res = detectSilence({ byDay: { solo: { '2026-03-29': 1 } }, people, now: NOW });
  assert.equal(res.person.length, 0);
  assert.equal(res.checked, 0, '估不出节奏就不该计入「已检查」');
  assert.equal(res.skippedNoBaseline, 1);
  const none = detectSilence({ byDay: {}, people, now: NOW });
  assert.equal(none.skippedNoBaseline, 0);
  assert.match(silenceSummary(none), /暂无/);
});

t('月更的人停 24 天不该报，停 87 天才报（阈值跟着他自己的节奏走）', () => {
  const sparse = { '2026-01-05': 1, '2026-02-04': 1, '2026-03-06': 1 };
  const early = detectSilence({ byDay: { p1: sparse }, people, now: NOW });
  assert.equal(early.person.length, 0, '停 24 天（容忍 75 天）不该报，实际 ' + JSON.stringify(early.person));
  const late = detectSilence({ byDay: { p1: sparse }, people, now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(late.person.length, 1, '停 87 天就该报了');
  assert.ok(late.person[0].quietDays > 75);
});

t('关掉开关就完全不检测', () => {
  const res = detectSilence({ byDay: { p1: daily({ until: '2026-03-01' }) }, people, now: NOW, rules: { enabled: false } });
  assert.deepEqual(res, { person: [], group: [], checked: 0, skippedNoBaseline: 0 });
});

process.stdout.write('\nsilence: 箱级同时安静\n');

t('一箱 4 人里有 3 人同时安静 ≥5 天 → 报箱级信号', () => {
  const res = detectSilence({
    byDay: {
      p1: daily({ until: '2026-03-24' }), // 静默 6 天
      p2: daily({ until: '2026-03-23' }), // 静默 7 天
      p3: daily({ until: '2026-03-25' }), // 静默 5 天
      p4: daily(), // 正常
    },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 1, JSON.stringify(res.group));
  assert.equal(res.group[0].agency, 'Box-A');
  assert.equal(res.group[0].memberCount, 4);
  assert.deepEqual(res.group[0].members.sort(), ['丙', '乙', '甲'].sort());
  assert.equal(res.group[0].quietDays, 5);
  assert.match(res.group[0].reason, /同时安静/);
});

t('全员安静 → high；只有一两个人安静 → 不算箱级', () => {
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
  assert.equal(few.group.length, 0, '一个人安静是常态，不该报箱级');
});

t('成员太少的「箱」不参与箱级判断（2 个人不算箱）', () => {
  const res = detectSilence({
    byDay: { p1: daily({ until: '2026-03-20' }), p2: daily({ until: '2026-03-20' }) },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 0);
  assert.equal(res.person.length, 2, '个人静默照报');
});

t('没填 agency 的人不参与箱级判断（但个人静默照报）', () => {
  const res = detectSilence({
    byDay: { solo: daily({ from: '2026-02-01', until: '2026-03-01' }) },
    people,
    now: NOW,
  });
  assert.equal(res.group.length, 0);
  assert.equal(res.person.length, 1);
  assert.equal(res.person[0].agency, null);
});

process.stdout.write('\nsilence: 其他\n');

t('摘要：有箱级先说箱级，没有就说个人', () => {
  const s = silenceSummary({ group: [{ agency: 'Box-A' }], person: [{ name: '甲' }], checked: 3 });
  assert.match(s, /箱级安静 1 个：Box-A/);
  assert.match(s, /个人静默 1 人：甲/);
  assert.match(silenceSummary({ group: [], person: [], checked: 3 }), /均在正常区间/);
});

t('按 agency 取成员；从官方来源域名反推 agency', () => {
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
