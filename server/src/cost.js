// cost.js — LLM usage accounting / token accounting
//
// Why keep books: this tool spends its money on the LLM (each analysis round + feature
// extraction + image tagging), and before this **the UI showed no usage at all**. `analyze.js`
// did return `usage`, but nothing aggregated it, so "how much did this week cost" could only be
// guessed. The longer it runs, the more this number is needed.
//
// Two deliberate restraints in the design:
//   1. Only record **what can be seen**: paths where usage is unavailable (the model returned
//      no usage, or a local model was used) are recorded as unknown rather than guessed —
//      fake books are worse than no books.
//   2. The budget gate by default **only warns, never blocks**: this is a tool the user runs
//      themselves, and blocking it without a word would be overreach; to really block, set
//      llm.budget.onExceed to 'stop'.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

const FILE = 'cost.jsonl';
const KEEP_LINES = 5000; // Beyond this only the most recent lines are kept (one line per run; a few thousand covers a year)

function costPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), FILE);
}

/** Record one usage entry (one per run). A bad line does not affect the others, because reads are tolerant line by line. */
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
    /* failing to record doesn't affect the run */
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
    /* a failed trim doesn't matter */
  }
}

/** Read all usage lines (bad lines are skipped and counted, never thrown) */
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
 * Summary: today / per day / per model.
 * Note that rows with known=false are counted separately — "usage unavailable" and "usage was 0"
 * are two different things.
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
 * Budget status. A `dailyTokens` of 0 (or unset) = no limit.
 * Only **known** usage takes part in the judgement (unknown rows cannot, and that is stated
 * in the return value).
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

/** One-line summary, read by the logs and passed through /api/cost to the UI */
export function costSummary(summary, budget) {
  const parts = [`今日 ${summary.today.tokens} tokens / ${summary.today.calls} 次`];
  if (budget?.limit) parts.push(`预算 ${budget.limit}（${Math.round(budget.pct * 100)}%）`);
  if (summary.unknown) parts.push(`${summary.unknown} 次未拿到用量`);
  return parts.join(' · ');
}
