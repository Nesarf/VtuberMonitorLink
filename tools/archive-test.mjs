// archive-test.mjs — SQLite 归档的自检 / self-test for the incremental archive
//
// 归档层有两个「安静地错」的大坑，必须钉死：
//   · **不幂等**：运行会重跑与补跑，重复写入会让图表数字凭空变大
//   · **参数拼接**：来源 id / 日期来自外部，拼 SQL 就是注入
// 另外验证：迁移能接上老库、按天补齐不出现断线、量大时不慢。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

process.stdout.write('\narchive: 建库与迁移\n');
t('建库后 user_version 是当前版本', () => {
  const db = openArchive({}, { file: dbPath });
  const v = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(v, SCHEMA_VERSION);
  db.close();
});

t('重复打开不会重复建表，且迁移可重入', () => {
  const db = openArchive({}, { file: dbPath });
  const r = migrate(db);
  assert.equal(r.from, SCHEMA_VERSION, '已是当前版本就不该再迁');
  assert.equal(r.to, SCHEMA_VERSION);
  db.close();
});

t('老库（user_version=0）能被迁移接上', () => {
  const oldPath = path.join(tmp, 'old.db');
  const raw = openArchive({}, { file: oldPath });
  raw.exec('PRAGMA user_version = 0'); // 模拟老库
  raw.exec('DROP TABLE IF EXISTS source_health'); // 模拟缺少新表
  raw.close();
  const db = openArchive({}, { file: oldPath });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM source_health').get());
  db.close();
});

process.stdout.write('\narchive: 增量与幂等\n');
const db = openArchive({}, { file: dbPath });

t('首次写入 N 条', () => {
  const r = ingestItems(db, mk(10, '2026-09-01'), { day: '2026-09-01' });
  assert.equal(r.inserted, 10);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.days, ['2026-09-01']);
});

t('同一天重跑（同一批）不会重复计数', () => {
  const r = ingestItems(db, mk(10, '2026-09-01'), { day: '2026-09-01' });
  assert.equal(r.inserted, 0, '全都应被忽略');
  assert.equal(r.skipped, 10);
  const row = db.prepare('SELECT items FROM daily WHERE day = ? AND source_id = ?').get('2026-09-01', 'src-a');
  assert.equal(Number(row.items), 10, 'daily 计数不能翻倍');
});

t('增量：新增 5 条只加 5', () => {
  const more = mk(15, '2026-09-01').slice(10);
  const r = ingestItems(db, more, { day: '2026-09-01' });
  assert.equal(r.inserted, 5);
  assert.equal(stats(db).items, 15);
});

t('空输入与缺 id 的条目不炸', () => {
  assert.deepEqual(ingestItems(db, [], { day: '2026-09-02' }).inserted, 0);
  const r = ingestItems(db, [{ title: '没有 id' }, null, undefined], { day: '2026-09-02' });
  assert.equal(r.inserted, 0);
});

t('发布日优先于运行日（跨天抓到的旧内容归到它自己的日期）', () => {
  assert.equal(dayOf({ publishedAt: '2026-08-30T12:00:00Z' }, '2026-09-01'), '2026-08-30');
  assert.equal(dayOf({}, '2026-09-01'), '2026-09-01');
  assert.equal(dayOf({ publishedAt: '不是时间' }, '2026-09-01'), '2026-09-01');
});

t('多来源分别计数', () => {
  ingestItems(db, mk(4, '2026-09-03', 'src-x'), { day: '2026-09-03' });
  ingestItems(db, mk(6, '2026-09-03', 'src-y'), { day: '2026-09-03' });
  const s = series(db, { days: 7, endDay: '2026-09-03' });
  const d3 = s.days.find((d) => d.day === '2026-09-03');
  assert.equal(d3.items, 10);
});

process.stdout.write('\narchive: 图表查询\n');
t('按天序列补齐空白日（图表不该断线）', () => {
  const s = series(db, { days: 5, endDay: '2026-09-03' });
  assert.equal(s.days.length, 5);
  assert.deepEqual(
    s.days.map((d) => d.day),
    ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']
  );
  assert.equal(s.days.find((d) => d.day === '2026-08-31').items, 0, '没跑的日子应为 0 而不是缺席');
});

t('按来源分组的序列与合计', () => {
  const s = series(db, { days: 7, endDay: '2026-09-03', groupBy: 'source' });
  assert.equal(s.totals[0].sourceId, 'src-a');
  assert.equal(s.totals[0].items, 15);
  // 注意：按来源分组时 days 只含**真有数据的日子**（稀疏视图，避免 30 天里塞 30 个空 map）
  assert.ok(s.days.length >= 2, '实际 ' + s.days.length);
  const d3 = s.days.find((d) => d.day === '2026-09-03');
  assert.equal(d3.sources['src-x'], 4);
  assert.equal(d3.sources['src-y'], 6);
  assert.equal(d3.items, 10, '每天的合计要对');
});

t('关注对象的活跃度序列', () => {
  ingestItems(db, mk(3, '2026-09-04', 'src-z', { people: ['jaran'] }), { day: '2026-09-04' });
  ingestItems(db, mk(2, '2026-09-04', 'src-z2', { people: ['jaran', 'rei'] }), { day: '2026-09-04' });
  const p = peopleSeries(db, { days: 7, endDay: '2026-09-04' });
  assert.equal(p.totals.find((x) => x.personId === 'jaran').items, 5);
  assert.equal(p.totals.find((x) => x.personId === 'rei').items, 2);
  assert.equal(p.byDay.jaran['2026-09-04'], 5);
});

t('关键词趋势', () => {
  ingestItems(db, mk(2, '2026-09-05', 'src-k', { keywords: ['3D披露'] }), { day: '2026-09-05' });
  const k = keywordSeries(db, { days: 7, endDay: '2026-09-05' });
  assert.equal(k.keywords[0].keyword, '3D披露');
  assert.equal(k.keywords[0].total, 2);
});

t('来源健康度：成功率与平均耗时', () => {
  for (let i = 0; i < 4; i++) recordHealth(db, { day: '2026-09-05', sourceId: 'src-a', ok: i < 3, ms: 100 + i * 10 });
  const h = healthSeries(db, { days: 7, endDay: '2026-09-05' });
  const a = h.sources.find((x) => x.sourceId === 'src-a');
  assert.equal(a.checks, 4);
  assert.equal(a.ok, 3);
  assert.equal(a.rate, 0.75);
  assert.equal(a.avgMs, 110);
});

t('运行记录写入', () => {
  recordRun(db, { runId: 'r1', day: '2026-09-05', mode: 'daily', sourcesOk: 2, sources: 3, items: 7, alerts: 1 });
  recordRun(db, { runId: 'r1', day: '2026-09-05', mode: 'daily', sourcesOk: 3, sources: 3, items: 7, alerts: 0 });
  const s = stats(db);
  assert.equal(s.runs, 1, '同一个 runId 应覆盖而不是新增');
});

process.stdout.write('\narchive: 查询安全与概况\n');
t('恶意来源 id 不会注入（参数化）', () => {
  const evil = "src-a'; DROP TABLE items; --";
  ingestItems(db, [{ id: 'evil-1', sourceId: evil, title: 'x' }], { day: '2026-09-06' });
  const s = series(db, { days: 7, endDay: '2026-09-06', groupBy: 'source' });
  assert.ok(s.totals.some((x) => x.sourceId === evil), '应该被当作普通字符串存下来');
  assert.ok(stats(db).items > 0, 'items 表必须还在');
});

t('恶意查询串不会注入', () => {
  const rows = queryItems(db, { q: "%' OR '1'='1" });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0, '当作普通字符串匹配，不该匹配到所有行');
});

t('按人查询用 LIKE 也能正确包含', () => {
  const rows = queryItems(db, { personId: 'jaran', limit: 50 });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.people.includes('jaran')));
});

t('分页参数被夹住（不能要 100 万条）', () => {
  const rows = queryItems(db, { limit: 10 ** 6 });
  assert.ok(rows.length <= 1000);
});

t('归档概况', () => {
  const s = stats(db);
  assert.ok(s.items >= 30, '实际 ' + s.items);
  assert.ok(s.firstDay <= s.lastDay);
  assert.ok(s.bySource.length > 0);
});

process.stdout.write('\narchive: 性能\n');
t('1000 条写入 + 查询在合理耗时内', () => {
  const t0 = Date.now();
  const big = Array.from({ length: 1000 }, (_, i) => ({
    id: 'big-' + i,
    sourceId: 'src-big-' + (i % 20),
    title: '批量条目 ' + i,
    publishedAt: new Date(Date.UTC(2026, 8, 10, i % 24)).toISOString(),
  }));
  ingestItems(db, big, { day: '2026-09-10' });
  const s = series(db, { days: 30, endDay: '2026-09-10', groupBy: 'source' });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `用了 ${ms}ms`);
  assert.equal(s.totals.reduce((n, x) => n + x.items, 0) >= 1000, true, '合计应包含那 1000 条');
  process.stdout.write(`         （1000 条 + 30 天聚合 ${ms}ms）\n`);
});

db.close();

t('库文件确实落在磁盘上', () => {
  assert.ok(fs.existsSync(dbPath));
  assert.ok(fs.statSync(dbPath).size > 0);
});

t('archivePath 跟随配置的 feedsDir', () => {
  const p = archivePath({ paths: { feedsDir: tmp } });
  assert.ok(p.startsWith(tmp));
  assert.ok(p.endsWith('archive.db'));
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
