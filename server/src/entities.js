// entities.js — 人物档案 / entity aggregation
//
// 特征抽取（features.js）已经把条目里的**人名**抽出来了，这里把它们聚合成「对象」：
// 一个人出现过哪些条目、属于哪个事务所、玩什么游戏、涉及哪些事件、从何时到何时活跃。
// 这是从「条目流」升级到「对象库」的那一步 —— 也是继续做关系图、粉丝曲线的地基。
//
// 纯本地统计，不需要 LLM、不需要联网：只读 feeds/features.json 与 feeds/*/_items.json。
import { resolveDir } from './config.js';
import { buildIndex } from './search.js';
import { loadFeatureCache } from './features.js';

/** 把同一个人名的各种写法归并（大小写、空格、全半角） */
export function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·・.]/g, '');
}

/**
 * 聚合人物。
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
          name: raw, // 展示用，取第一次见到的写法
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
      // 最近一条正文，列表里当摘要用
      sample: String(e.items.find((i) => (i.text ?? '').length > 4)?.text ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }))
    .sort((a, b) => b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

/** 单个对象的详情：它的全部条目 + 时间线 */
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
