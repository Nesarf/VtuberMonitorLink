// cost.js — LLM 用量记账 / token accounting
//
// 为什么要记：这个工具的钱花在 LLM 上（每轮分析 + 特征抽取 + 图片打标），
// 而在此之前**界面上看不到任何用量** —— `analyze.js` 把 `usage` 取回来了，
// 但没人聚合，于是「这周花了多少」只能靠猜。跑得越久越需要这个数。
//
// 设计上的两个克制：
//   1. 只记**能看到的**：拿不到 usage 的路径（模型没返回用量、或走的是本地模型）
//      记成 unknown 而不是猜一个数字 —— 假账比没账更糟。
//   2. 预算闸门默认**只警告不拦**：使用者自己开的工具，拦下来不打招呼是越权；
//      想真拦就把 llm.budget.onExceed 设成 'stop'。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

const FILE = 'cost.jsonl';
const KEEP_LINES = 5000; // 超过就只留最近这么多行（一次运行一行，几千行够看一年）

function costPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), FILE);
}

/** 记一条用量（一次运行一条）。坏行不影响别人 —— 读的时候逐行容错。 */
export function recordUsage(cfg, entry) {
  const p = costPath(cfg);
  const row = {
    at: entry.at ?? new Date().toISOString(),
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    mode: entry.mode ?? 'daily',
    task: entry.task ?? null,
    promptTokens: Number(entry.promptTokens ?? entry.usage?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(entry.completionTokens ?? entry.usage?.completion_tokens ?? 0) || 0,
    totalTokens: Number(entry.totalTokens ?? entry.usage?.total_tokens ?? 0) || 0,
    known: entry.known !== false && !!(entry.usage || entry.totalTokens),
    calls: Number(entry.calls ?? 1) || 1,
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    trimIfHuge(p);
  } catch {
    /* 记不上不影响运行 */
  }
  return row;
}

function trimIfHuge(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= KEEP_LINES) return;
    fs.writeFileSync(p, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
  } catch {
    /* 裁剪失败无所谓 */
  }
}

/** 读出所有用量行（坏行跳过并计数，不抛错） */
export function loadUsage(cfg) {
  let raw = '';
  try {
    raw = fs.readFileSync(costPath(cfg), 'utf8');
  } catch {
    return { rows: [], badLines: 0 };
  }
  const rows = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { rows, badLines };
}

const dayOf = (v) => new Date(v).toISOString().slice(0, 10);

/**
 * 汇总：今天 / 逐日 / 按模型。
 * 注意 known=false 的行单独计数 —— 「没拿到用量」和「用量为 0」是两件事。
 */
export function summarizeUsage(rows, { days = 14, now = new Date() } = {}) {
  const today = dayOf(now);
  const byDay = new Map();
  const byModel = new Map();
  const out = { today: { tokens: 0, calls: 0 }, total: { tokens: 0, calls: 0 }, unknown: 0, days: [], models: [] };

  for (const row of rows ?? []) {
    const day = String(row.at ?? '').slice(0, 10) || 'unknown';
    const tokens = Number(row.totalTokens ?? 0) || 0;
    const calls = Number(row.calls ?? 1) || 1;
    out.total.tokens += tokens;
    out.total.calls += calls;
    if (!row.known) out.unknown++;
    if (day === today) {
      out.today.tokens += tokens;
      out.today.calls += calls;
    }
    if (!byDay.has(day)) byDay.set(day, { day, tokens: 0, calls: 0 });
    const d = byDay.get(day);
    d.tokens += tokens;
    d.calls += calls;

    const key = `${row.provider ?? '?'} / ${row.model ?? '?'}`;
    if (!byModel.has(key)) byModel.set(key, { key, tokens: 0, calls: 0 });
    const m = byModel.get(key);
    m.tokens += tokens;
    m.calls += calls;
  }

  const cutoff = dayOf(new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000));
  out.days = [...byDay.values()].filter((d) => d.day >= cutoff).sort((a, b) => a.day.localeCompare(b.day));
  out.models = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
  return out;
}

/**
 * 预算状态。`dailyTokens` 为 0（或不填）= 不设限。
 * 只用**已知**用量参与判断（未知的那些没法参与，这一点在返回里说明）。
 */
export function budgetStatus(cfg, summary, { now = new Date() } = {}) {
  const budget = cfg?.llm?.budget ?? {};
  const limit = Number(budget.dailyTokens ?? 0) || 0;
  const used = Number(summary?.today?.tokens ?? 0);
  const action = budget.onExceed === 'stop' ? 'stop' : 'warn';
  const pct = limit > 0 ? used / limit : 0;
  return {
    limit,
    used,
    remaining: limit > 0 ? Math.max(0, limit - used) : null,
    pct: Number(pct.toFixed(4)),
    action,
    exceeded: limit > 0 && used >= limit,
    nearLimit: limit > 0 && pct >= 0.8 && used < limit,
    unknownRows: summary?.unknown ?? 0,
    note: limit > 0 ? null : '未设每日预算（llm.budget.dailyTokens = 0）',
  };
}

/** 一行摘要，给日志与界面用 */
export function costSummary(summary, budget) {
  const parts = [`今日 ${summary.today.tokens} tokens / ${summary.today.calls} 次`];
  if (budget?.limit) parts.push(`预算 ${budget.limit}（${Math.round(budget.pct * 100)}%）`);
  if (summary.unknown) parts.push(`${summary.unknown} 次未拿到用量`);
  return parts.join(' · ');
}
