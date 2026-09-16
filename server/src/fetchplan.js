// fetchplan.js — fetch scheduling decisions: parallel per egress, quarantine of repeatedly failing sources,
// fetch-method fallback ladder
//
// Why it is factored out: all three are *policy*, and policy is exactly what tends to end up as an if
// buried inside a loop, which leaves it untestable and makes it impossible to say what the scheduling
// actually does right now. Everything here is a pure function, and the self-check
// (tools/fetchplan-test.mjs) pins the behavior down with fixed times and a fixed failure sequence.
//
// Why each of the three policies exists:
//   1. **Parallel per egress**: fetching used to be strictly serial with a deliberate delay, so 24 sources
//      took minutes per round. But what "serial" really protects is **the identity of one egress** (do not
//      knock with the same face back to back), and no such constraint exists between different egresses.
//      So sources are grouped by egress into a few teams: **teams in parallel, serial within a team** --
//      the footprint is unchanged, the wall time is cut by more than half.
//   2. **Quarantine after repeated failures**: sources that cannot be fetched (Cloudflare, unreachable sites)
//      get retried every round, which is wasted time and, worse, extra requests -- and requests are footprint.
//      After N consecutive failures the source goes quiet for M hours, then is retried automatically (not a blacklist).
//   3. **Fallback ladder**: on failure we currently only switch egress, never the fetch method. Some failures
//      mean "this method is unusable here" rather than "this egress does not work" (e.g. only RSS is left usable
//      on that site). The ladder only carries **defensible** transitions, and a source may declare its own
//      fallbacks.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/** Fallbacks allowed between fetch methods (conservative table: only transitions that justify themselves) */
export const FETCH_LADDER = {
  // MediaWiki API unusable (blocked by Cloudflare, or the API was turned off) -> render the same page with a browser
  'mediawiki-api': ['browser'],
  // RSS unavailable (feed dead/blocked) -> fetch the same URL with a browser
  rss: ['browser'],
  browser: [],
  'search-only': [],
};

/**
 * In what order this source may try fetch methods.
 * Order: the fallbacks the source declares itself (first) -> the built-in ladder -> dedupe, drop itself.
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

// ───────────────────────────────────────────── failure quarantine

export const QUARANTINE_DEFAULTS = { failures: 3, hours: 6 };

function quarantinePath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'quarantine.json');
}

export function loadQuarantine(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(quarantinePath(cfg), 'utf8'));
    if (raw && typeof raw === 'object' && raw.sources) return { sources: raw.sources };
  } catch {
    /* start from empty when there is none */
  }
  return { sources: {} };
}

export function saveQuarantine(cfg, state) {
  const p = quarantinePath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ sources: state.sources ?? {} }, null, 2) + '\n', 'utf8');
  } catch {
    /* failing to record it does not affect this round */
  }
}

/** Should this source be quarantined right now (and if so, why, and for how much longer)? */
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
 * Record one fetch outcome and return the new quarantine state.
 * Success -> reset the counter to zero (the quarantine lifts by itself); failure -> count up, and once the
 * threshold is reached quarantine for M hours.
 */
export function recordOutcome(state, id, { ok, error = null, now = new Date(), rules = QUARANTINE_DEFAULTS } = {}) {
  const next = { sources: { ...(state?.sources ?? {}) } };
  if (ok) {
    delete next.sources[id];
    return next;
  }
  const prev = next.sources[id];
  // Already quarantined: keep the original deadline (one more failure must not extend it forever)
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

// ───────────────────────────────────────────── schedule plan

/**
 * Split the sources into a schedule plan "grouped by egress".
 *
 * Order is preserved within a group (the delay comes from rateLimit and is the caller's decision); groups
 * may run in parallel.
 * @param {Array} sources
 * @param {(source:object)=>string} resolveMode which egress this source actually takes
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
    // Observation mode already drops logged-in sources in observe.js; here we only handle egress grouping
    const mode = resolveMode(s) ?? 'direct';
    if (!byMode.has(mode)) byMode.set(mode, []);
    byMode.get(mode).push(s);
  }

  // A stable group order (direct -> proxy -> tor), so that logs read well and tests assert well
  const order = ['direct', 'proxy', 'tor'];
  const groups = [...byMode.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([mode, list]) => ({ mode, sources: list }));

  return { groups, skipped, quarantined };
}
