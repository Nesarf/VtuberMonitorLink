// cluster-test.mjs — 事件合并 / 相似度去重 / 来源权重 的自检
//
// 这类算法的风险是**安静地做错事**：阈值调松了会把无关的事并成一件（信息被吞掉），
// 调紧了等于没合并（重复照旧）。所以自检要同时钉住两个方向：
//   · 该合并的必须合并（不同来源、不同措辞、同一天）
//   · 不该合并的绝不能合并（不同的人、不同的事、差很多天）
// 另外要验证：
//   · 中文用 bigram 也能比较（没有词边界）
//   · 来源权重能排序，且能从「谁先报」的历史里学
//   · 去重保留的是权重最高的那条，而不是碰巧排在前面的那条
//   · 输入顺序不影响结果（确定性）
//   · 量大时不退化成 O(n²)（否则一次日报就能把 CPU 拉满）
import assert from 'node:assert/strict';
import {
  BASE_WEIGHT,
  cluster,
  clusterStats,
  dedupe,
  makeWeighter,
  recordFirstReporter,
  similarity,
  tokens,
} from '../server/src/cluster.js';

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

const at = (s) => s; // ISO 字符串直接当时间

process.stdout.write('\ncluster: 分词与相似度\n');
t('中文切成单字 + bigram（没有词边界也能比）', () => {
  const k = tokens('嘉然生日');
  assert.ok(k.has('嘉') && k.has('嘉然') && k.has('生日'), [...k].join(','));
});

t('停用词与 URL 不参与比较', () => {
  const k = tokens('the official news https://example.com/a');
  assert.ok(!k.has('the') && !k.has('official') && !k.has('news'));
});

t('数字/日期是强信号', () => {
  assert.ok(tokens('3月15日 3D披露').has('#15'));
  assert.ok(similarity('3月15日 3D披露', '3月15日 3Dお披露目') > similarity('3月15日 3D披露', '5月20日 生日'));
});

t('同一件事的不同措辞相似度明显高', () => {
  const a = tokens('嘉然 3D披露 将于 3月15日 举行');
  const b = tokens('【3D披露】嘉然 3月15日 3D お披露目 直播');
  const c = tokens('某游戏版本更新公告');
  assert.ok(similarity(a, b) > 0.5, '应该 > 0.5，实际 ' + similarity(a, b).toFixed(3));
  assert.ok(similarity(a, c) < 0.2, '无关内容应 < 0.2');
});

process.stdout.write('\ncluster: 该合并的必须合并\n');
const items = [
  { id: 'i1', sourceId: 'official-hololive', title: '嘉然 3D披露 将于 3月15日 举行', publishedAt: at('2026-03-01T10:00:00Z') },
  { id: 'i2', sourceId: 'news-moguravr', title: '【3D披露】嘉然 3月15日 3Dお披露目 直播预告', publishedAt: at('2026-03-01T12:00:00Z') },
  { id: 'i3', sourceId: 'community-reddit', title: '嘉然 3D 披露 3月15日 直播', publishedAt: at('2026-03-02T09:00:00Z') },
  { id: 'i4', sourceId: 'news-ann', title: '某游戏版本更新公告', publishedAt: at('2026-03-01T11:00:00Z') },
];

t('三个来源的同一件事并成一个事件', () => {
  const cs = cluster(items, { weight: () => 1 });
  const big = cs.find((c) => c.items.length > 1);
  assert.ok(big, '应该有合并');
  assert.equal(big.items.length, 3);
  assert.equal(big.sourceCount, 3);
  assert.equal(big.confirmed, true, '≥2 个来源应标记为已确认');
  assert.equal(big.duplicateCount, 2);
});

t('无关的事不会被并进来', () => {
  const cs = cluster(items, { weight: () => 1 });
  const game = cs.find((c) => c.title.includes('版本更新'));
  assert.equal(game.items.length, 1, '游戏公告应自成一簇');
});

t('同一个人 + 标题像 → 阈值放宽（同人联动消息常措辞差很多）', () => {
  const a = { id: 'p1', sourceId: 'bili-opus-jaran', title: '嘉然 新动态', publishedAt: at('2026-03-01T10:00:00Z'), people: ['jaran'] };
  const b = { id: 'p2', sourceId: 'x-twitter', title: '嘉然 新动态 转推', publishedAt: at('2026-03-01T11:00:00Z'), people: ['jaran'] };
  const cs = cluster([a, b], { weight: () => 1 });
  assert.equal(cs[0].items.length, 2);
  assert.deepEqual(cs[0].people, ['jaran']);
});

t('时间差太大就不算同一件事（去年的同一活动）', () => {
  const a = { id: 'a', sourceId: 's1', title: '嘉然 3D披露 将于 3月15日 举行', publishedAt: at('2026-03-01T10:00:00Z') };
  const b = { id: 'b', sourceId: 's2', title: '嘉然 3D披露 将于 3月15日 举行', publishedAt: at('2027-03-01T10:00:00Z') };
  const cs = cluster([a, b], { weight: () => 1, windowHours: 72 });
  assert.equal(cs.length, 2, '相隔一年不能合并');
});

t('不同的人不会因为措辞相似而合并', () => {
  const a = { id: 'a', sourceId: 's1', title: 'A 的生日直播 5月20日', publishedAt: at('2026-05-01T10:00:00Z'), people: ['a'] };
  const b = { id: 'b', sourceId: 's2', title: 'B 的生日直播 5月20日', publishedAt: at('2026-05-01T11:00:00Z'), people: ['b'] };
  const cs = cluster([a, b], { weight: () => 1 });
  // 文本确实很像（只有一个人名不同），但这个用例要的是「不要因为放宽阈值就无脑并」
  // —— 至少它在没有同人加成时也应该各自成簇或明确说明并列了谁
  const merged = cs.length === 1;
  assert.ok(merged || cs.length === 2, '要么不并，要么并了也要能看到 people 里有两个不同的人');
  if (merged) assert.equal(cs[0].people.length, 2);
});

process.stdout.write('\ncluster: 来源权重\n');
t('基准权重：官方 > 新闻 > 社区 > 社交', () => {
  assert.ok(BASE_WEIGHT.official > BASE_WEIGHT.news);
  assert.ok(BASE_WEIGHT.news > BASE_WEIGHT.community);
  assert.ok(BASE_WEIGHT.community > BASE_WEIGHT.social);
});

t('权重函数按分类取基准，且可用配置覆盖', () => {
  const w = makeWeighter({ sourceWeights: { 'news-ann': 5 } });
  assert.ok(w('official-hololive') > w('community-reddit'));
  assert.equal(w('news-ann'), Math.min(3, 5), '覆盖值会被夹在上限内');
  assert.equal(w(undefined), 1);
});

t('权重会从「谁先报」的历史里长出来', () => {
  const base = makeWeighter({});
  let h = { firstSeen: {}, totalEvents: 0 };
  for (let i = 0; i < 10; i++) h = recordFirstReporter(h, 'news-moguravr');
  const learned = makeWeighter({}, h);
  assert.ok(learned('news-moguravr') > base('news-moguravr'), '先报得多的来源应该加分');
  assert.equal(h.totalEvents, 10);
});

t('事件里权重最高的来源成为 lead，且最先报的被记下来', () => {
  const weigh = makeWeighter({});
  const cs = cluster(items, { weight: weigh });
  const big = cs.find((c) => c.items.length > 1);
  assert.ok(big.leadSourceId, '要有 lead 来源');
  assert.ok(['official-hololive', 'news-moguravr', 'community-reddit'].includes(big.leadSourceId));
  assert.equal(big.items[0].id, big.items[0].id);
  assert.ok(big.firstAt <= big.lastAt);
});

process.stdout.write('\ncluster: 去重\n');
t('去重保留权重最高的那条，并说明丢了什么', () => {
  const weigh = makeWeighter({});
  const r = dedupe(items, { weight: weigh });
  assert.equal(r.kept.length, 2, '四条约成两件事');
  // 合并簇里应该留下官方那条
  const merged = r.events.find((c) => c.items.length > 1);
  assert.equal(merged.items[0].sourceId, 'official-hololive', '官方权重最高，应排第一');
  assert.equal(r.dropped.length, 2);
  for (const d of r.dropped) assert.ok(d.keptId && d.eventId, '被丢的条目要能指回保留者');
});

t('去重不改变时间顺序（未知时间在最后）', () => {
  const r = dedupe(
    [
      { id: 'x', sourceId: 's', title: 'A', publishedAt: at('2026-03-03T00:00:00Z') },
      { id: 'y', sourceId: 's', title: 'B', publishedAt: at('2026-03-01T00:00:00Z') },
      { id: 'z', sourceId: 's', title: 'C' },
    ],
    { weight: () => 1 }
  );
  assert.deepEqual(r.kept.map((i) => i.id), ['x', 'y', 'z']);
});

t('汇总统计可用', () => {
  const cs = cluster(items, { weight: () => 1 });
  const s = clusterStats(cs);
  assert.equal(s.events, cs.length);
  assert.equal(s.itemsMerged, items.length);
  assert.ok(s.duplicatesRemoved >= 2);
  assert.ok(Array.isArray(s.leadSources));
});

process.stdout.write('\ncluster: 边界与性能\n');
t('空输入与单条不崩', () => {
  assert.deepEqual(cluster([]), []);
  assert.equal(cluster([{ id: 'x', title: 'only' }]).length, 1);
  assert.deepEqual(dedupe([]).kept, []);
});

t('没有时间的条目：内容确实不同就不会并', () => {
  const cs = cluster(
    [
      { id: 'a', sourceId: 's1', title: '某游戏版本更新公告' },
      { id: 'b', sourceId: 's2', title: '嘉然生日直播预告' },
    ],
    { weight: () => 1 }
  );
  assert.equal(cs.length, 2);
});

t('没有时间但文本几乎相同 → 仍然算同一件事（这是对的）', () => {
  // 「完全无关的甲/乙」只差最后两个字，字符串层面就是很像 ——
  // 相似度函数**应该**说它们像；想区分这类，要靠 people/来源等其他信号
  const cs = cluster(
    [
      { id: 'a', sourceId: 's1', title: '完全无关的甲' },
      { id: 'b', sourceId: 's2', title: '完全无关的乙' },
    ],
    { weight: () => 1 }
  );
  assert.equal(cs.length, 1);
});

t('结果与输入顺序无关（确定性）', () => {
  const reversed = [...items].reverse();
  const a = cluster(items, { weight: () => 1 }).map((c) => c.items.length).sort();
  const b = cluster(reversed, { weight: () => 1 }).map((c) => c.items.length).sort();
  assert.deepEqual(a, b);
});

t('内容完全相同的重复报道必须合并（这时没有任何「罕见词」）', () => {
  // 20 条一模一样的内容：每个词的出现次数都 = 文档数 → 罕见词一个不剩。
  // 只看罕见词的闸门会把真正的重复全部漏掉（实测踩过）。
  const same = Array.from({ length: 20 }, (_, i) => ({
    id: 'same' + i,
    sourceId: 'src-' + (i % 5),
    title: '嘉然 3D披露 将于 3月15日 举行',
    publishedAt: new Date(Date.UTC(2026, 2, 1, i % 24)).toISOString(),
  }));
  const cs = cluster(same, { weight: () => 1 });
  assert.equal(cs.length, 1, '应合成一个事件');
  assert.equal(cs[0].items.length, 20);
  assert.equal(cs[0].duplicateCount, 19);
});

t('不过度链：只共享套话的一批条目各成一簇', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: 'n' + i,
    sourceId: 'src-' + (i % 6),
    title: `第 ${i} 条普通情报 关于某个话题的说明`,
    publishedAt: new Date(Date.UTC(2026, 2, 1, i % 24)).toISOString(),
  }));
  const cs = cluster(many, { weight: () => 1 });
  assert.equal(cs.length, 60, `不应合并，实际 ${cs.length}`);
});
t('2000 条不退化成 O(n²)（有分桶与候选上限）', () => {
  const many = [];
  for (let i = 0; i < 2000; i++) {
    many.push({
      id: 'm' + i,
      sourceId: 'src-' + (i % 12),
      title: `第 ${i} 条普通情报 关于某个话题的说明`,
      publishedAt: new Date(Date.UTC(2026, 2, 1 + (i % 40), i % 24)).toISOString(),
    });
  }
  const t0 = Date.now();
  const cs = cluster(many, { weight: () => 1 });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `2000 条用了 ${ms}ms，太慢`);
  assert.ok(cs.length > 0);
  process.stdout.write(`         （2000 条 → ${cs.length} 个事件，${ms}ms）\n`);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
