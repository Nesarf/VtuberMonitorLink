// fetchers/index.js — 按 source.fetch 分派 / dispatch by adapter kind
import { fetchRss } from './rss.js';
import { fetchMediaWiki } from './mediawiki.js';
import { fetchBrowser } from './browser.js';
import { fetchSearchOnly } from './search.js';
import { fetchBilibiliOpus, fetchBilibiliDynamic } from './bilibili.js';
import { gapWithJitter } from '../observe.js';
import { QUARANTINE_DEFAULTS, fetchLadder, loadQuarantine, planFetch, recordOutcome, saveQuarantine } from '../fetchplan.js';
import { resolveProxyMode } from '../net.js';
import { setTimeout as sleep } from 'node:timers/promises';

const TABLE = {
  rss: fetchRss,
  'mediawiki-api': fetchMediaWiki,
  browser: fetchBrowser,
  'search-only': fetchSearchOnly,
  'bili-opus': fetchBilibiliOpus,
  'bili-dynamic': fetchBilibiliDynamic,
};

/** 网页里可选的抓取方式（自定义来源编辑器用） */
export const FETCH_KINDS = [
  { id: 'rss', zh: 'RSS / Atom 订阅', en: 'RSS / Atom feed' },
  { id: 'mediawiki-api', zh: 'MediaWiki API（最近更改）', en: 'MediaWiki API (recent changes)' },
  { id: 'browser', zh: '浏览器渲染（可复用登录）', en: 'Browser render (can reuse a login)' },
  { id: 'bili-opus', zh: 'B 站图文动态（免登录）', en: 'bilibili image/text dynamics (no login)' },
  { id: 'bili-dynamic', zh: 'B 站完整动态（需登录，含配图）', en: 'bilibili full dynamics (login, with pictures)' },
  { id: 'search-only', zh: '仅交给检索阶段', en: 'Search stage only' },
];

/**
 * 该不该在失败后换另一个出口重试。
 * 只在来源**没有显式指定出口**时才换 —— 像 B 站这种「显式 direct 否则被风控」的来源，
 * 自动改成走代理只会更糟。
 */
function otherEgress(cfg, source) {
  if (cfg?.run?.autoFailover === false) return null;
  if (source?.proxy) return null; // 已显式指定，尊重它
  return cfg?.proxy?.enabled && cfg?.proxy?.url ? 'direct' : 'proxy';
}

/**
 * 抓取选中的来源。
 *
 * 三条策略（纯逻辑在 fetchplan.js，自检 fetchplan-test.mjs）：
 *   1. **按出口分组的并行**：串行原本要保护的是「同一个出口不要连着敲」（同一张脸），
 *      而不同出口之间没有这个约束 —— 所以按出口分几队，**队间并行、队内串行**。
 *      队内仍然按 rateLimit 主动间隔。
 *   2. **连续失败隔离**：抓不到的来源（Cloudflare、失效站点）不再每轮白试，
 *      连续失败到阈值先安静几小时，之后自动再试。
 *   3. **降级阶梯**：失败不只是「换出口」，也可能是「这个抓取方式不行」——
 *      按 fetchLadder 依次尝试（来源也可以自己声明 fallbacks）。
 *
 * @param {Array} sources 生效来源（enabled = true）
 * @param {{cfg:object, log:object, fetchTable?:object}} ctx fetchTable 是测试接缝（默认用真实分派表）
 */
export async function fetchAll(sources, ctx) {
  const cfg = ctx.cfg;
  const table = ctx.fetchTable ?? TABLE;
  const rules = { ...QUARANTINE_DEFAULTS, ...(cfg?.run?.quarantine ?? {}) };
  let quarantine = loadQuarantine(cfg);

  const plan = planFetch(sources, (s) => resolveProxyMode(cfg, s), { quarantine, now: new Date(), rules });
  if (plan.quarantined.length) {
    const detail = plan.quarantined.map((q) => `${q.id}(还需 ${q.minutesLeft} 分钟)`).join(', ');
    ctx.log?.warn(`已隔离 ${plan.quarantined.length} 条连续失败的来源：${detail} —— 隔离期间不发请求，到点自动重试`);
  }
  if (plan.groups.length > 1) {
    ctx.log?.info(
      `抓取并发分组：${plan.groups.map((g) => `${g.mode}×${g.sources.length}`).join('、')}` +
        `（队间并行、队内串行：同一个出口不连着敲，但不同出口不必互相等）`,
    );
  }

  /** 用某种抓取方式试一次 */
  const attempt = async (src, kind, overrideUrl) => {
    const fn = table[kind];
    if (!fn) return { ok: false, error: `unknown fetch kind: ${kind}` };
    try {
      return await fn(overrideUrl ? { ...src, fetch: kind, url: overrideUrl } : { ...src, fetch: kind }, ctx);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  const runGroup = async (group) => {
    const out = [];
    let first = true;
    for (const s of group.sources) {
      const gapSeconds = s.rateLimit?.gapSeconds ?? cfg?.run?.defaultGapSeconds ?? 2;
      // 观测模式下间隔随机化：固定节奏（每次都精确 2 秒）本身就是机器特征。
      // base=0 时不抖（显式的「不要等」优先，诊断路径靠它）。
      const gap = gapWithJitter(gapSeconds, cfg?.observation?.enabled ? cfg?.observation?.jitterSeconds : null);
      if (!first && gap > 0) await sleep(gap * 1000);
      first = false;

      let usedEgress = s.proxy ?? (cfg?.proxy?.enabled ? 'proxy' : 'direct');
      let r = await attempt(s, s.fetch);
      if (!r.ok) ctx.log?.warn(`${s.id}: ${r.error ?? '抓取失败'}`);

      // ① 换出口重试一次（只在来源没显式指定出口时）
      if (!r?.ok) {
        const alt = otherEgress(cfg, s);
        if (alt) {
          ctx.log?.warn(`${s.id}: 失败，自动改用「${alt}」重试一次 / retrying via ${alt}`);
          const r2 = await attempt({ ...s, proxy: alt }, s.fetch);
          if (r2?.ok) {
            r2.failover = { from: usedEgress, to: alt, firstError: r?.error ?? null };
            usedEgress = alt;
            r = r2;
          } else {
            r = { ...r, failoverTried: alt, failoverError: r2?.error ?? null };
          }
        }
      }

      // ② 换抓取方式（降级阶梯）
      if (!r?.ok) {
        const ladder = fetchLadder(s);
        for (const step of ladder) {
          ctx.log?.warn(`${s.id}: 「${s.fetch}」不行，按阶梯改用「${step.fetch}」再试一次`);
          const r3 = await attempt(s, step.fetch, step.url);
          if (r3?.ok) {
            r3.ladder = { from: s.fetch, to: step.fetch, firstError: r?.error ?? null };
            r = r3;
            break;
          }
          r = { ...r, ladderTried: [...(r.ladderTried ?? []), step.fetch], ladderError: r3?.error ?? null };
        }
      }

      out.push({ source: s, egress: usedEgress, ...r });
      quarantine = recordOutcome(quarantine, s.id, { ok: !!r?.ok, error: r?.error ?? null });
    }
    return out;
  };

  // 队间并行；结果回到**输入顺序**，报告与断言才稳定
  const grouped = await Promise.all(plan.groups.map(runGroup));
  saveQuarantine(cfg, quarantine);

  const byId = new Map();
  for (const r of plan.skipped) byId.set(r.source.id, r);
  for (const r of grouped.flat()) byId.set(r.source.id, r);
  return (sources ?? []).map((s) => byId.get(s.id)).filter(Boolean);
}
