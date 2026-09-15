// egress.js — automatically pick the "most suitable egress" per site (direct / proxy / Tor)
//
// Why comparing avg alone is not enough: in measured runs "direct at 380ms but 20% packet loss" and
// "proxy at 120ms with zero loss" are not problems of the same magnitude — packet loss means retries,
// and the cost of a retry is far greater than waiting 200ms longer.
// So the score converts loss into an equivalent latency: effective = avg × (1 + loss × LOSS_COST).
//
// Why hysteresis is needed: a 20~30ms wobble between two probes means nothing, and switching egress
// because of it only makes a site that "already fails every now and then" less stable. A challenger must be
// **clearly** better (20% cheaper by default) before it is allowed to take over; the current egress is
// swapped out at once as soon as it turns unhealthy.
//
// There is also a **conservative fallback**: with too few samples, never probed at all, or nothing
// reachable, it does not guess — it falls back to the value written explicitly on the source, and
// then to the global config. Automatic mode is an optimization, not a gamble.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/** one failure costs about as much as 4 normal requests (timeout + retry + slowdown) */
export const LOSS_COST = 4;
/**
 * Jitter is charged more gently than loss, because it is a different kind of harm: a loss is a request
 * that has to be made again, while jitter does not lose anything - it makes every request's duration
 * unpredictable, which is what a browser fetch actually stalls on. Half of the spread is therefore added
 * as equivalent latency, on top of the loss term rather than instead of it.
 *
 * Note this is a second, independent stability signal from the outcome history in historyPenalty():
 * that one says "this egress has really been failing lately", this one says "this egress is noisy right
 * now". A caller that never measured jitter gets exactly the old number, because the term is zero.
 */
export const JITTER_COST = 0.5;
/** a challenger must be 20% cheaper than the incumbent before it takes over, to avoid flapping */
export const SWITCH_MARGIN = 0.2;
/**
 * Landing in the right country is worth something, and landing in the wrong one costs something.
 *
 * A site that only serves - or only behaves properly for - one region is a case the latency number cannot
 * express: a proxy exit in another country can be faster and still be the wrong door. The factor is
 * deliberately modest (3% of a bonus, 25% of a penalty) because this is a *weight* beside speed and
 * stability, not a filter. A hard filter would make a region-pinned source unusable on a day when nothing
 * in that region answers, and the user's own words were to judge by speed and stability *including* the
 * IP's locality - which is a comparison, not a veto.
 *
 * Two absences change nothing, and that is what keeps every number this file produced before the locality
 * measurement existed exactly as it was: a source that declares no region, or an egress whose country was
 * not measured.
 */
export const LOCALITY_BONUS = 0.97;
export const LOCALITY_PENALTY = 1.25;

export function localityFactor(region, exit) {
  const want = String(region ?? '').trim().toUpperCase();
  const got = String(exit?.loc ?? '').trim().toUpperCase();
  if (!want || !got) return { factor: 1, note: '' };
  if (want === got) return { factor: LOCALITY_BONUS, note: `落地 ${got}，正是来源所在地区` };
  return { factor: LOCALITY_PENALTY, note: `落地 ${got}，来源期望 ${want}` };
}
/** below this many samples no high-confidence verdict is given */
const MIN_SAMPLES = 3;
/** freshness window of a verdict (minutes): once expired, wait for the next probe instead of propping it up with stale data */
const DECISION_TTL_MIN = 180;
/** how many real fetch outcomes are kept for the "stability" signal */
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
    // a missing or corrupt file is treated as an empty store; the feature must not stop working because a cache file got damaged
  }
  return empty();
}

function save(cfg, data) {
  const p = storePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // an unwritable file must not make fetching fail either
  }
}

/** in-process cache: resolveProxyMode is a synchronous hot path, so it cannot read from disk every time */
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

/** site identity: the source id first, then the host */
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
 * Score of a single egress.
 *
 * effective = avg × (1 + loss × LOSS_COST) + jitter × JITTER_COST
 *
 * The loss term is the original one and is unchanged; the jitter term is zero whenever the probe did not
 * measure a spread, which is what keeps this backwards-compatible for callers that only ping once.
 * @returns {{usable:boolean, effective:number, avg:number, loss:number, jitter:number, samples:number, why:string}}
 */
export function scoreMode(m) {
  if (!m || m.skipped) return { usable: false, effective: Infinity, avg: 0, loss: 0, jitter: 0, samples: 0, why: '未参与对比' };
  if (!m.ok) return { usable: false, effective: Infinity, avg: 0, loss: 1, jitter: 0, samples: m.sent ?? 0, why: m.error ?? '不通' };
  const avg = Number(m.avg ?? 0);
  const loss = Number(m.loss ?? 0);
  const jitter = Number(m.jitter ?? 0);
  const effective = Math.max(1, Math.round(avg * (1 + loss * LOSS_COST) + jitter * JITTER_COST));
  return { usable: true, effective, avg, loss, jitter, samples: Number(m.sent ?? 0), why: '' };
}

/** stability correction from real fetch outcomes: repeated failures raise the score, long-running success earns a small bonus */
function historyPenalty(hist) {
  if (!hist || !hist.length) return { factor: 1, note: '暂无抓取记录' };
  const recent = hist.slice(-HISTORY_KEEP);
  const fails = recent.filter((h) => !h.ok).length;
  const rate = fails / recent.length;
  if (fails === 0) return { factor: 0.95, note: `近 ${recent.length} 次抓取全部成功` };
  return { factor: 1 + rate * 1.5, note: `近 ${recent.length} 次抓取失败 ${fails} 次` };
}

/**
 * Decide which egress a site should use.
 * @param {object} o
 * @param {object} o.probe   probe results (what probe.js returns: {modes:{direct,proxy}, ...})
 * @param {object} o.history {mode: [{ok, at}]}
 * @param {string} o.current the egress currently in use (for hysteresis)
 * @param {string} o.region  the country the subject wants to appear from, if it declared one
 * @returns {{mode:string, reason:string, scores:object, changed:boolean, confidence:string}}
 */
export function decide({ probe, history = {}, current = null, fallback = 'direct', region = null }) {
  const modes = probe?.modes ?? {};
  const direct = scoreMode(modes.direct);
  const proxy = scoreMode(modes.proxy);
  const tor = scoreMode(modes.tor);

  const candidates = [];
  const consider = (name, sc) => {
    if (!sc.usable) return;
    const h = historyPenalty(history[name]);
    const l = localityFactor(region, modes[name]?.exit);
    candidates.push({
      name,
      effective: sc.effective * h.factor * l.factor,
      raw: sc,
      note: [h.note, l.note].filter(Boolean).join('；'),
      factor: h.factor * l.factor,
      locality: l,
    });
  };
  consider('direct', direct);
  consider('proxy', proxy);
  consider('tor', tor);

  const scores = { direct, proxy, tor };
  const usable = candidates.map((c) => c.name);

  if (!candidates.length) {
    // none of the modes is reachable — do not invent a verdict, fall back and state the reason plainly
    return {
      mode: fallback,
      reason: `直连与代理都不通，暂用 ${fallback}（探测：直连 ${direct.why || '—'} / 代理 ${proxy.why || '—'}）`,
      scores,
      changed: false,
      confidence: 'none',
    };
  }

  // only one probed as usable → use it directly (this is the "proxy is mandatory" case)
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
    `${c.name} ${c.raw.avg}ms${c.raw.loss ? ` 丢包${Math.round(c.raw.loss * 100)}%` : ''}${c.raw.jitter ? ` 抖动±${Math.round(c.raw.jitter)}ms` : ''}→等效${Math.round(c.effective)}ms`;

  // hysteresis: as long as the incumbent is not clearly worse, do not move — egress swapping back and forth is the real instability
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

/** update the verdict once probing finished (called by both server.js and the runner's preflight) */
export function recordProbe(cfg, { subject, probe, fallback }) {
  const key = siteKey(subject) || (probe?.host ?? probe?.url ?? '');
  if (!key) return null;
  const data = db(cfg);
  const prev = data.decisions[key];
  const current = prev?.mode ?? null;
  const out = decide({ probe, history: data.history?.[key]?.byMode ?? {}, current, fallback: fallback ?? 'direct', region: subject?.region ?? null });
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

/** real fetch outcome → stability signal (this is the first-hand evidence of "stable", far more reliable than 3 pings) */
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

/** fetch the verdict synchronously, for the hot path (resolveProxyMode) */
export function decision(cfg, subject) {
  const key = siteKey(subject);
  if (!key) return null;
  const d = db(cfg).decisions?.[key];
  if (!d) return null;
  if (d.expiresAt && Date.parse(d.expiresAt) < Date.now()) return { ...d, stale: true };
  return d;
}

/** the full view handed to the web UI */
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
