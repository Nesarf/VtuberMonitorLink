// dormant-test.mjs — 「停止活动 / 毕业」区块的自检
// 这条规则的边界很敏感：差一天就算错一类人。所以把阈值两侧、复出、没记录过都钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DORMANT_DEFAULTS, daysSince, dormantBlock, isDormant } from '../server/src/dormant.js';
import { ingestItems, latestItemsByPerson, openArchive } from '../server/src/archive.js';

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

const NOW = new Date('2026-09-30T12:00:00Z');
const people = [
  { id: 'grad', name: '已毕业', agency: 'BOX' },
  { id: 'idle', name: '长期休止', agency: 'BOX' },
  { id: 'active', name: '在更的', agency: 'BOX' },
  { id: 'back', name: '回来了', agency: 'BOX' },
  { id: 'never', name: '没见过', agency: 'BOX' },
];

process.stdout.write('\ndormant: 阈值\n');

t('半年（默认 6 个月）两侧：正好到阈值算，差一天不算', () => {
  const th = Math.round(6 * 30.44); // 183 天（一年按 365.28 天、一月按 30.44 天）
  const at = (days) => new Date(Date.parse('2026-09-30T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  assert.equal(isDormant({ lastDay: at(th), now: NOW }).dormant, true, `${th} 天前应当算停止活动`);
  assert.equal(isDormant({ lastDay: at(th - 1), now: NOW }).dormant, false, `${th - 1} 天前还不算`);
  assert.equal(isDormant({ lastDay: at(th), now: NOW }).thresholdDays, th);
  // 写死一个日期做交叉验证：2026-04-02 到 2026-09-30 共 181 天 → 未到 183
  assert.equal(daysSince('2026-04-02', NOW), 181);
  assert.equal(isDormant({ lastDay: '2026-04-02', now: NOW }).dormant, false);
  assert.equal(isDormant({ lastDay: '2026-03-20', now: NOW }).dormant, true, '194 天前显然已休止');
});

t('months 可调：改成 3 个月时，100 天前就算', () => {
  assert.equal(isDormant({ lastDay: '2026-06-22', now: NOW, months: 3 }).dormant, true);
  assert.equal(isDormant({ lastDay: '2026-06-22', now: NOW, months: 6 }).dormant, false);
});

t('没有日期 → 不判断（不算「停止活动」）', () => {
  assert.deepEqual(isDormant({ lastDay: null, now: NOW }), { dormant: false, days: null });
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince('2026-09-30', NOW), 0);
  assert.equal(daysSince('2026-09-01', NOW), 29);
});

process.stdout.write('\ndormant: 区块\n');

const byDay = {
  grad: { '2026-03-01': 2, '2026-03-10': 1 }, // 最后 3-10，约 6.7 个月前
  idle: { '2025-12-20': 1 }, // 约 9.4 个月前
  active: { '2026-09-29': 3, '2026-09-28': 1 }, // 正常
  back: { '2026-01-15': 1, '2026-09-29': 1 }, // 休眠 8 个月后又动了
};
const latest = {
  grad: [{ title: '最后一条动态', day: '2026-03-10', url: 'https://example.com/grad' }],
  idle: [{ title: '休止公告', day: '2025-12-20', url: 'https://example.com/idle' }],
  back: [{ title: '复出直播预告', day: '2026-09-29', url: 'https://example.com/back' }],
};

t('休眠的人被列出来；在更的人不列；没记录过的人不列', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, todayPeople: [], now: NOW });
  const names = block.dormant.map((d) => d.name);
  assert.ok(names.includes('已毕业'), names.join(','));
  assert.ok(names.includes('长期休止'));
  assert.ok(!names.includes('在更的'), '在更的人不该出现');
  assert.ok(!names.includes('没见过'), '从没有记录的人不是「停止活动」，是「没见过」');
  assert.equal(block.skipped, 1, '没记录的人应当被计入 skipped');
});

t('复出的人排最前，并单独标出来（那是最该被看见的一条）', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, todayPeople: ['back'], now: NOW });
  assert.equal(block.dormant[0].name, '回来了', '复出的要排第一: ' + block.dormant.map((d) => d.name).join(','));
  assert.equal(block.returnees.length, 1);
  assert.match(block.markdown, /可能有动静了/);
  assert.ok(block.markdown.indexOf('回来了') < block.markdown.indexOf('已毕业'), '复出区块应当在休眠名单之前');
});

t('markdown 形状：标题、月份、每人最新内容与链接都在', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, now: NOW });
  assert.match(block.markdown, /^## 🌙 停止活动/);
  const grad = block.dormant.find((d) => d.name === '已毕业');
  assert.equal(grad.months, 6.7, '约 6.7 个月，实际 ' + grad.months);
  assert.match(block.markdown, /最后 2026-03-10（约 6.7 个月前）/);
  assert.match(block.markdown, /https:\/\/example\.com\/grad/);
  assert.match(block.markdown, /休止公告/);
});

t('人数与条数上限生效，并在超出时说明还有多少人', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, name: '人' + i, agency: 'B' }));
  const manyByDay = Object.fromEntries(many.map((p) => [p.id, { '2026-01-01': 1 }]));
  const block = dormantBlock({ people: many, byDay: manyByDay, latestItems: {}, rules: { maxPeople: 5 }, now: NOW });
  assert.equal(block.dormant.length, 5);
  assert.equal(block.hidden, 15);
  assert.match(block.markdown, /另有 15 位/);

  const block2 = dormantBlock({
    people: [people[0]],
    byDay: { grad: byDay.grad },
    latestItems: { grad: [1, 2, 3, 4].map((n) => ({ title: 't' + n, day: '2026-03-10' })) },
    rules: { maxItems: 2 },
    now: NOW,
  });
  assert.equal(block2.dormant[0].items.length, 2, '每人最多 2 条');
});

t('关掉开关就完全不产出', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, rules: { enabled: false }, now: NOW });
  assert.deepEqual(block, { dormant: [], returnees: [], markdown: '', skipped: 0 });
});

t('空名单不炸', () => {
  const block = dormantBlock({ people: [], byDay: {}, now: NOW });
  assert.equal(block.markdown, '');
  assert.deepEqual(block.dormant, []);
});

process.stdout.write('\ndormant: 从归档取「最新内容」\n');

await t('latestItemsByPerson：按人取最新几条（用条目自己的日期排，不是入库日）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-dorm-'));
  const cfg = { paths: { feedsDir: dir, reportsDir: dir, logsDir: dir } };
  const db = openArchive(cfg);
  // 全部在「今天」入库（像一次回溯抓取），但内容自身的日期跨越半年 ——
  // 这正是「停止活动」区块要面对的形状
  ingestItems(db, [
    { id: 'i1', publishedAt: '2026-03-01T00:00:00Z', title: '老内容', url: 'https://x/1', people: ['grad'], text: '' },
    { id: 'i2', publishedAt: '2026-03-10T00:00:00Z', title: '最后一条', url: 'https://x/2', people: ['grad'], text: '' },
    { id: 'i3', publishedAt: '2026-09-29T00:00:00Z', title: '今天的', url: 'https://x/3', people: ['active'], text: '' },
    { id: 'i4', title: '没有自己日期的条目', url: 'https://x/4', people: ['grad'], text: '' },
  ], { day: '2026-09-30' });

  const map = latestItemsByPerson(db, { personIds: ['grad', 'active'], limit: 1 });
  assert.equal(map.grad[0].title, '最后一条', '要最新的那条（按内容日期），实际 ' + map.grad[0].title);
  assert.equal(map.grad[0].day, '2026-03-10');
  assert.equal(map.active[0].title, '今天的');
  assert.deepEqual(
    latestItemsByPerson(db, { personIds: ['grad'], limit: 3 }).grad.map((r) => r.title),
    ['最后一条', '老内容', '没有自己日期的条目'],
    '按内容日期倒序；没有 published_at 的按入库日兜底',
  );
  assert.deepEqual(latestItemsByPerson(db, { personIds: ['nobody'] }).nobody, [], '没人归属的返回空数组而不是抛错');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
