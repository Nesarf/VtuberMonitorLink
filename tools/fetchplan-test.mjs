// fetchplan-test.mjs — self-test for the fetch scheduling policy
// Grouped parallelism / failure isolation / degradation ladder: all pure functions, pinned down
// with fixed times and a fixed failure sequence.
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

process.stdout.write('\nfetchplan: grouping by egress\n');

t('grouping by egress: each group keeps the input order, and the groups neither overlap nor drop sources', () => {
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
    'group order should be stable (direct first)',
  );
  assert.deepEqual(plan.groups[0].sources.map((s) => s.id), ['a', 'c', 'd'], 'input order is kept inside a group');
  assert.deepEqual(plan.groups[1].sources.map((s) => s.id), ['b']);
  const all = plan.groups.flatMap((g) => g.sources.map((s) => s.id)).sort();
  assert.deepEqual(all, ['a', 'b', 'c', 'd'], 'no source may be lost');
});

t('a source with no egress ends up in direct (rather than vanishing)', () => {
  const plan = planFetch([{ id: 'x', fetch: 'rss' }], () => undefined);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].mode, 'direct');
  assert.equal(plan.groups[0].sources.length, 1);
});

process.stdout.write('\nfetchplan: consecutive-failure quarantine\n');

t('quarantine only after the threshold, and one success clears it', () => {
  let st = { sources: {} };
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(0) });
  assert.equal(quarantineOf(st, 's1', { now: at(1) }), null, 'failure 1 should not quarantine');
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(1) });
  assert.equal(quarantineOf(st, 's1', { now: at(2) }), null, 'failure 2 should not quarantine');
  st = recordOutcome(st, 's1', { ok: false, error: 'timeout', now: at(2) });
  const q = quarantineOf(st, 's1', { now: at(3) });
  assert.ok(q, 'failure 3 should quarantine');
  assert.equal(q.failures, 3);
  // Pin the "quarantine duration" rather than the derived minute count (that is a Math.ceil
  // result, and it is easy to fool yourself with your own arithmetic)
  assert.equal(Date.parse(q.until) - at(2).getTime(), 6 * 3600000, 'default quarantine is 6 hours');
  assert.equal(q.minutesLeft, Math.ceil((Date.parse(q.until) - at(3).getTime()) / 60000));

  // one success clears it
  const cleared = recordOutcome(st, 's1', { ok: true, now: at(4) });
  assert.equal(quarantineOf(cleared, 's1', { now: at(5) }), null);
});

t('the quarantine expires on its own (it is not a permanent blacklist)', () => {
  let st = { sources: {} };
  for (let i = 0; i < 3; i++) st = recordOutcome(st, 's2', { ok: false, now: at(i) });
  assert.ok(quarantineOf(st, 's2', { now: at(10) }), 'still quarantined at 10 minutes');
  assert.equal(quarantineOf(st, 's2', { now: at(6 * 60 + 10) }), null, 'it should lift by itself after 6 hours');
});

t('failing again during the quarantine does not extend the deadline indefinitely', () => {
  let st = { sources: {} };
  for (let i = 0; i < 3; i++) st = recordOutcome(st, 's3', { ok: false, now: at(0) });
  const until = st.sources.s3.until;
  st = recordOutcome(st, 's3', { ok: false, now: at(30) });
  assert.equal(st.sources.s3.until, until, 'the deadline should stay put (otherwise more failures mean a longer lock)');
});

t('custom rules: quarantine after 2 failures, for 1 hour', () => {
  const rules = { failures: 2, hours: 1 };
  let st = { sources: {} };
  st = recordOutcome(st, 's4', { ok: false, now: at(0), rules });
  assert.equal(quarantineOf(st, 's4', { now: at(1), rules }), null);
  st = recordOutcome(st, 's4', { ok: false, now: at(1), rules });
  const q2 = quarantineOf(st, 's4', { now: at(2), rules });
  assert.ok(q2);
  assert.equal(Date.parse(q2.until) - at(1).getTime(), 3600000, 'a custom quarantine of 1 hour');
  assert.equal(q2.rule.hours, 1);
});

t('a quarantined source is skipped with a reason and lands in no group', () => {
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

t('the quarantine state can be saved and read back (a broken file counts as empty, no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-quar-'));
  const cfg = { paths: { logsDir: dir } };
  let st = { sources: {} };
  st = recordOutcome(st, 'x', { ok: false, now: at(0) });
  saveQuarantine(cfg, st);
  const back = loadQuarantine(cfg);
  assert.equal(back.sources.x.failures, 1);
  fs.writeFileSync(path.join(dir, 'quarantine.json'), '{ broken', 'utf8');
  assert.deepEqual(loadQuarantine(cfg), { sources: {} }, 'a broken file must be tolerated');
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write('\nfetchplan: degradation ladder\n');

t('built-in ladder: only substitutions that actually hold up', () => {
  assert.deepEqual(fetchLadder({ fetch: 'mediawiki-api' }).map((s) => s.fetch), ['browser']);
  assert.deepEqual(fetchLadder({ fetch: 'rss' }).map((s) => s.fetch), ['browser']);
  assert.deepEqual(fetchLadder({ fetch: 'bili-opus' }), [], 'a login-free dynamic feed has no substitute (it must not auto-upgrade to the one that needs a login)');
  assert.deepEqual(fetchLadder({ fetch: 'browser' }), []);
});

t('a source can declare its own fallbacks, and they win over the built-in ladder', () => {
  const s = { fetch: 'browser', fallbacks: ['rss', { fetch: 'mediawiki-api' }] };
  assert.deepEqual(fetchLadder(s).map((x) => x.fetch), ['rss', 'mediawiki-api']);
});

t('the ladder is deduped and never schedules itself (guards against an infinite loop)', () => {
  const s = { fetch: 'rss', fallbacks: ['rss', 'browser', 'browser'] };
  const ladder = fetchLadder(s);
  assert.deepEqual(ladder.map((x) => x.fetch), ['browser'], 'both the source itself and duplicates must go');
  const dup = { fetch: 'mediawiki-api', fallbacks: ['browser'] };
  assert.deepEqual(fetchLadder(dup).map((x) => x.fetch), ['browser'], 'when built-in and self-declared overlap, keep only one');
});

t('the default quarantine rule is "3 failures / 6 hours" (pinned here so it cannot be changed quietly later)', () => {
  assert.deepEqual(QUARANTINE_DEFAULTS, { failures: 3, hours: 6 });
});

process.stdout.write('\nfetchplan: the actual behaviour once wired into fetchAll\n');

/** Swap the fetch methods through a test seam and run the real fetchAll (times and call order are both assertable) */
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

await t('parallel between queues, serial within a queue (the same egress never runs concurrently, different egresses do not wait for each other)', async () => {
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
  assert.deepEqual(out.map((r) => r.source.id), ['d1', 'd2', 't1'], 'results must return in input order');
  assert.ok(events.indexOf('end:d1') < events.indexOf('start:d2'), 'the same queue must be serial: ' + events.join(' '));
  assert.ok(events.indexOf('start:t1') < events.indexOf('end:d1'), 'different queues should run in parallel: ' + events.join(' '));
});

await t('degradation ladder: after RSS fails it switches to browser automatically, and records which step was used', async () => {
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
  assert.deepEqual(calls, ['rss:s1', 'browser:s1'], 'the ladder should be tried in order: ' + calls.join(','));
  assert.equal(ladderOut[0].ok, true);
  assert.deepEqual(ladderOut[0].ladder, { from: 'rss', to: 'browser', firstError: 'feed 404' });
});

await t('after consecutive failures reach the threshold, the next round no longer requests that source (and says so in the result)', async () => {
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
  assert.equal(calls.length, 3, 'the first three should really fetch (one failure each)');
  const fourth = await fetchAll(sources, { cfg, log: { info() {}, warn() {}, error() {} }, fetchTable: table });
  assert.equal(calls.length, 3, 'the fourth should send no request at all');
  assert.equal(fourth[0].skipped, 'quarantined');
  assert.match(fourth[0].error, /隔离至/);
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
