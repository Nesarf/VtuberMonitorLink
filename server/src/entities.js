// entities.js — entity aggregation
//
// Feature extraction (features.js) already pulls the **person names** out of items; this module
// aggregates them into "objects": which items a person appeared in, which agency they belong to,
// which games they play, which events they are involved in, and when they were active.
// This is the step from "item stream" up to "object library" — and the foundation for the
// relationship graph and the follower curve that come next.
//
// Purely local statistics: no LLM, no network. It only reads feeds/features.json and feeds/*/_items.json.
import { resolveDir } from './config.js';
import { buildIndex } from './search.js';
import { loadFeatureCache } from './features.js';

/** Collapse the various spellings of one person name (case, spaces, full/half width) */
export function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・.]/g, '');
}

/**
 * Aggregate people.
 * @param {object} cfg
 * @param {{min?:number, days?:number, flags?:object}} opts
 */
export function listEntities(cfg, opts = {}) {
  const min = Math.max(1, Number(opts.min) || 1);
  const flags = opts.flags ?? {};
  const idx = buildIndex(cfg, { days: Number(opts.days) || 60, flags });
  const cache = loadFeatureCache(cfg);

  const byKey = new Map();
  for (const it of idx.items) {
    const f = cache[it.id];
    if (!f || f.empty) continue;
    for (const raw of f.names ?? []) {
      const key = normalizeName(raw);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name: raw, // for display: keep the first spelling seen
          aliases: new Set(),
          items: [],
          agencies: new Map(),
          games: new Map(),
          events: new Map(),
          sources: new Map(),
          firstAt: null,
          lastAt: null,
        });
      }
      const e = byKey.get(key);
      e.aliases.add(String(raw));
      e.items.push(it);
      if (f.agency) e.agencies.set(f.agency, (e.agencies.get(f.agency) ?? 0) + 1);
      for (const g of f.games ?? []) e.games.set(g, (e.games.get(g) ?? 0) + 1);
      for (const v of f.events ?? []) e.events.set(v, (e.events.get(v) ?? 0) + 1);
      e.sources.set(it.sourceId, (e.sources.get(it.sourceId) ?? 0) + 1);
      const ts = it.ts ? Date.parse(it.ts) : null;
      if (ts) {
        if (!e.firstAt || ts < e.firstAt) e.firstAt = ts;
        if (!e.lastAt || ts > e.lastAt) e.lastAt = ts;
      }
      if (f.indie) e.indie = true;
    }
  }

  const top = (m, n = 6) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));

  return [...byKey.values()]
    .filter((e) => e.items.length >= min)
    .map((e) => ({
      key: e.key,
      name: e.name,
      aliases: [...e.aliases],
      count: e.items.length,
      sources: top(e.sources, 8),
      agencies: top(e.agencies, 3),
      games: top(e.games, 8),
      events: top(e.events, 8),
      indie: !!e.indie,
      firstAt: e.firstAt ? new Date(e.firstAt).toISOString() : null,
      lastAt: e.lastAt ? new Date(e.lastAt).toISOString() : null,
      // body text of the most recent item, used as the summary in the list
      sample: String(e.items.find((i) => (i.text ?? '').length > 4)?.text ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }))
    .sort((a, b) => b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

/** Detail of one object: all of its items plus a timeline */
export function entityDetail(cfg, name, opts = {}) {
  const wanted = normalizeName(name);
  const all = listEntities(cfg, { ...opts, min: 1 });
  const found = all.find((e) => e.key === wanted || e.aliases.some((a) => normalizeName(a) === wanted));
  if (!found) return null;
  const idx = buildIndex(cfg, { days: Number(opts.days) || 60, flags: opts.flags ?? {} });
  const cache = loadFeatureCache(cfg);
  const items = idx.items
    .filter((it) => (cache[it.id]?.names ?? []).some((n) => normalizeName(n) === wanted))
    .sort((a, b) => Date.parse(b.ts ?? b.runAt) - Date.parse(a.ts ?? a.runAt));
  return { ...found, items: items.slice(0, 200) };
}

export function entityStats(cfg, flags = {}) {
  const list = listEntities(cfg, { min: 1, flags });
  return {
    total: list.length,
    withMultiple: list.filter((e) => e.count > 1).length,
    top: list.slice(0, 30),
  };
}

export { resolveDir };
