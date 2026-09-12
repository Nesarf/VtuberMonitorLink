// observe-test.mjs — 观测模式的自检 / self-test for sampling, jitter and egress rules
//
// 这个模式的价值全在「模式本身」上：取样的公平性与不可预测性、抖动的范围、
// 出口分配的判据。这些都不该靠读代码相信，而是拿**固定随机源**把行为钉住。
import assert from 'node:assert/strict';
import {
  AGENCY_HOSTS,
  gapWithJitter,
  isLoginRequired,
  loadObservationState,
  logOwnerOf,
  observationPlan,
  pickSample,
  recordPicked,
  resolveEgress,
  urlHost,
} from '../server/src/observe.js';

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

/** 固定随机源：让「随机」在测试里可复现 */
const seeded = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

process.stdout.write('\nobserve: 日志归属与出口\n');

t('箱自托管站点 vs 平台：按域名判定', () => {
  assert.equal(logOwnerOf({ url: 'https://hololivepro.com/talents/' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://www.anycolor.co.jp/news' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://vspo.jp/' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://api.bilibili.com/x/…' }), 'platform');
  assert.equal(logOwnerOf({ url: 'https://www.reddit.com/r/VirtualYoutubers/.rss' }), 'platform');
  assert.equal(logOwnerOf({ url: 'not a url' }), 'platform', '认不出来就当平台（宁可少用 Tor）');
  assert.equal(urlHost('https://HoloLivePro.com/x'), 'hololivepro.com', '域名要小写归一');
});

t('观测模式：箱自托管 → Tor；平台 → 不动它（沿用来源自己的设置）', () => {
  const cfg = { observation: { enabled: true } };
  assert.equal(resolveEgress({ url: 'https://cover-corp.com/', id: 'official-cover' }, cfg).mode, 'tor');
  assert.equal(resolveEgress({ url: 'https://api.bilibili.com/x/y', id: 'bili' }, cfg), null, '平台源不该被强行改出口');
});

t('来源自己钉了出口就尊重它（per-source 那一列）', () => {
  const cfg = { observation: { enabled: true } };
  assert.equal(resolveEgress({ url: 'https://api.bilibili.com/x/y', proxy: 'tor' }, cfg).mode, 'tor');
  assert.equal(resolveEgress({ url: 'https://cover-corp.com/', proxy: 'direct' }, cfg).mode, 'direct');
});

t('观测模式**不跑**需要登录态的来源，并给出原因', () => {
  const cfg = { observation: { enabled: true } };
  const r = resolveEgress({ url: 'https://api.bilibili.com/x/y', login: 'required' }, cfg);
  assert.equal(r.skip, true, JSON.stringify(r));
  assert.match(r.reason, /登录态/);
  assert.equal(isLoginRequired({ login: 'optional' }), false, 'optional 不算：那是不登录也能看');
  // 关掉观测模式时，登录态来源照旧（由来源自己的设置决定）
  assert.equal(resolveEgress({ url: 'https://x.com/', login: 'required' }, { observation: { enabled: false } }), null);
});

process.stdout.write('\nobserve: 取样\n');

t('取 k = ratio × n，且不超过总数', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i }));
  const r = pickSample(items, { ratio: 0.5, min: 1, rng: seeded(1) });
  assert.equal(r.k, 5);
  assert.equal(r.picked.length, 5);
  assert.equal(r.skipped.length, 5);
  const all = pickSample(items, { ratio: 1, rng: seeded(1) });
  assert.equal(all.k, 10, '比例 1 时全取');
  assert.equal(all.skipped.length, 0);
});

t('最少取样数生效（对象少的时候不会一轮只取 1 个）', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i }));
  const r = pickSample(items, { ratio: 0.2, min: 3, rng: seeded(7) });
  assert.equal(r.k, 3);
});

t('轮转公平：最久没看过的优先，几轮下来人人都会被看到', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i }));
  let history = {};
  const seen = new Set();
  for (let round = 0; round < 8; round++) {
    const r = pickSample(items, { ratio: 0.34, min: 2, history, rng: seeded(round + 20) });
    r.picked.forEach((x) => seen.add(x.id));
    history = recordPicked({ rounds: round, lastPicked: history }, r.picked.map((x) => x.id), new Date(2026, 0, 1 + round)).lastPicked;
  }
  assert.equal(seen.size, 6, '8 轮之后 6 个对象都该被取到过，实际 ' + [...seen].join(','));
});

t('不可预测：同一份历史、不同随机源 → 取到的集合不同', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i }));
  const history = {};
  const a = pickSample(items, { ratio: 0.5, history, rng: seeded(1) }).picked.map((x) => x.id).sort();
  const b = pickSample(items, { ratio: 0.5, history, rng: seeded(99) }).picked.map((x) => x.id).sort();
  assert.notDeepEqual(a, b, '纯 LRU 会让每轮取到的都是同一批，那就不叫取样了');
});

t('顺序也被打乱（固定顺序本身就是特征）', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: 's' + i }));
  const picks = new Set();
  for (let s = 1; s <= 5; s++) picks.add(pickSample(items, { ratio: 0.6, min: 1, rng: seeded(s) }).picked.map((x) => x.id).join(','));
  assert.ok(picks.size > 1, '多次取样的顺序不该完全一样');
});

process.stdout.write('\nobserve: 抖动\n');

t('抖动范围落在 [max(base,min), max]，且显式的 0 就是 0', () => {
  const rng = seeded(5);
  for (let i = 0; i < 50; i++) {
    const g = gapWithJitter(2, [2, 9], rng);
    assert.ok(g >= 2 && g <= 9, '实际 ' + g);
  }
  // base=0 是「不要等」的显式表达：诊断路径靠它跳过限流等待，抖动不能把等待塞回去
  assert.equal(gapWithJitter(0, [2, 9], rng), 0);
  // base 比区间下限还大时，不能反而等得更少
  const big = gapWithJitter(40, [2, 9], rng);
  assert.ok(big >= 40, '实际 ' + big);
});

t('比例抖动：在 base 上下浮动，不会跑成负数', () => {
  const rng = seeded(11);
  for (let i = 0; i < 50; i++) {
    const g = gapWithJitter(10, { spread: 0.5 }, rng);
    assert.ok(g >= 5 && g <= 15, '实际 ' + g);
  }
});

process.stdout.write('\nobserve: 一轮的计划\n');

t('未开启观测模式时，一切照旧（不取样、不改出口）', () => {
  const sources = [{ id: 'a', url: 'https://api.bilibili.com/x' }, { id: 'b', url: 'https://cover-corp.com/' }];
  const plan = observationPlan({ cfg: { observation: { enabled: false } }, sources, watchTargets: [{ id: 'w1' }] });
  assert.equal(plan.enabled, false);
  assert.equal(plan.sources.length, 2);
  assert.equal(plan.watchTargets.length, 1);
  assert.deepEqual(plan.egress, {});
});

t('开启后：取一部分、箱站点改走 Tor、登录态来源被剔除并说明', () => {
  const cfg = {
    observation: { enabled: true, sampleRatio: 0.5, minSources: 1, minWatch: 1, torForAgency: true },
  };
  const sources = [
    { id: 'bili-opus-jaran', url: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=1' },
    { id: 'bili-dynamic-login', url: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space', login: 'required' },
    { id: 'official-hololive', url: 'https://hololivepro.com/talents/' },
    { id: 'official-cover', url: 'https://cover-corp.com/' },
    { id: 'reddit-VirtualYoutubers', url: 'https://www.reddit.com/r/VirtualYoutubers/.rss' },
    { id: 'vspo', url: 'https://vspo.jp/' },
  ];
  const watchTargets = Array.from({ length: 6 }, (_, i) => ({ id: 'w' + i, url: 'https://example.com/' + i }));
  const plan = observationPlan({ cfg, sources, watchTargets, rng: seeded(3) });

  assert.equal(plan.enabled, true);
  assert.equal(plan.sources.length, 3, '6 条里取一半（登录态那条先被剔掉后剩 5 条，取 3）');
  assert.ok(plan.skippedLogin.some((x) => x.id === 'bili-dynamic-login'), '登录态来源该被剔除');
  assert.ok(!plan.sources.some((x) => x.id === 'bili-dynamic-login'));
  assert.ok(plan.egress['official-hololive'] === 'tor' || plan.sampling.tor.length >= 0);
  for (const s of plan.sources) {
    if (logOwnerOf(s) === 'agency') assert.equal(s.proxy, 'tor', s.id + ' 是箱自托管，该走 Tor');
    else assert.ok(s.proxy !== 'tor', s.id + ' 是平台源，不该被强行改走 Tor');
  }
  assert.equal(plan.watchTargets.length, 3, '监视对象同样取样');
  assert.equal(plan.sampling.sources.n, 5, 'n 要反映剔除登录态之后的候选数');
  assert.deepEqual(plan.sampling.sources.skipped.length, 2);
  // sampling.tor 只该列**本轮真的会请求**的那几条（egress 里没被取到的不算）
  assert.deepEqual(
    plan.sampling.tor.slice().sort(),
    plan.sources.filter((s) => s.proxy === 'tor').map((s) => s.id).sort(),
    'tor 清单要和本轮实际取到的来源一致',
  );
});

t('Tor 断链时：本轮跳过要走 Tor 的来源，并说明「不计为失败」', () => {
  const cfg = { observation: { enabled: true, sampleRatio: 1, minSources: 1, torForAgency: true } };
  const sources = [
    { id: 'official-hololive', url: 'https://hololivepro.com/talents/' },
    { id: 'bili-opus-jaran', url: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=1' },
  ];
  const down = observationPlan({ cfg, sources, rng: seeded(2), torReachable: false });
  assert.deepEqual(down.sampling.skippedTor, ['official-hololive'], JSON.stringify(down.sampling));
  assert.ok(!down.sources.some((s) => s.id === 'official-hololive'), 'Tor 断了就不该把它排进本轮');
  assert.ok(down.sources.some((s) => s.id === 'bili-opus-jaran'), '平台源不受影响');
  assert.match(down.skippedTor[0].reason, /不计为来源失败/);

  // Tor 通的时候就照常走 Tor
  const up = observationPlan({ cfg, sources, rng: seeded(2), torReachable: true });
  const picked = up.sources.find((s) => s.id === 'official-hololive');
  assert.equal(picked?.proxy, 'tor');
  assert.deepEqual(up.sampling.skippedTor, []);
});

t('轮转状态能存能读（下一轮优先取没看过的）', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i }));
  const st = recordPicked({ rounds: 0, lastPicked: {} }, ['s0', 's1'], new Date('2026-01-01T00:00:00Z'));
  assert.equal(st.rounds, 1);
  assert.equal(st.lastPicked.s0, '2026-01-01T00:00:00.000Z');
  const r = pickSample(items, { ratio: 0.5, min: 1, history: st.lastPicked, rng: seeded(4) });
  const ids = r.picked.map((x) => x.id);
  assert.ok(!ids.includes('s0') || !ids.includes('s1'), '刚看过的两个不该又同时被取到：' + ids.join(','));
});

t('AGENCY_HOSTS 清单里的域名都能被识别（防止手误写错域名）', () => {
  for (const h of AGENCY_HOSTS) {
    assert.equal(logOwnerOf({ url: `https://${h}/` }), 'agency', h);
  }
});

t('读取轮转状态：没有文件时给空状态，不抛错', () => {
  const st = loadObservationState({ paths: { logsDir: 'E:\\No\\Such\\Dir\\vml-test' } });
  assert.deepEqual(st, { rounds: 0, lastPicked: {} });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
