// cost-test.mjs — LLM 用量记账与预算闸门的自检
// 记账最怕「假账」：拿不到用量却记成 0、坏行把整个文件读崩、预算算成负数。
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

process.stdout.write('\ncost: 记账\n');

t('记一条用量：字段归一化（usage 的 snake_case 也认）', () => {
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

t('拿不到用量 → known=false（宁可标未知，也不记一个假 0）', () => {
  const { cfg } = sandbox();
  const row = recordUsage(cfg, { provider: 'ollama', model: 'local', totalTokens: 0, usage: null });
  assert.equal(row.known, false);
  assert.equal(row.totalTokens, 0);
});

t('坏行不影响别的行（逐行容错）', () => {
  const { cfg, dir } = sandbox();
  recordUsage(cfg, { provider: 'a', model: 'm', totalTokens: 10 });
  fs.appendFileSync(path.join(dir, 'cost.jsonl'), '{ 这不是 JSON\n', 'utf8');
  recordUsage(cfg, { provider: 'b', model: 'n', totalTokens: 20 });
  const { rows, badLines } = loadUsage(cfg);
  assert.equal(rows.length, 2);
  assert.equal(badLines, 1);
});

t('没有文件时返回空，不抛错', () => {
  const { cfg } = sandbox();
  assert.deepEqual(loadUsage(cfg), { rows: [], badLines: 0 });
});

process.stdout.write('\ncost: 汇总\n');

const NOW = new Date('2026-03-30T12:00:00Z');
const rows = [
  { at: '2026-03-30T01:00:00Z', provider: 'deepseek', model: 'chat', totalTokens: 1000, known: true, calls: 1 },
  { at: '2026-03-30T05:00:00Z', provider: 'deepseek', model: 'chat', totalTokens: 500, known: true, calls: 1 },
  { at: '2026-03-29T05:00:00Z', provider: 'openai', model: 'gpt', totalTokens: 2000, known: true, calls: 2 },
  { at: '2026-02-01T05:00:00Z', provider: 'openai', model: 'gpt', totalTokens: 9999, known: true, calls: 1 },
  { at: '2026-03-30T06:00:00Z', provider: 'ollama', model: 'local', totalTokens: 0, known: false, calls: 1 },
];

t('今天 / 逐日 / 按模型：各自算对', () => {
  const s = summarizeUsage(rows, { days: 7, now: NOW });
  assert.equal(s.today.tokens, 1500, '今天应当只有 3-30 的两条已知用量');
  assert.equal(s.today.calls, 3, 'calls 是「真的调了几次」，含那次没拿到用量的（它确实是一次调用）');
  assert.equal(s.total.tokens, 1500 + 2000 + 9999);
  assert.equal(s.unknown, 1, '未拿到用量的那条要单独计数');
  assert.deepEqual(
    s.days.map((d) => d.day),
    ['2026-03-29', '2026-03-30'],
    '7 天窗口应当排除 2 月那条',
  );
  assert.equal(s.days.at(-1).tokens, 1500);
  assert.equal(s.models[0].key, 'openai / gpt', '按 token 降序');
});

t('窗口外的不进 days，但仍计入总量（总量是「一共花了多少」）', () => {
  const s = summarizeUsage(rows, { days: 2, now: NOW });
  assert.ok(!s.days.some((d) => d.day === '2026-02-01'));
  assert.equal(s.total.tokens, 13499);
});

process.stdout.write('\ncost: 预算\n');

t('没设预算：不拦、不报超，并说明「未设」', () => {
  const s = summarizeUsage(rows, { now: NOW });
  const b = budgetStatus({ llm: {} }, s, { now: NOW });
  assert.equal(b.limit, 0);
  assert.equal(b.exceeded, false);
  assert.equal(b.remaining, null);
  assert.match(b.note, /未设每日预算/);
});

t('设了预算：用了多少、剩多少、超没超都对；默认只警告', () => {
  const s = summarizeUsage(rows, { now: NOW });
  const b = budgetStatus({ llm: { budget: { dailyTokens: 2000 } } }, s, { now: NOW });
  assert.equal(b.used, 1500);
  assert.equal(b.remaining, 500);
  assert.equal(b.exceeded, false);
  assert.equal(b.nearLimit, false, '1500/2000 = 75%，还没到 80% 的「接近上限」线');
  assert.equal(b.action, 'warn', '默认只警告 —— 使用者自己开的工具，拦下来要先说清楚');

  const near = budgetStatus({ llm: { budget: { dailyTokens: 1800 } } }, s, { now: NOW });
  assert.ok(near.nearLimit, '1500/1800 = 83%，应当算接近上限');
  assert.equal(near.exceeded, false);

  const over = budgetStatus({ llm: { budget: { dailyTokens: 1000, onExceed: 'stop' } } }, s, { now: NOW });
  assert.equal(over.exceeded, true);
  assert.equal(over.remaining, 0, '剩余不该是负数');
  assert.equal(over.action, 'stop');
});

t('超限时不把剩余算成负数（显示 -500 会让人以为欠费）', () => {
  const s = { today: { tokens: 5000, calls: 1 }, unknown: 0 };
  const b = budgetStatus({ llm: { budget: { dailyTokens: 1000 } } }, s);
  assert.equal(b.remaining, 0);
  assert.equal(b.pct, 5);
});

t('摘要一行能读', () => {
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
