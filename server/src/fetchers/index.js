// fetchers/index.js — dispatch by adapter kind (source.fetch)
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

/** the fetch kinds offered on the web page (used by the custom-source editor) */
export const FETCH_KINDS = [
  { id: 'rss', zh: 'RSS / Atom 订阅', en: 'RSS / Atom feed' },
  { id: 'mediawiki-api', zh: 'MediaWiki API（最近更改）', en: 'MediaWiki API (recent changes)' },
  { id: 'browser', zh: '浏览器渲染（可复用登录）', en: 'Browser render (can reuse a login)' },
  { id: 'bili-opus', zh: 'B 站图文动态（免登录）', en: 'bilibili image/text dynamics (no login)' },
  { id: 'bili-dynamic', zh: 'B 站完整动态（需登录，含配图）', en: 'bilibili full dynamics (login, with pictures)' },
  { id: 'search-only', zh: '仅交给检索阶段', en: 'Search stage only' },
];

/**
 * Whether a failure should be retried over the other egress.
 * Only switch when the source **has no explicitly pinned egress** — for a source like bilibili,
 * where "pin it to direct or you get rate-limited", auto-switching to the proxy only makes it worse.
 */
function otherEgress(cfg, source) {
  if (cfg?.run?.autoFailover === false) return null;
  if (source?.proxy) return null; // already pinned explicitly, respect it
  return cfg?.proxy?.enabled && cfg?.proxy?.url ? 'direct' : 'proxy';
}

/**
 * Fetch the selected sources.
 *
 * Three policies (the pure logic lives in fetchplan.js, self-tested by fetchplan-test.mjs):
 *   1. **Parallelism grouped by egress**: what serialization used to protect was "do not hammer the
 *      same egress back to back" (one and the same face), and different egresses carry no such
 *      constraint — so split into one queue per egress, **parallel across queues, serial within one**.
 *      Inside a queue the rateLimit gap is still applied on purpose.
 *   2. **Quarantine after repeated failures**: sources we cannot fetch (Cloudflare, dead sites) stop
 *      being retried for nothing every round; once failures hit the threshold they go quiet for a few
 *      hours and are then retried automatically.
 *   3. **Degradation ladder**: a failure is not only "switch egress", it can also be "this fetch kind
 *      does not work" — walk fetchLadder in order (a source may also declare its own fallbacks).
 *
 * @param {Array} sources effective sources (enabled = true)
 * @param {{cfg:object, log:object, fetchTable?:object}} ctx fetchTable is the test seam (the real dispatch table by default)
 */
export async function fetchAll(sources, ctx) {
  const cfg = ctx.cfg;
  const table = ctx.fetchTable ?? TABLE;
  const rules = { ...QUARANTINE_DEFAULTS, ...(cfg?.run?.quarantine ?? {}) };
  let quarantine = loadQuarantine(cfg);

  const plan = planFetch(sources, (s) => resolveProxyMode(cfg, s), { quarantine, now: new Date(), rules });
  if (plan.quarantined.length) {
    const detail = plan.quarantined.map((q) => `${q.id} (${q.minutesLeft} min left)`).join(', ');
    ctx.log?.warn(
      `quarantined ${plan.quarantined.length} sources with repeated failures: ${detail} — no requests go out while quarantined, they are retried automatically once it expires`
    );
  }
  if (plan.groups.length > 1) {
    ctx.log?.info(
      `fetch concurrency groups: ${plan.groups.map((g) => `${g.mode}x${g.sources.length}`).join(', ')}` +
        ` (parallel across queues, serial within one: the same egress is never hammered back to back, but different egresses need not wait for each other)`,
    );
  }

  /** try one fetch kind once */
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
      // In observation mode the gap is randomized: a fixed rhythm (exactly 2 seconds every time) is itself a machine fingerprint.
      // No jitter at base=0 (an explicit "do not wait" wins, and the diagnostic path relies on it).
      const gap = gapWithJitter(gapSeconds, cfg?.observation?.enabled ? cfg?.observation?.jitterSeconds : null);
      if (!first && gap > 0) await sleep(gap * 1000);
      first = false;

      let usedEgress = s.proxy ?? (cfg?.proxy?.enabled ? 'proxy' : 'direct');
      let r = await attempt(s, s.fetch);
      if (!r.ok) ctx.log?.warn(`${s.id}: ${r.error ?? 'fetch failed'}`);

      // ① retry once over the other egress (only when the source did not pin one)
      if (!r?.ok) {
        const alt = otherEgress(cfg, s);
        if (alt) {
          ctx.log?.warn(`${s.id}: failed, retrying once over "${alt}"`);
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

      // ② switch fetch kind (degradation ladder)
      if (!r?.ok) {
        const ladder = fetchLadder(s);
        for (const step of ladder) {
          ctx.log?.warn(`${s.id}: "${s.fetch}" did not work, stepping down the ladder to "${step.fetch}" and trying once more`);
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

  // parallel across queues; results come back in **input order** so reports and assertions stay stable
  const grouped = await Promise.all(plan.groups.map(runGroup));
  saveQuarantine(cfg, quarantine);

  const byId = new Map();
  for (const r of plan.skipped) byId.set(r.source.id, r);
  for (const r of grouped.flat()) byId.set(r.source.id, r);
  return (sources ?? []).map((s) => byId.get(s.id)).filter(Boolean);
}
