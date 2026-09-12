// cost-test.mjs — self-test for the LLM usage ledger and the budget gate
// The worst thing for a ledger is "fake bookkeeping": usage that cannot be read gets recorded as 0,
// a bad line crashes reading the whole file, the budget goes negative.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { budgetStatus, costSummary, loadUsage, recordUsage, summarizeUsage } from '../server/src/cost.js';

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

const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-cost-'));
  return { dir, cfg: { paths: { logsDir: dir } } };
};

process.stdout.write('\ncost: ledger\n');

t('record one usage entry: fields are normalised (snake_case usage keys are accepted too)', () => {
  const { cfg } = sandbox();
  const row = recordUsage(cfg, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    mode: 'daily',
  });
  assert.equal(row.promptTokens, 1200);
  assert.equal(row.completionTokens, 300);
  assert.equal(row.totalTokens, 1500);
  assert.equal(row.known, true);
  const { rows, badLines } = loadUsage(cfg);
  assert.equal(rows.length, 1);
  assert.equal(badLines, 0);
});

t('usage unavailable -> known=false (better to mark it unknown than to record a fake 0)', () => {
  const { cfg } = sandbox();
  const row = recordUsage(cfg, { provider: 'ollama', model: 'local', totalTokens: 0, usage: null });
  assert.equal(row.known, false);
  assert.equal(row.totalTokens, 0);
});

t('a bad line does not affect the other lines (per-line fault tolerance)', () => {
  const { cfg, dir } = sandbox();
  recordUsage(cfg, { provider: 'a', model: 'm', totalTokens: 10 });
  fs.appendFileSync(path.join(dir, 'cost.jsonl'), '{ 这不是 JSON\n', 'utf8');
  recordUsage(cfg, { provider: 'b', model: 'n', totalTokens: 20 });
  const { rows, badLines } = loadUsage(cfg);
  assert.equal(rows.length, 2);
  assert.equal(badLines, 1);
});

t('returns empty when there is no file, does not throw', () => {
  const { cfg } = sandbox();
  assert.deepEqual(loadUsage(cfg), { rows: [], badLines: 0 });
});

process.stdout.write('\ncost: summary\n');

const NOW = new Date('2026-03-30T12:00:00Z');
const rows = [
  { at: '2026-03-30T01:00:00Z', provider: 'deepseek', model: 'chat', totalTokens: 1000, known: true, calls: 1 },
  { at: '2026-03-30T05:00:00Z', provider: 'deepseek', model: 'chat', totalTokens: 500, known: true, calls: 1 },
  { at: '2026-03-29T05:00:00Z', provider: 'openai', model: 'gpt', totalTokens: 2000, known: true, calls: 2 },
  { at: '2026-02-01T05:00:00Z', provider: 'openai', model: 'gpt', totalTokens: 9999, known: true, calls: 1 },
  { at: '2026-03-30T06:00:00Z', provider: 'ollama', model: 'local', totalTokens: 0, known: false, calls: 1 },
];

t('today / per-day / per-model: each one adds up correctly', () => {
  const s = summarizeUsage(rows, { days: 7, now: NOW });
  assert.equal(s.today.tokens, 1500, 'today should only hold the two known usage entries from 3-30');
  assert.equal(s.today.calls, 3, 'calls is "how many times we actually called", including the one whose usage was unavailable (it was still a call)');
  assert.equal(s.total.tokens, 1500 + 2000 + 9999);
  assert.equal(s.unknown, 1, 'the entry whose usage was unavailable must be counted separately');
  assert.deepEqual(
    s.days.map((d) => d.day),
    ['2026-03-29', '2026-03-30'],
    'the 7-day window should exclude the February entry',
  );
  assert.equal(s.days.at(-1).tokens, 1500);
  assert.equal(s.models[0].key, 'openai / gpt', 'sorted by tokens descending');
});

t('outside the window stays out of days, but still counts towards the total (the total is "how much was spent overall")', () => {
  const s = summarizeUsage(rows, { days: 2, now: NOW });
  assert.ok(!s.days.some((d) => d.day === '2026-02-01'));
  assert.equal(s.total.tokens, 13499);
});

process.stdout.write('\ncost: budget\n');

t('no budget set: no blocking, no over-limit report, and it says "not set"', () => {
  const s = summarizeUsage(rows, { now: NOW });
  const b = budgetStatus({ llm: {} }, s, { now: NOW });
  assert.equal(b.limit, 0);
  assert.equal(b.exceeded, false);
  assert.equal(b.remaining, null);
  assert.match(b.note, /未设每日预算/);
});

t('budget set: used, remaining and exceeded all come out right; it only warns by default', () => {
  const s = summarizeUsage(rows, { now: NOW });
  const b = budgetStatus({ llm: { budget: { dailyTokens: 2000 } } }, s, { now: NOW });
  assert.equal(b.used, 1500);
  assert.equal(b.remaining, 500);
  assert.equal(b.exceeded, false);
  assert.equal(b.nearLimit, false, '1500/2000 = 75%, still short of the 80% "near the limit" line');
  assert.equal(b.action, 'warn', 'warn only by default -- this is a tool the user turned on themselves, so blocking has to be explained first');

  const near = budgetStatus({ llm: { budget: { dailyTokens: 1800 } } }, s, { now: NOW });
  assert.ok(near.nearLimit, '1500/1800 = 83%, this should count as near the limit');
  assert.equal(near.exceeded, false);

  const over = budgetStatus({ llm: { budget: { dailyTokens: 1000, onExceed: 'stop' } } }, s, { now: NOW });
  assert.equal(over.exceeded, true);
  assert.equal(over.remaining, 0, 'remaining must not go negative');
  assert.equal(over.action, 'stop');
});

t('over the limit does not turn the remaining amount negative (showing -500 makes people think they owe money)', () => {
  const s = { today: { tokens: 5000, calls: 1 }, unknown: 0 };
  const b = budgetStatus({ llm: { budget: { dailyTokens: 1000 } } }, s);
  assert.equal(b.remaining, 0);
  assert.equal(b.pct, 5);
});

t('the summary line is readable', () => {
  const s = summarizeUsage(rows, { now: NOW });
  const b = budgetStatus({ llm: { budget: { dailyTokens: 2000 } } }, s, { now: NOW });
  const line = costSummary(s, b);
  assert.match(line, /今日 1500 tokens/);
  assert.match(line, /预算 2000/);
  assert.match(line, /1 次未拿到用量/);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
