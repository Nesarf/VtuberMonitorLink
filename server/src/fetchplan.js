// fetchplan.js — 抓取的调度决策：按出口分组并行、连续失败来源隔离、抓取方式降级阶梯
//
// 为什么单独抽出来：这三件事都是「策略」，而策略最容易写成藏在循环里的 if，
// 于是既测不了、也说不清「现在到底是怎么调度的」。这里全是纯函数，
// 自检（tools/fetchplan-test.mjs）拿固定时间和固定失败序列把行为钉住。
//
// 三条策略各自的理由：
//   1. **按出口分组并行**：抓取原本是一条条串行 + 主动间隔，24 条来源一轮要几分钟。
//      但「串行」真正要保护的是**同一个出口的身份**（同一张脸不要连着敲），
//      不同出口之间没有这个约束。于是按出口分组成几队，**队间并行、队内串行**：
//      足迹不变，时间砍掉大半。
//   2. **连续失败隔离**：抓不到的来源（Cloudflare、失效的站点）每一轮都会被重试，
//      既是白花的时间，也是白白多出来的请求 —— 而请求本身就是足迹。
//      连续失败 N 次就先安静 M 小时，之后自动再试一次（不是永久拉黑）。
//   3. **降级阶梯**：失败时现在只换出口，不换抓取方式。有些失败是「这个方式不行」
//      而不是「这个出口不行」（例如该站点只剩 RSS 可用）。阶梯只放**站得住脚**的转换，
//      来源也可以自己声明 fallbacks。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/** 抓取方式之间允许的降级（保守表：只放能自圆其说的转换） */
export const FETCH_LADDER = {
  // MediaWiki API 打不动（被 Cloudflare 拦、或 API 关了）→ 用浏览器把同一页面渲染出来
  'mediawiki-api': ['browser'],
  // RSS 拿不到（feed 挂了/被拦）→ 用浏览器抓同一个地址
  rss: ['browser'],
  // 免登录动态被风控 → 没有可替代的免登录方式（bili-dynamic 需要登录，不能自动升级成它）
  'bili-opus': [],
  'bili-dynamic': [],
  browser: [],
  'search-only': [],
};

/**
 * 这个来源可以按什么顺序尝试抓取方式。
 * 顺序：来源自己声明的 fallbacks（优先）→ 内置阶梯 → 去重、去掉自己。
 */
export function fetchLadder(source) {
  const own = Array.isArray(source?.fallbacks)
    ? source.fallbacks.map((f) => (typeof f === 'string' ? { fetch: f } : f)).filter((f) => f?.fetch)
    : [];
  const builtin = (FETCH_LADDER[source?.fetch] ?? []).map((f) => ({ fetch: f }));
  const out = [];
  const seen = new Set([source?.fetch]);
  for (const step of [...own, ...builtin]) {
    if (seen.has(step.fetch)) continue;
    seen.add(step.fetch);
    out.push(step);
  }
  return out;
}

// ───────────────────────────────────────────── 失败隔离

export const QUARANTINE_DEFAULTS = { failures: 3, hours: 6 };

function quarantinePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'quarantine.json');
}

export function loadQuarantine(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(quarantinePath(cfg), 'utf8'));
    if (raw && typeof raw === 'object' && raw.sources) return { sources: raw.sources };
  } catch {
    /* 没有就从空开始 */
  }
  return { sources: {} };
}

export function saveQuarantine(cfg, state) {
  const p = quarantinePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sources: state.sources ?? {} }, null, 2) + '\n', 'utf8');
  } catch {
    /* 记不上不影响这一轮 */
  }
}

/** 这条来源现在该被隔离吗（以及为什么、还有多久） */
export function quarantineOf(state, id, { now = new Date(), rules = QUARANTINE_DEFAULTS } = {}) {
  const rec = state?.sources?.[id];
  if (!rec) return null;
  const until = Date.parse(rec.until ?? '');
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return {
    failures: rec.failures ?? 0,
    until: new Date(until).toISOString(),
    minutesLeft: Math.ceil((until - now.getTime()) / 60000),
    lastError: rec.lastError ?? null,
    rule: rules,
  };
}

/**
 * 记一次抓取结果，返回新的隔离状态。
 * 成功 → 清零（隔离线自动解除）；失败 → 计数，到阈值后隔离 M 小时。
 */
export function recordOutcome(state, id, { ok, error = null, now = new Date(), rules = QUARANTINE_DEFAULTS } = {}) {
  const next = { sources: { ...(state?.sources ?? {}) } };
  if (ok) {
    delete next.sources[id];
    return next;
  }
  const prev = next.sources[id];
  // 已经隔离过了：保留原截止时间（不要因为又失败一次就无限延长）
  if (prev && Date.parse(prev.until ?? '') > now.getTime()) return next;
  const failures = (prev?.failures ?? 0) + 1;
  const limit = Math.max(1, Number(rules.failures) || QUARANTINE_DEFAULTS.failures);
  const hours = Math.max(0.1, Number(rules.hours) || QUARANTINE_DEFAULTS.hours);
  next.sources[id] =
    failures >= limit
      ? { failures, until: new Date(now.getTime() + hours * 3600000).toISOString(), lastError: error, quarantinedAt: now.toISOString() }
      : { failures, until: null, lastError: error };
  return next;
}

// ───────────────────────────────────────────── 调度计划

/**
 * 把来源分成「按出口分组」的调度计划。
 *
 * 分组内保持原有顺序（间隔由调用方按 rateLimit 决定），组之间可以并行。
 * @param {Array} sources
 * @param {(source:object)=>string} resolveMode 这条来源实际走哪个出口
 * @param {{now?:Date, rules?:object, quarantine?:object}} opts
 * @returns {{ groups: {mode:string, sources:object[]}[], skipped: object[], quarantined: object[] }}
 */
export function planFetch(sources, resolveMode, opts = {}) {
  const { now = new Date(), rules = QUARANTINE_DEFAULTS, quarantine = { sources: {} } } = opts;
  const byMode = new Map();
  const skipped = [];
  const quarantined = [];

  for (const s of sources ?? []) {
    const q = quarantineOf(quarantine, s.id, { now, rules });
    if (q) {
      quarantined.push({ id: s.id, ...q });
      skipped.push({ source: s, ok: false, skipped: 'quarantined', error: `连续失败 ${q.failures} 次，已隔离至 ${q.until}（${q.minutesLeft} 分钟后自动重试）` });
      continue;
    }
    // 观测模式跳过登录态来源时已经在 observe.js 里剔除了；这里只管出口分组
    const mode = resolveMode(s) ?? 'direct';
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(s);
  }

  // 稳定的组顺序（direct → proxy → tor），便于日志好读、测试好断言
  const order = ['direct', 'proxy', 'tor'];
  const groups = [...byMode.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([mode, list]) => ({ mode, sources: list }));

  return { groups, skipped, quarantined };
}
