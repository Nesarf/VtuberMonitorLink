// fetchplan-test.mjs — 抓取调度策略的自检
// 分组并行 / 失败隔离 / 降级阶梯：全是纯函数，拿固定时间与固定失败序列把行为钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchAll } from '../server/src/fetchers/index.js';
import {
  QUARANTINE_DEFAULTS,
  fetchLadder,
  loadQuarantine,
  planFetch,
  quarantineOf,
  recordOutcome,
  saveQuarantine,
} from '../server/src/fetchplan.js';

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

const at = (mins) => new Date(Date.UTC(2026, 0, 1, 0, 0) + mins * 60000);

process.stdout.write('\nfetchplan: 按出口分组\n');

t('按出口分组：同组保持原顺序，组之间不重叠也不丢', () => {
  const sources = [
    { id: 'a', fetch: 'rss' },
    { id: 'b', fetch: 'browser' },
    { id: 'c', fetch: 'rss' },
    { id: 'd', fetch: 'bili-opus' },
  ];
  const mode = (s) => ({ a: 'direct', b: 'tor', c: 'direct', d: 'direct' })[s.id];
  const plan = planFetch(sources, mode);
  assert.deepEqual(
    plan.groups.map((g) => g.mode),
    ['direct', 'tor'],
    '组顺序应稳定（direct 在前）',
  );
  assert.deepEqual(plan.groups[0].sources.map((s) => s.id), ['a', 'c', 'd'], '同组内保持输入顺序');
  assert.deepEqual(plan.groups[1].sources.map((s) => s.id), ['b']);
  const all = plan.groups.flatMap((g) => g.sources.map((s) => s.id)).sort();
  assert.deepEqual(all, ['a', 'b', 'c', 'd'], '不能丢来源');
});

t('未指定出口时归入 direct（而不是消失）', () => {
  const plan = planFetch([{ id: 'x', fetch: 'rss' }], () => undefined);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].mode, 'direct');
  assert.equal(plan.groups[0].sources.length, 1);
});

process.stdout.write('\nfetchplan: 连续失败隔离\n');

t('连续失败到阈值才隔离，成功后清零', () => {
  let st = { sources: {} };
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(0) });
  assert.equal(quarantineOf(st, 's1', { now: at(1) }), null, '第 1 次失败不该隔离');
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(1) });
  assert.equal(quarantineOf(st, 's1', { now: at(2) }), null, '第 2 次失败不该隔离');
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(2) });
  const q = quarantineOf(st, 's1', { now: at(3) });
  assert.ok(q, '第 3 次失败应当隔离');
  assert.equal(q.failures, 3);
  // 钉「隔离时长」而不是推导出来的分钟数（那是 Math.ceil 的结果，容易被自己的算术骗到）
  assert.equal(Date.parse(q.until) - at(2).getTime(), 6 * 3600000, '默认隔离 6 小时');
  assert.equal(q.minutesLeft, Math.ceil((Date.parse(q.until) - at(3).getTime()) / 60000));

  // 成功一次就清零
  const cleared = recordOutcome(st, 's1', { ok: true, now: at(4) });
  assert.equal(quarantineOf(cleared, 's1', { now: at(5) }), null);
});

t('隔离会自动过期（不是永久拉黑）', () => {
  let st = { sources: {} };
  for (let i = 0; i < 3; i++) st = recordOutcome(st, 's2', { ok: false, now: at(i) });
  assert.ok(quarantineOf(st, 's2', { now: at(10) }), '10 分钟内仍隔离');
  assert.equal(quarantineOf(st, 's2', { now: at(6 * 60 + 10) }), null, '6 小时后应当自动解除');
});

t('隔离期间再失败一次，不会把截止时间无限延长', () => {
  let st = { sources: {} };
  for (let i = 0; i < 3; i++) st = recordOutcome(st, 's3', { ok: false, now: at(0) });
  const until = st.sources.s3.until;
  st = recordOutcome(st, 's3', { ok: false, now: at(30) });
  assert.equal(st.sources.s3.until, until, '截止时间应保持不变（否则失败越多锁越久）');
});

t('自定义规则：2 次就隔离、隔离 1 小时', () => {
  const rules = { failures: 2, hours: 1 };
  let st = { sources: {} };
  st = recordOutcome(st, 's4', { ok: false, now: at(0), rules });
  assert.equal(quarantineOf(st, 's4', { now: at(1), rules }), null);
  st = recordOutcome(st, 's4', { ok: false, now: at(1), rules });
  const q2 = quarantineOf(st, 's4', { now: at(2), rules });
  assert.ok(q2);
  assert.equal(Date.parse(q2.until) - at(1).getTime(), 3600000, '自定义隔离 1 小时');
  assert.equal(q2.rule.hours, 1);
});

t('被隔离的来源进 skipped 并带上原因，且不再排进任何组', () => {
  let st = { sources: {} };
  for (let i = 0; i < 3; i++) st = recordOutcome(st, 'bad', { ok: false, error: 'ECONNRESET', now: at(i) });
  const sources = [
    { id: 'bad', fetch: 'browser' },
    { id: 'good', fetch: 'rss' },
  ];
  const plan = planFetch(sources, () => 'direct', { now: at(5), quarantine: st });
  assert.deepEqual(plan.groups.flatMap((g) => g.sources.map((s) => s.id)), ['good']);
  assert.equal(plan.quarantined.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].error, /隔离至/);
  assert.match(plan.skipped[0].error, /ECONNRESET|连续失败/);
});

t('隔离状态能存能读（坏文件当空状态，不抛错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-quar-'));
  const cfg = { paths: { logsDir: dir } };
  let st = { sources: {} };
  st = recordOutcome(st, 'x', { ok: false, now: at(0) });
  saveQuarantine(cfg, st);
  const back = loadQuarantine(cfg);
  assert.equal(back.sources.x.failures, 1);
  fs.writeFileSync(path.join(dir, 'quarantine.json'), '{ broken', 'utf8');
  assert.deepEqual(loadQuarantine(cfg), { sources: {} }, '坏文件要能容错');
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write('\nfetchplan: 降级阶梯\n');

t('内置阶梯：只放站得住脚的转换', () => {
  assert.deepEqual(fetchLadder({ fetch: 'mediawiki-api' }).map((s) => s.fetch), ['browser']);
  assert.deepEqual(fetchLadder({ fetch: 'rss' }).map((s) => s.fetch), ['browser']);
  assert.deepEqual(fetchLadder({ fetch: 'bili-opus' }), [], '免登录动态没有可替代方式（不能自动升级成需登录的那个）');
  assert.deepEqual(fetchLadder({ fetch: 'browser' }), []);
});

t('来源可以自己声明 fallbacks，且优先于内置阶梯', () => {
  const s = { fetch: 'browser', fallbacks: ['rss', { fetch: 'mediawiki-api' }] };
  assert.deepEqual(fetchLadder(s).map((x) => x.fetch), ['rss', 'mediawiki-api']);
});

t('阶梯去重，也不会把自己排进去（防止死循环）', () => {
  const s = { fetch: 'rss', fallbacks: ['rss', 'browser', 'browser'] };
  const ladder = fetchLadder(s);
  assert.deepEqual(ladder.map((x) => x.fetch), ['browser'], '自己与重复项都要去掉');
  const dup = { fetch: 'mediawiki-api', fallbacks: ['browser'] };
  assert.deepEqual(fetchLadder(dup).map((x) => x.fetch), ['browser'], '内置与自声明重复时只留一个');
});

t('默认隔离规则是「3 次 / 6 小时」（写在这里，免得以后被悄悄改掉）', () => {
  assert.deepEqual(QUARANTINE_DEFAULTS, { failures: 3, hours: 6 });
});

process.stdout.write('\nfetchplan: 接进 fetchAll 之后的实际行为\n');

/** 用测试接缝替换抓取方式，跑真实的 fetchAll（时间与调用顺序都能断言） */
async function runFetchAll(sources, { table, cfg: cfgOverride = {}, log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-fetch-'));
  const cfg = {
    paths: { logsDir: dir },
    run: { defaultGapSeconds: 0, quarantine: { failures: 3, hours: 6 } },
    proxy: { enabled: false, mode: 'http', url: '', torSocks: 'socks5://127.0.0.1:9150' },
    ...cfgOverride,
  };
  try {
    const out = await fetchAll(sources, { cfg, log: log ?? { info() {}, warn() {}, error() {} }, fetchTable: table });
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await t('队间并行、队内串行（同一个出口不并发，不同出口不互相等）', async () => {
  const events = [];
  const mk = () => async (src) => {
    events.push(`start:${src.id}`);
    await new Promise((r) => setTimeout(r, 150));
    events.push(`end:${src.id}`);
    return { ok: true, items: [{ id: src.id }] };
  };
  const table = { rss: mk() };
  const sources = [
    { id: 'd1', fetch: 'rss', proxy: 'direct' },
    { id: 'd2', fetch: 'rss', proxy: 'direct' },
    { id: 't1', fetch: 'rss', proxy: 'tor' },
  ];
  const out = await runFetchAll(sources, { table });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.source.id), ['d1', 'd2', 't1'], '结果要回到输入顺序');
  assert.ok(events.indexOf('end:d1') < events.indexOf('start:d2'), '同队必须串行: ' + events.join(' '));
  assert.ok(events.indexOf('start:t1') < events.indexOf('end:d1'), '不同队应当并行: ' + events.join(' '));
});

await t('降级阶梯：RSS 失败后自动改用 browser，并记下用了哪一步', async () => {
  const calls = [];
  const table = {
    rss: async (src) => {
      calls.push(`rss:${src.id}`);
      return { ok: false, error: 'feed 404' };
    },
    browser: async (src) => {
      calls.push(`browser:${src.id}`);
      return { ok: true, items: [{ id: 'x' }] };
    },
  };
  const ladderOut = await runFetchAll([{ id: 's1', fetch: 'rss', proxy: 'direct' }], { table });
  assert.deepEqual(calls, ['rss:s1', 'browser:s1'], '应当按阶梯依次尝试: ' + calls.join(','));
  assert.equal(ladderOut[0].ok, true);
  assert.deepEqual(ladderOut[0].ladder, { from: 'rss', to: 'browser', firstError: 'feed 404' });
});

await t('连续失败到阈值后，下一轮不再请求这条来源（并在结果里说明）', async () => {
  const calls = [];
  const table = {
    rss: async (src) => {
      calls.push(src.id);
      return { ok: false, error: 'ECONNRESET' };
    },
  };
  const sources = [{ id: 'flaky', fetch: 'rss', proxy: 'direct' }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-fetch-'));
  const cfg = {
    paths: { logsDir: dir },
    run: { defaultGapSeconds: 0, quarantine: { failures: 3, hours: 6 } },
    proxy: { enabled: false },
  };
  for (let i = 0; i < 3; i++) {
    await fetchAll(sources, { cfg, log: { info() {}, warn() {}, error() {} }, fetchTable: table });
  }
  assert.equal(calls.length, 3, '前三次都该真的去抓（每次失败一次）');
  const fourth = await fetchAll(sources, { cfg, log: { info() {}, warn() {}, error() {} }, fetchTable: table });
  assert.equal(calls.length, 3, '第四次不该再发请求');
  assert.equal(fourth[0].skipped, 'quarantined');
  assert.match(fourth[0].error, /隔离至/);
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
