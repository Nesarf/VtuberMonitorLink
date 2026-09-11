// fetchers/index.js — 按 source.fetch 分派 / dispatch by adapter kind
import { fetchRss } from './rss.js';
import { fetchMediaWiki } from './mediawiki.js';
import { fetchBrowser } from './browser.js';
import { fetchSearchOnly } from './search.js';
import { fetchBilibiliOpus, fetchBilibiliDynamic } from './bilibili.js';
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
 * 依次抓取选中的来源（顺序执行，便于按 rateLimit 主动间隔）
 * @param {Array} sources 生效来源（enabled = true）
 * @param {{cfg:object, log:object}} ctx
 */
export async function fetchAll(sources, ctx) {
  const results = [];
  let first = true;
  for (const s of sources) {
    const gapSeconds = s.rateLimit?.gapSeconds ?? ctx.cfg?.run?.defaultGapSeconds ?? 2;
    if (!first && gapSeconds > 0) await sleep(gapSeconds * 1000);
    first = false;

    const fn = TABLE[s.fetch];
    if (!fn) {
      ctx.log?.warn(`${s.id}: 未知抓取方式 / unknown fetch kind: ${s.fetch}`);
      results.push({ source: s, ok: false, error: `unknown fetch kind: ${s.fetch}` });
      continue;
    }

    let r = null;
    let usedEgress = s.proxy ?? (ctx.cfg?.proxy?.enabled ? 'proxy' : 'direct');
    try {
      r = await fn(s, ctx);
    } catch (err) {
      ctx.log?.error(`${s.id}: ${err.message}`);
      r = { ok: false, error: err.message };
    }

    // 自动换出口重试一次
    if (!r?.ok) {
      const alt = otherEgress(ctx.cfg, s);
      if (alt) {
        ctx.log?.warn(`${s.id}: 失败，自动改用「${alt}」重试一次 / retrying via ${alt}`);
        try {
          const r2 = await fn({ ...s, proxy: alt }, ctx);
          if (r2?.ok) {
            r2.failover = { from: usedEgress, to: alt, firstError: r?.error ?? null };
            usedEgress = alt;
            r = r2;
          } else {
            r = { ...r, failoverTried: alt, failoverError: r2?.error ?? null };
          }
        } catch (err) {
          r = { ...r, failoverTried: alt, failoverError: err.message };
        }
      }
    }

    results.push({ source: s, egress: usedEgress, ...r });
  }
  return results;
}
