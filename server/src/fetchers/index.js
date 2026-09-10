// fetchers/index.js — 按 source.fetch 分派 / dispatch by adapter kind
import { fetchRss } from './rss.js';
import { fetchMediaWiki } from './mediawiki.js';
import { fetchBrowser } from './browser.js';
import { fetchSearchOnly } from './search.js';
import { setTimeout as sleep } from 'node:timers/promises';

const TABLE = {
  rss: fetchRss,
  'mediawiki-api': fetchMediaWiki,
  browser: fetchBrowser,
  'search-only': fetchSearchOnly,
};

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
    try {
      const r = await fn(s, ctx);
      results.push({ source: s, ...r });
    } catch (err) {
      ctx.log?.error(`${s.id}: ${err.message}`);
      results.push({ source: s, ok: false, error: err.message });
    }
  }
  return results;
}
