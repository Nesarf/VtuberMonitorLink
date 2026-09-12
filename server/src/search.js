// search.js - local search over everything collected
//
// Design stance (per the requirements): **search itself needs no LLM and no network**.
// It is a local index plus a keyword/tag/time-range matcher - like searching papers, like
// Ctrl+F in a browser: it works online or offline, with or without an LLM configured. The LLM
// only appears as an **optional** assistant for "I remember the traits but forgot the name".
//
// Index source: feeds/<date>/_items.json (the intel items each run writes to disk, history included).
// Tag source: automatic tags (source / category / keyword hits / #topic# and bracketed name
// markers in the body) plus tags typed by the user.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

const DAY_MS = 86_400_000;

// ───────────────────────────────────────── time normalization

/**
 * bilibili hands back relative times (Chinese strings such as "8 hours ago", "3 days ago",
 * "August 29"), so range filtering requires normalizing them first. The reference point is
 * **the run's generation time**, not "now" - otherwise revisiting history computes it wrong.
 */
export function parseItemTime(raw, referenceISO) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const ref = referenceISO ? new Date(referenceISO) : new Date();
  if (Number.isNaN(ref.getTime())) return null;

  let m = /^(\d+)\s*(秒|分钟|分|小时|时)前$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = /秒/.test(m[2]) ? 1000 : /分/.test(m[2]) ? 60_000 : 3_600_000;
    return new Date(ref.getTime() - n * unit).toISOString();
  }
  m = /^(\d+)\s*天前$/.exec(s);
  if (m) return new Date(ref.getTime() - Number(m[1]) * DAY_MS).toISOString();
  if (s === '昨天') return new Date(ref.getTime() - DAY_MS).toISOString();
  if (s === '前天') return new Date(ref.getTime() - 2 * DAY_MS).toISOString();
  if (/^今天|^\d+分钟前/.test(s)) return ref.toISOString();

  // The bare month/day shape, with or without a leading year (see the regex right below)
  m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) {
    const year = m[1] ? Number(m[1]) : ref.getFullYear();
    const d = new Date(year, Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    // no year and later than the reference point -> it means last year
    if (!m[1] && d.getTime() > ref.getTime() + 2 * DAY_MS) d.setFullYear(year - 1);
    return d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ───────────────────────────────────────── tag vocabulary

const DEFAULT_VOCAB = {
  // canonical name -> aliases (a hit on any alias counts as a hit on the tag)
  // Note: keys starting with a digit (2434 / 3D debut) must be quoted, or they are not valid identifiers
  个人势: ['個人勢', '个人势', 'indie', '个人势vtuber'],
  '2434': ['にじさんじ', '彩虹社', 'nijisanji', '2434'],
  马里奥赛车: ['マリオカート', '马车', 'mario kart', 'mariokart'],
  耐久回: ['耐久', '耐久配信', '耐久回'],
  联动: ['コラボ', 'collab', '联动', '合作'],
  毕业: ['卒業', 'graduation', '毕业'],
  炎上: ['炎上', '争议', '风波'],
  '3D披露': ['3Dお披露目', '3d披露', '3d debut'],
  新衣装: ['新衣装', '新服装', 'new outfit'],
  歌回: ['歌枠', '歌回', '唱歌'],
  杂谈: ['雑談', '杂谈', 'talk'],
  直播: ['配信', '直播', 'live'],
};

function vocabPath(cfg) {
  return path.join(resolveDir(cfg, 'feedsDir'), 'tags.json');
}

export function loadVocab(cfg) {
  try {
    const f = vocabPath(cfg);
    if (!fs.existsSync(f)) return { ...DEFAULT_VOCAB };
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULT_VOCAB, ...(j.tags ?? j) };
  } catch {
    return { ...DEFAULT_VOCAB };
  }
}

export function saveVocab(cfg, tags) {
  const f = vocabPath(cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ tags }, null, 1), 'utf8');
  return tags;
}

/** Expand one search term into all of its aliases */
export function expandTerm(vocab, term) {
  const t = String(term ?? '').trim();
  if (!t) return [];
  const lower = t.toLowerCase();
  for (const [canon, aliases] of Object.entries(vocab)) {
    const all = [canon, ...(aliases ?? [])];
    if (all.some((a) => String(a).toLowerCase() === lower)) return [...new Set(all.map(String))];
  }
  return [t];
}

// ───────────────────────────────────────── index

function listRunDirs(cfg, days) {
  const root = resolveDir(cfg, 'feedsDir');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()
    .slice(0, days);
}

/** Automatic tags: source / category / keyword hits / #topic# and bracketed name markers in the body */
export function autoTags(item) {
  const out = new Set();
  if (item.sourceId) out.add(`来源:${item.sourceId}`);
  if (item.category) out.add(`分类:${item.category}`);
  for (const k of item.keywords ?? []) out.add(String(k));
  // Features the LLM extracted become tags too, so "I only remember which game they played" still finds it
  for (const k of item.feats ?? []) out.add(String(k));
  for (const k of item.features?.names ?? []) out.add(String(k));
  const text = `${item.title ?? ''} ${item.text ?? ''}`;
  for (const m of text.matchAll(/[#＃]([^#＃\s]{1,20})[#＃]/g)) out.add(m[1]);
  for (const m of text.matchAll(/【([^】\s]{1,20})】/g)) out.add(m[1]);
  for (const m of text.matchAll(/\bat\s+([A-Za-z0-9_\u4e00-\u9fa5-]{2,24})/gi)) out.add(m[1]);
  return [...out];
}

/**
 * Build the index. Pass days to limit how far back it looks.
 * @returns {{items:Array, runs:Array, builtAt:string}}
 */
export function buildIndex(cfg, { days = 60, flags = {} } = {}) {
  const items = [];
  const runs = [];
  for (const d of listRunDirs(cfg, days)) {
    const dir = path.join(resolveDir(cfg, 'feedsDir'), d);
    for (const name of ['_items.json', '_items-prev.json']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const runAt = j.generatedAt ?? `${d}T12:00:00.000Z`;
        runs.push({ date: d, file: name, at: runAt, count: (j.items ?? []).length });
        for (const it of j.items ?? []) {
          const own = parseItemTime(it.time, runAt);
          const withTime = {
            ...it,
            runDate: d,
            runAt,
            // Some sources carry no publish time (bilibili's login-free image/text dynamics come
            // back with an empty pub_time). Fall back to "which run first saw it", otherwise a
            // time range would exclude these items as a batch.
            ts: own ?? runAt,
            tsSource: own ? 'item' : 'run',
            tags: [...new Set([...autoTags(it), ...((flags[it.id]?.tags ?? []) || [])])],
          };
          items.push(withTime);
        }
      } catch {
        /* skip broken files */
      }
    }
  }
  // Keep only the latest copy per id (later ones overwrite earlier ones)
  const byId = new Map();
  for (const it of items) byId.set(it.id, it);
  return { items: [...byId.values()], runs, builtAt: new Date().toISOString() };
}

// ───────────────────────────────────────── search

const FIELD_SETS = {
  any: (i) => `${i.title ?? ''} ${i.text ?? ''} ${i.url ?? ''} ${i.sourceName?.zh ?? ''} ${i.sourceName?.en ?? ''} ${(i.tags ?? []).join(' ')}`,
  title: (i) => `${i.title ?? ''}`,
  text: (i) => `${i.text ?? ''}`,
  url: (i) => `${i.url ?? ''}`,
  tag: (i) => (i.tags ?? []).join(' '),
  source: (i) => `${i.sourceId ?? ''} ${i.sourceName?.zh ?? ''} ${i.sourceName?.en ?? ''}`,
};

function tokenize(q) {
  return String(q ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Search. Pure string matching - no LLM, no network.
 * @param {object} cfg
 * @param {{q?:string, tags?:string[], source?:string, category?:string, from?:string, to?:string,
 *          field?:string, starred?:boolean, limit?:number, offset?:number, sort?:string, days?:number}} query
 */
export function search(cfg, query = {}, flags = {}) {
  const t0 = Date.now();
  const idx = buildIndex(cfg, { days: Number(query.days) || 60, flags });
  const vocab = loadVocab(cfg);
  const field = FIELD_SETS[query.field] ? query.field : 'any';
  const pick = FIELD_SETS[field];

  const tokens = tokenize(query.q);
  // Each term expands into a group of aliases; a hit on any alias in the group counts
  const groups = tokens.map((t) => expandTerm(vocab, t).map((x) => x.toLowerCase()));
  const wantTags = (query.tags ?? []).filter(Boolean);

  const from = query.from ? Date.parse(query.from) : null;
  const to = query.to ? Date.parse(query.to) + DAY_MS : null;

  const matched = [];
  let timeFiltered = 0;
  for (const it of idx.items) {
    if (query.source && it.sourceId !== query.source) continue;
    if (query.category && it.category !== query.category) continue;
    if (query.starred && !flags[it.id]?.starred) continue;

    if (from !== null || to !== null) {
      const ts = it.ts ? Date.parse(it.ts) : NaN;
      if (Number.isNaN(ts) || (from !== null && ts < from) || (to !== null && ts > to)) {
        timeFiltered++;
        continue;
      }
    }

    if (wantTags.length) {
      const has = (it.tags ?? []).map((x) => String(x).toLowerCase());
      const ok = wantTags.every((tg) => {
        const aliases = expandTerm(vocab, tg).map((x) => x.toLowerCase());
        return aliases.some((a) => has.some((h) => h === a || h.includes(a)));
      });
      if (!ok) continue;
    }

    if (groups.length) {
      const hay = pick(it).toLowerCase();
      let score = 0;
      let all = true;
      for (const g of groups) {
        const hit = g.some((a) => hay.includes(a));
        if (!hit) {
          all = false;
          break;
        }
        for (const a of g) {
          let p = hay.indexOf(a);
          while (p !== -1) {
            score++;
            p = hay.indexOf(a, p + a.length);
          }
        }
      }
      if (!all) continue;
      matched.push({ ...it, score });
    } else {
      matched.push({ ...it, score: 0 });
    }
  }

  const sort = query.sort === 'time' ? 'time' : 'relevance';
  matched.sort((a, b) => {
    if (sort === 'time') return Date.parse(b.ts ?? b.runAt) - Date.parse(a.ts ?? a.runAt);
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.ts ?? b.runAt) - Date.parse(a.ts ?? a.runAt);
  });

  // Facets (the counts you see down the left of a paper search)
  const facet = (list, keyFn) => {
    const m = new Map();
    for (const it of list) for (const k of keyFn(it)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };
  const facets = {
    tags: facet(matched, (i) => i.tags ?? []).slice(0, 40),
    sources: facet(matched, (i) => [i.sourceId]).slice(0, 40),
    categories: facet(matched, (i) => [i.category].filter(Boolean)),
    months: facet(matched, (i) => (i.ts ? [i.ts.slice(0, 7)] : [])).sort((a, b) => (a.value < b.value ? 1 : -1)).slice(0, 24),
  };

  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.max(1, Math.min(500, Number(query.limit) || 60));
  return {
    total: matched.length,
    offset,
    limit,
    took: Date.now() - t0,
    sort,
    field,
    terms: tokens,
    expanded: groups,
    corpus: { items: idx.items.length, runs: idx.runs.length, days: Number(query.days) || 60 },
    // Items that have a time but fall outside the range - so the user knows "it is not that
    // nothing was found, it was filtered out by the time condition"
    outsideTimeRange: timeFiltered,
    facets,
    items: matched.slice(offset, offset + limit),
  };
}

/** Vocabulary + corpus stats, used by the search page to build the tag cloud */
export function tagCloud(cfg, flags = {}) {
  const idx = buildIndex(cfg, { days: 60, flags });
  const vocab = loadVocab(cfg);
  const counts = new Map();
  for (const it of idx.items) for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const auto = [...counts.entries()]
    .filter(([t]) => !t.startsWith('来源:'))
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 120);
  return {
    corpus: { items: idx.items.length, runs: idx.runs.length },
    vocabulary: Object.entries(vocab).map(([canon, aliases]) => ({ canon, aliases, count: counts.get(canon) ?? 0 })),
    auto,
  };
}

/** Corpus digest for the LLM assistant (only used when the frontend clicks "help me identify people") */
export function corpusSample(cfg, limit = 200) {
  const idx = buildIndex(cfg, { days: 30 });
  return idx.items
    .slice(0, limit)
    .map((i) => `${i.sourceId} | ${String(i.text || i.title).replace(/\s+/g, ' ').slice(0, 90)}`);
}
