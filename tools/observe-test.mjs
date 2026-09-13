// observe-test.mjs — self-test for observation mode / sampling, jitter and egress rules
//
// The whole value of this mode lies in "the pattern itself": how fair and unpredictable the sampling is,
// the range of the jitter, and the criteria for egress assignment. None of this should be taken on faith
// by reading the code - it gets pinned down with a **fixed random source**.
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

/** Fixed random source: makes "random" reproducible in tests */
const seeded = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

process.stdout.write('\nobserve: log ownership and egress\n');

t("an agency's own site vs a platform: decided by the domain", () => {
  assert.equal(logOwnerOf({ url: 'https://hololivepro.com/talents/' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://www.anycolor.co.jp/news' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://vspo.jp/' }), 'agency');
  assert.equal(logOwnerOf({ url: 'https://api.bilibili.com/x/…' }), 'platform');
  assert.equal(logOwnerOf({ url: 'https://www.reddit.com/r/VirtualYoutubers/.rss' }), 'platform');
  assert.equal(logOwnerOf({ url: 'not a url' }), 'platform', 'unrecognized counts as platform (better to use Tor less often)');
  assert.equal(urlHost('https://HoloLivePro.com/x'), 'hololivepro.com', 'domains must be lowercased and normalized');
});

t('observation mode: agency sites go through Tor, platforms keep their own egress setting', () => {
  const cfg = { observation: { enabled: true } };
  assert.equal(resolveEgress({ url: 'https://cover-corp.com/', id: 'official-cover' }, cfg).mode, 'tor');
  assert.equal(resolveEgress({ url: 'https://api.bilibili.com/x/y', id: 'bili' }, cfg), null, 'a platform source must not have its egress forced');
});

t('a source that pinned its own egress keeps it (the per-source override)', () => {
  const cfg = { observation: { enabled: true } };
  assert.equal(resolveEgress({ url: 'https://api.bilibili.com/x/y', proxy: 'tor' }, cfg).mode, 'tor');
  assert.equal(resolveEgress({ url: 'https://cover-corp.com/', proxy: 'direct' }, cfg).mode, 'direct');
});

t('observation mode does NOT run sources that need a login, and gives the reason', () => {
  const cfg = { observation: { enabled: true } };
  const r = resolveEgress({ url: 'https://api.bilibili.com/x/y', login: 'required' }, cfg);
  assert.equal(r.skip, true, JSON.stringify(r));
  // the reason string is diagnostic output (it reaches logs, not the UI), so it is English
  assert.match(r.reason, /login required/);
  assert.equal(isLoginRequired({ login: 'optional' }), false, 'optional does not count: that means it is viewable without logging in');
  // With observation mode off, login-state sources stay as before (the source's own setting decides)
  assert.equal(resolveEgress({ url: 'https://x.com/', login: 'required' }, { observation: { enabled: false } }), null);
});

process.stdout.write('\nobserve: sampling\n');

t('takes k = ratio x n, never more than the total', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i }));
  const r = pickSample(items, { ratio: 0.5, min: 1, rng: seeded(1) });
  assert.equal(r.k, 5);
  assert.equal(r.picked.length, 5);
  assert.equal(r.skipped.length, 5);
  const all = pickSample(items, { ratio: 1, rng: seeded(1) });
  assert.equal(all.k, 10, 'a ratio of 1 takes everything');
  assert.equal(all.skipped.length, 0);
});

t('the minimum sample count is respected (a small set is not cut down to a single pick)', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i }));
  const r = pickSample(items, { ratio: 0.2, min: 3, rng: seeded(7) });
  assert.equal(r.k, 3);
});

t('rotation fairness: whatever has gone unseen longest is picked first, and everyone is seen within a few rounds', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i }));
  let history = {};
  const seen = new Set();
  for (let round = 0; round < 8; round++) {
    const r = pickSample(items, { ratio: 0.34, min: 2, history, rng: seeded(round + 20) });
    r.picked.forEach((x) => seen.add(x.id));
    history = recordPicked({ rounds: round, lastPicked: history }, r.picked.map((x) => x.id), new Date(2026, 0, 1 + round)).lastPicked;
  }
  assert.equal(seen.size, 6, 'after 8 rounds all 6 objects should have been picked, actual ' + [...seen].join(','));
});

t('unpredictable: same history, different random source -> a different picked set', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i }));
  const history = {};
  const a = pickSample(items, { ratio: 0.5, history, rng: seeded(1) }).picked.map((x) => x.id).sort();
  const b = pickSample(items, { ratio: 0.5, history, rng: seeded(99) }).picked.map((x) => x.id).sort();
  assert.notDeepEqual(a, b, 'pure LRU would pick the same batch every round, and that is not sampling');
});

t('the order is shuffled too (a fixed order is itself a fingerprint)', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: 's' + i }));
  const picks = new Set();
  for (let s = 1; s <= 5; s++) picks.add(pickSample(items, { ratio: 0.6, min: 1, rng: seeded(s) }).picked.map((x) => x.id).join(','));
  assert.ok(picks.size > 1, 'the order should not come out identical across repeated samples');
});

process.stdout.write('\nobserve: jitter\n');

t('the jitter stays within [max(base,min), max], and an explicit base of 0 stays 0', () => {
  const rng = seeded(5);
  for (let i = 0; i < 50; i++) {
    const g = gapWithJitter(2, [2, 9], rng);
    assert.ok(g >= 2 && g <= 9, 'actual ' + g);
  }
  // base=0 is the explicit way of saying "do not wait": the diagnostic path uses it to skip rate-limit
  // waiting, and the jitter must not put that wait back
  assert.equal(gapWithJitter(0, [2, 9], rng), 0);
  // When base is larger than the lower bound of the range, it must not end up waiting less
  const big = gapWithJitter(40, [2, 9], rng);
  assert.ok(big >= 40, 'actual ' + big);
});

t('proportional jitter: floats above and below base, never goes negative', () => {
  const rng = seeded(11);
  for (let i = 0; i < 50; i++) {
    const g = gapWithJitter(10, { spread: 0.5 }, rng);
    assert.ok(g >= 5 && g <= 15, 'actual ' + g);
  }
});

process.stdout.write('\nobserve: one round plan\n');

t('with observation mode off everything stays as before (no sampling, no egress change)', () => {
  const sources = [{ id: 'a', url: 'https://api.bilibili.com/x' }, { id: 'b', url: 'https://cover-corp.com/' }];
  const plan = observationPlan({ cfg: { observation: { enabled: false } }, sources, watchTargets: [{ id: 'w1' }] });
  assert.equal(plan.enabled, false);
  assert.equal(plan.sources.length, 2);
  assert.equal(plan.watchTargets.length, 1);
  assert.deepEqual(plan.egress, {});
});

t('with observation mode on: it samples a subset, agency sites move to Tor, and login-gated sources are dropped with a reason', () => {
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
  assert.equal(plan.sources.length, 3, 'half of the 6 (after the login-state one is dropped first, 5 remain and 3 are picked)');
  assert.ok(plan.skippedLogin.some((x) => x.id === 'bili-dynamic-login'), 'the login-state source should be dropped');
  assert.ok(!plan.sources.some((x) => x.id === 'bili-dynamic-login'));
  assert.ok(plan.egress['official-hololive'] === 'tor' || plan.sampling.tor.length >= 0);
  for (const s of plan.sources) {
    if (logOwnerOf(s) === 'agency') assert.equal(s.proxy, 'tor', s.id + ' is agency self-hosted, so it should use Tor');
    else assert.ok(s.proxy !== 'tor', s.id + ' is a platform source, its egress must not be forced to Tor');
  }
  assert.equal(plan.watchTargets.length, 3, 'watch targets go through the same sampling');
  assert.equal(plan.sampling.sources.n, 5, 'n must reflect the candidate count after dropping login-state sources');
  assert.deepEqual(plan.sampling.sources.skipped.length, 2);
  // sampling.tor should list only the ones **actually requested this round** (not picked in egress does not count)
  assert.deepEqual(
    plan.sampling.tor.slice().sort(),
    plan.sources.filter((s) => s.proxy === 'tor').map((s) => s.id).sort(),
    'the tor list must agree with the sources actually picked this round',
  );
});

t('when Tor is down: the sources that need Tor are skipped this round, and the reason says it is not counted as a failure', () => {
  const cfg = { observation: { enabled: true, sampleRatio: 1, minSources: 1, torForAgency: true } };
  const sources = [
    { id: 'official-hololive', url: 'https://hololivepro.com/talents/' },
    { id: 'bili-opus-jaran', url: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=1' },
  ];
  const down = observationPlan({ cfg, sources, rng: seeded(2), torReachable: false });
  assert.deepEqual(down.sampling.skippedTor, ['official-hololive'], JSON.stringify(down.sampling));
  assert.ok(!down.sources.some((s) => s.id === 'official-hololive'), 'if Tor is down it must not be scheduled into this round');
  assert.ok(down.sources.some((s) => s.id === 'bili-opus-jaran'), 'platform sources are unaffected');
  assert.match(down.skippedTor[0].reason, /not counted as a source failure/);

  // When Tor is reachable, go through Tor as usual
  const up = observationPlan({ cfg, sources, rng: seeded(2), torReachable: true });
  const picked = up.sources.find((s) => s.id === 'official-hololive');
  assert.equal(picked?.proxy, 'tor');
  assert.deepEqual(up.sampling.skippedTor, []);
});

t('rotation state is recorded and read back (the next round prefers what has not been seen yet)', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: 's' + i }));
  const st = recordPicked({ rounds: 0, lastPicked: {} }, ['s0', 's1'], new Date('2026-01-01T00:00:00Z'));
  assert.equal(st.rounds, 1);
  assert.equal(st.lastPicked.s0, '2026-01-01T00:00:00.000Z');
  const r = pickSample(items, { ratio: 0.5, min: 1, history: st.lastPicked, rng: seeded(4) });
  const ids = r.picked.map((x) => x.id);
  assert.ok(!ids.includes('s0') || !ids.includes('s1'), 'the two just seen should not both be picked again: ' + ids.join(','));
});

t('every domain in the AGENCY_HOSTS list is recognized (guards against a typo in a domain)', () => {
  for (const h of AGENCY_HOSTS) {
    assert.equal(logOwnerOf({ url: `https://${h}/` }), 'agency', h);
  }
});

t('reading rotation state: a missing file yields an empty state instead of throwing', () => {
  const st = loadObservationState({ paths: { logsDir: 'E:\\No\\Such\\Dir\\vml-test' } }); // sanitize-allow: a synthetic path that must not exist
  assert.deepEqual(st, { rounds: 0, lastPicked: {} });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
