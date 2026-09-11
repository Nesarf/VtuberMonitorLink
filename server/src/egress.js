// egress.js — 每个站点自动挑「最合适的出口」（直连 / 代理 / Tor）
//
// 为什么不能只比 avg：实测里「直连 380ms 但丢包 20%」和「代理 120ms 零丢包」
// 不是同一个量级的问题 —— 丢包要重试，重试的代价远大于多等 200ms。
// 所以打分把丢包换算成等效延迟：effective = avg × (1 + loss × LOSS_COST)。
//
// 为什么要有粘滞（hysteresis）：两次探测之间 20~30ms 的抖动毫无意义，
// 按它切换出口只会让「本来就偶发失败」的站点更不稳定。挑战者必须**明显**更好
// （默认便宜 20% 以上）才允许改判；当前出口一旦不健康就立刻换。
//
// 还要有**保守兜底**：样本不足、从没探测过、两种都不通时，不猜 ——
// 回落到来源上显式写的值，再回落到全局配置。自动模式是优化，不是赌。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/** 一次失败 ≈ 4 次正常请求的代价（超时 + 重试 + 降速） */
export const LOSS_COST = 4;
/** 挑战者要比现任便宜 20% 才换，避免抖动 */
export const SWITCH_MARGIN = 0.2;
/** 少于这么多样本时不给高置信度判断 */
const MIN_SAMPLES = 3;
/** 判定结果保鲜期（分钟）：过期就等下一次探测，不拿旧数据硬撑 */
const DECISION_TTL_MIN = 180;
/** 记录多少条真实抓取结果用于「稳定性」 */
const HISTORY_KEEP = 20;

const memory = { loadedAt: 0, data: null };

function storePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'egress.json');
}

function empty() {
  return { version: 1, decisions: {}, history: {} };
}

export function load(cfg) {
  const p = storePath(cfg);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw === 'object' && raw.decisions) return raw;
  } catch {
    // 文件不存在/坏了都当空库，功能不能因为缓存坏了就停
  }
  return empty();
}

function save(cfg, data) {
  const p = storePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 写不进去也不能让抓取失败
  }
}

/** 进程内缓存：resolveProxyMode 是同步的热路径，不能每次去读盘 */
function db(cfg) {
  const now = Date.now();
  if (!memory.data || now - memory.loadedAt > 15000) {
    memory.data = load(cfg);
    memory.loadedAt = now;
  }
  return memory.data;
}

export function invalidate() {
  memory.loadedAt = 0;
  memory.data = null;
}

/** 站点标识：优先来源 id，其次 host */
export function siteKey(subject) {
  if (!subject) return '';
  if (subject.id) return String(subject.id);
  const u = subject.url ?? subject.page?.url;
  if (!u) return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return String(u).slice(0, 60);
  }
}

/**
 * 单个出口的得分。
 * @returns {{usable:boolean, effective:number, avg:number, loss:number, samples:number, why:string}}
 */
export function scoreMode(m) {
  if (!m || m.skipped) return { usable: false, effective: Infinity, avg: 0, loss: 0, samples: 0, why: '未参与对比' };
  if (!m.ok) return { usable: false, effective: Infinity, avg: 0, loss: 1, samples: m.sent ?? 0, why: m.error ?? '不通' };
  const avg = Number(m.avg ?? 0);
  const loss = Number(m.loss ?? 0);
  const effective = Math.max(1, Math.round(avg * (1 + loss * LOSS_COST)));
  return { usable: true, effective, avg, loss, samples: Number(m.sent ?? 0), why: '' };
}

/** 真实抓取结果的稳定性修正：连续失败会把分数拉高，长期成功略微加分 */
function historyPenalty(hist) {
  if (!hist || !hist.length) return { factor: 1, note: '暂无抓取记录' };
  const recent = hist.slice(-HISTORY_KEEP);
  const fails = recent.filter((h) => !h.ok).length;
  const rate = fails / recent.length;
  if (fails === 0) return { factor: 0.95, note: `近 ${recent.length} 次抓取全部成功` };
  return { factor: 1 + rate * 1.5, note: `近 ${recent.length} 次抓取失败 ${fails} 次` };
}

/**
 * 决定一个站点该走哪个出口。
 * @param {object} o
 * @param {object} o.probe   探测结果（probe.js 的返回：{modes:{direct,proxy}, ...}）
 * @param {object} o.history {mode: [{ok, at}]}
 * @param {string} o.current 当前在用的出口（用于粘滞）
 * @returns {{mode:string, reason:string, scores:object, changed:boolean, confidence:string}}
 */
export function decide({ probe, history = {}, current = null, fallback = 'direct' }) {
  const modes = probe?.modes ?? {};
  const direct = scoreMode(modes.direct);
  const proxy = scoreMode(modes.proxy);
  const tor = scoreMode(modes.tor);

  const candidates = [];
  const consider = (name, sc) => {
    if (!sc.usable) return;
    const h = historyPenalty(history[name]);
    candidates.push({ name, effective: sc.effective * h.factor, raw: sc, note: h.note, factor: h.factor });
  };
  consider('direct', direct);
  consider('proxy', proxy);
  consider('tor', tor);

  const scores = { direct, proxy, tor };
  const usable = candidates.map((c) => c.name);

  if (!candidates.length) {
    // 两个都不通 —— 不编造结论，回落并把原因写清楚
    return {
      mode: fallback,
      reason: `直连与代理都不通，暂用 ${fallback}（探测：直连 ${direct.why || '—'} / 代理 ${proxy.why || '—'}）`,
      scores,
      changed: false,
      confidence: 'none',
    };
  }

  // 只探测到一个能用的 → 直接用它（这就是「必须走代理」的场景）
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      mode: only.name,
      reason: `只有 ${only.name} 可用（${only.raw.avg}ms${only.raw.loss ? `，丢包 ${Math.round(only.raw.loss * 100)}%` : ''}）；${only.note}`,
      scores,
      changed: current !== only.name,
      confidence: only.raw.samples >= MIN_SAMPLES ? 'high' : 'low',
    };
  }

  candidates.sort((a, b) => a.effective - b.effective);
  const best = candidates[0];
  const incumbent = candidates.find((c) => c.name === current) ?? null;

  const detail = (c) =>
    `${c.name} ${c.raw.avg}ms${c.raw.loss ? ` 丢包${Math.round(c.raw.loss * 100)}%` : ''}→等效${Math.round(c.effective)}ms`;

  // 粘滞：现任只要没有明显更差，就不动 —— 出口换来换去才是真的不稳定
  if (incumbent && incumbent.name !== best.name && incumbent.effective <= best.effective * (1 + SWITCH_MARGIN)) {
    return {
      mode: incumbent.name,
      reason: `保持 ${detail(incumbent)}（${detail(best)} 优势不足 ${Math.round(SWITCH_MARGIN * 100)}%，不切换）；${incumbent.note}`,
      scores,
      changed: false,
      confidence: incumbent.raw.samples >= MIN_SAMPLES ? 'high' : 'low',
    };
  }

  const conf = best.raw.samples >= MIN_SAMPLES ? 'high' : 'low';
  return {
    mode: best.name,
    reason: `${detail(best)} 更合适（${candidates.map(detail).join(' vs ')}）；${best.note}${conf === 'low' ? '（样本偏少，先按它走）' : ''}`,
    scores,
    changed: current !== best.name,
    confidence: conf,
  };
}

/** 探测完成后更新判定（server.js / runner 的 preflight 都会调） */
export function recordProbe(cfg, { subject, probe, fallback }) {
  const key = siteKey(subject) || (probe?.host ?? probe?.url ?? '');
  if (!key) return null;
  const data = db(cfg);
  const prev = data.decisions[key];
  const current = prev?.mode ?? null;
  const out = decide({ probe, history: data.history?.[key]?.byMode ?? {}, current, fallback: fallback ?? 'direct' });
  data.decisions[key] = {
    key,
    label: subject?.name?.zh ?? subject?.name ?? subject?.id ?? key,
    mode: out.mode,
    reason: out.reason,
    scores: out.scores,
    confidence: out.confidence,
    changed: out.changed,
    at: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DECISION_TTL_MIN * 60000).toISOString(),
  };
  memory.loadedAt = Date.now();
  save(cfg, data);
  return data.decisions[key];
}

/** 真实抓取结果 → 稳定性信号（这才是「稳」的第一手证据，比 3 次 ping 可靠） */
export function recordOutcome(cfg, subject, { ok, ms = null, mode = null }) {
  const key = siteKey(subject);
  if (!key) return;
  const data = db(cfg);
  data.history ??= {};
  const h = (data.history[key] ??= { byMode: {}, last: [] });
  const m = mode ?? 'unknown';
  (h.byMode[m] ??= []).push({ ok: !!ok, ms, at: new Date().toISOString() });
  if (h.byMode[m].length > HISTORY_KEEP) h.byMode[m] = h.byMode[m].slice(-HISTORY_KEEP);
  h.last.push({ ok: !!ok, ms, mode: m, at: new Date().toISOString() });
  if (h.last.length > HISTORY_KEEP) h.last = h.last.slice(-HISTORY_KEEP);
  memory.loadedAt = Date.now();
  save(cfg, data);
}

/** 同步取判定，供热路径（resolveProxyMode）使用 */
export function decision(cfg, subject) {
  const key = siteKey(subject);
  if (!key) return null;
  const d = db(cfg).decisions?.[key];
  if (!d) return null;
  if (d.expiresAt && Date.parse(d.expiresAt) < Date.now()) return { ...d, stale: true };
  return d;
}

/** 给界面用的完整视图 */
export function snapshot(cfg) {
  const data = db(cfg);
  const decisions = Object.values(data.decisions ?? {}).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    counts: decisions.reduce((acc, d) => ({ ...acc, [d.mode]: (acc[d.mode] ?? 0) + 1 }), {}),
    decisions,
    updatedAt: decisions.reduce((t, d) => (d.at > t ? d.at : t), ''),
  };
}

export function clear(cfg) {
  const data = db(cfg);
  data.decisions = {};
  data.history = {};
  memory.loadedAt = Date.now();
  save(cfg, data);
}
