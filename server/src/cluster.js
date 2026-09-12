// cluster.js — multi-source same-event merging / similarity dedupe / source weights
//
// The problem it solves: one and the same thing gets reported once by every source (official announcement +
// news site + community repost), so the user's feed is flooded with three copies. Worse still for
// "early warning": duplicates dilute the signal-to-noise ratio and make people miss what is genuinely new.
//
// Three parts:
//   1) **Similarity**: Chinese has no word boundaries, so it uses **character bigrams** (a 4-character CJK
//      title becomes its 4 single characters plus its 3 adjacent bigrams); Latin text uses word tokens.
//      The two are combined into a Dice coefficient.
//   2) **Clustering**: single-pass incremental clustering + a time window. "The same thing" means
//      "the text is similar enough **and** the time is close enough"; text alone would also pull in
//      "the same event from last year".
//   3) **Source weights**: official announcement > news site > community repost. Beyond a static baseline,
//      it **learns from history**: whoever reported it first (earliest within each event cluster) is more
//      trustworthy. This backs "multi-source confirmation" and "source ranking", and it also tells the user
//      whether something has already been confirmed by several parties.
//
// Performance: no O(n^2) all-pairs comparison - bucket by calendar day first and compare only within the
// same and neighbouring buckets, with each item compared against at most CANDIDATE_CAP candidates.
// Even 2000 items finish in milliseconds.

/** Latin stop words: these are nearly meaningless in a title, and letting them into the similarity only raises false positives */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'new', 'news',
  'official', 'announce', 'announcement', 'update', 'info', 'release', 'about', 'from',
  'is', 'are', 'was', 'be', 'by', 'at', 'as', 'it', 'its', 'this', 'that', 'we', 'you',
]);

export const DEFAULT_THRESHOLD = 0.52;
export const DEFAULT_WINDOW_HOURS = 72;
const CANDIDATE_CAP = 60;

/** CJK unified ideographs + kana + Hangul */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/**
 * Split text into the tokens used for comparison.
 * - CJK: single characters + adjacent bigrams (bigrams give precision, single characters give recall)
 * - Latin: lowercased words (stop words and single-character words dropped)
 * - dates/numbers are kept separately - a date like "March 15" is a strong signal of event identity
 */
export function tokens(text) {
  const s = String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .toLowerCase();
  const out = new Set();
  // number strings (including dates): 3 15 2026 / 3.15 and the like
  for (const m of s.matchAll(/\d+/g)) if (m[0].length >= 2 || /^\d$/.test(m[0])) out.add('#' + m[0]);

  const cjk = [...s].filter((c) => CJK.test(c));
  for (const c of cjk) out.add(c);
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk[i] + cjk[i + 1]);

  const latin = s
    .replace(/[^\p{Script=Latin}\p{Nd}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  for (const w of latin) out.add(w);
  return out;
}

/** Dice coefficient: 2|A∩B| / (|A|+|B|), a bit more forgiving of length differences than Jaccard */
export function similarity(a, b) {
  const A = a instanceof Set ? a : tokens(a);
  const B = b instanceof Set ? b : tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Document frequency -> IDF weight.
 *
 * Why weighting is mandatory: news titles are full of **cheap high-frequency boilerplate**
 * ("official announcement", "latest news", "will be held on ..."), and it makes any two titles look
 * alike. IDF drops "words that are all over this batch" to almost no score and leaves only the content
 * words that really separate events (people, dates, event names). This is the easiest step to overlook
 * in a "similarity" feature, and the most critical one.
 */
export function buildIdf(tokenSets) {
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, tokenSets.length);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(n / d) + 1);
  return idf;
}

/** IDF-weighted Dice: ratio of weight sums */
export function weightedSimilarity(A, B, idf) {
  if (!A?.size || !B?.size) return 0;
  const w = (t) => idf?.get(t) ?? 1;
  let inter = 0;
  let total = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) {
    const weight = w(t);
    total += weight;
    if (big.has(t)) inter += weight;
  }
  for (const t of big) if (!small.has(t)) total += w(t);
  if (!total) return 0;
  return (2 * inter) / total;
}

function tsOf(item) {
  const raw = item?.publishedAt ?? item?.at ?? item?.ts ?? item?.time ?? null;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Item text: the title weighs more, so the title also takes part in the comparison on its own */
function textOf(item) {
  const parts = [item?.title, item?.text, item?.summary, item?.contentText, item?.content].filter(Boolean);
  return parts.join(' ').slice(0, 1200);
}

// --------------------------------------------- source weights

/** Static baseline: the further upstream, the more trustworthy. Can be overridden per source in the config. */
export const BASE_WEIGHT = {
  official: 1.5, // official announcement
  news: 1.2, // news site
  wiki: 1.0,
  bili: 1.1, // the person's own account feed
  live: 0.9,
  resource: 0.9,
  community: 0.8, // community repost
  social: 0.7, // social platforms (the noisiest)
  custom: 1.0,
  other: 1.0,
};

export function weightPath(cfg) {
  return null; // the caller supplies the directory, see loadWeights
}

/**
 * Compute the current weight of every source.
 * @param {object} cfg
 * @param {object} history { firstSeen: { [sourceId]: n }, totalEvents: n }
 * @returns {(sourceId:string)=>number}
 */
export function makeWeighter(cfg, history = {}) {
  const overrides = cfg?.sourceWeights ?? {};
  const seen = history?.firstSeen ?? {};
  const total = Math.max(1, history?.totalEvents ?? 0);
  const cache = new Map();
  return (sourceId) => {
    if (!sourceId) return 1;
    if (cache.has(sourceId)) return cache.get(sourceId);
    const cat = String(sourceId).split('-')[0];
    const base = Number(overrides[sourceId] ?? BASE_WEIGHT[cat] ?? BASE_WEIGHT.other);
    // "first to report" ratio: 0 times -> no bonus; consistently first -> up to +40%
    const rate = (seen[sourceId] ?? 0) / total;
    const learned = 1 + Math.min(0.4, rate);
    const w = Math.max(0.2, Math.min(3, base * learned));
    cache.set(sourceId, w);
    return w;
  };
}

/**
 * Record one "who reported it first". Used so the weights can grow out of history.
 * @returns {object} the new history
 */
export function recordFirstReporter(history, sourceId) {
  const h = { firstSeen: { ...(history?.firstSeen ?? {}) }, totalEvents: (history?.totalEvents ?? 0) + 1 };
  if (sourceId) h.firstSeen[sourceId] = (h.firstSeen[sourceId] ?? 0) + 1;
  return h;
}

// --------------------------------------------- clustering

/** Monotonically increasing cluster id, keeping results stable (it never looks at the input order) */
function clusterId(seed) {
  return 'ev-' + String(seed).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

/**
 * Group items into "events".
 * @param {object[]} items
 * @param {object} opts
 * @param {(id:string)=>number} opts.weight source weight function
 * @param {number} opts.threshold Dice threshold
 * @param {number} opts.windowHours time window (beyond it, not the same event)
 * @param {number} opts.max how many items to process at most (guards against an accidental flood)
 */
/**
 * The "must share a rare token" gate.
 *
 * Why it is needed: news titles are largely built from **boilerplate** ("official announcement: ...
 * will be held on ..."), so on weighted similarity alone two titles differing by a single number also
 * look alike - and a run of items gets chained into one big cluster (measured: 2000 synthetic items
 * merged into 1 event). The same event always shares at least one token that is **rare in this batch**
 * (a person, an event name, a special date). Sharing only boilerplate does not make it the same event.
 */
function sharesRareToken(A, B, idf, docCount) {
  const rareDf = Math.max(2, Math.ceil(docCount * 0.05));
  const rareIdf = Math.log(Math.max(2, docCount) / rareDf) + 1;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t) && (idf.get(t) ?? 1) >= rareIdf) return true;
  return false;
}

/** Number/date tokens: a strong signal of event identity (the '#15' kind) */
function numberTokens(set) {
  return [...set].filter((t) => t.startsWith('#'));
}

/** Whether the two number sets intersect; returns true when neither side has a number (nothing to compare, so no veto) */
function numbersCompatible(A, B) {
  const a = numberTokens(A);
  const b = numberTokens(B);
  if (!a.length && !b.length) return true;
  const bs = new Set(b);
  return a.some((t) => bs.has(t));
}

export function cluster(items, opts = {}) {
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  const windowMs = Number(opts.windowHours ?? DEFAULT_WINDOW_HOURS) * 3600_000;
  const weigh = opts.weight ?? (() => 1);
  const max = Number(opts.max ?? 4000);

  // WARNING: normalize the ordering first. Greedy/single-link both depend on the processing order, and
  // taking the input order as-is makes the same batch produce different results when reordered (the
  // "independent of input order" case in the self-test is what catches exactly this).
  const list = (items ?? [])
    .filter(Boolean)
    .slice(0, max)
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ta = tsOf(a.it);
      const tb = tsOf(b.it);
      if (ta === null && tb !== null) return 1;
      if (tb === null && ta !== null) return -1;
      if (ta !== tb) return (ta ?? 0) - (tb ?? 0);
      return String(a.it.id ?? a.i).localeCompare(String(b.it.id ?? b.i));
    })
    .map((x) => x.it);

  const prepared = list.map((it, i) => ({
    item: it,
    tokens: tokens(textOf(it)),
    titleTokens: tokens(it?.title ?? ''),
    ts: tsOf(it),
    idx: i,
    people: new Set(it?.people ?? []),
  }));
  const idf = buildIdf(prepared.map((p) => p.tokens));
  const docCount = prepared.length;

  // bucket by calendar day first and compare only within the same and neighbouring buckets - no O(n^2)
  const buckets = new Map();
  const dayOf = (p) => (p.ts === null ? 'unknown' : new Date(p.ts).toISOString().slice(0, 10));
  prepared.forEach((p, i) => {
    const d = dayOf(p);
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(i);
  });

  // -- Single link: connect every pair of items that are "similar enough", then merge them into
  // connected components with a union-find. Union-find rather than "seed + absorb": the latter leaves
  // earlier items stranded (i1~i3 are similar and i2~i3 are similar, but i1~i2 is not -> three items
  // that are really one event end up as two clusters).
  const parent = prepared.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // take the smaller index to stay stable
  };

  let edges = 0;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const day = dayOf(p);
    const candidateDays = p.ts === null ? [...buckets.keys()] : neighbourDays(day);
    const candidates = [];
    for (const d of candidateDays) for (const j of buckets.get(d) ?? []) if (j > i) candidates.push(j);
    candidates.sort((a, b) => Math.abs((prepared[a].ts ?? 0) - (p.ts ?? 0)) - Math.abs((prepared[b].ts ?? 0) - (p.ts ?? 0)));

    let compared = 0;
    for (const j of candidates) {
      if (compared++ >= CANDIDATE_CAP) break;
      const q = prepared[j];
      if (p.ts !== null && q.ts !== null && Math.abs(p.ts - q.ts) > windowMs) continue;
      const sim = weightedSimilarity(p.tokens, q.tokens, idf);
      const titleSim = weightedSimilarity(p.titleTokens, q.titleTokens, idf);
      const score = Math.max(sim, titleSim * 0.95);
      // Gate: they must share a token that is rare in this batch, **or** the two must be nearly
      // identical with matching numbers/dates.
      //
      // Both conditions were paid for in blood:
      //  - rare tokens alone -> in duplicate reports whose content is identical, every token's df
      //    equals the document count, not one rare token is left, and the genuine duplicates are all
      //    missed (20 identical items, not a single one merged).
      //  - adding only "similarity >= 0.8" -> two items differing by a single id get merged as well
      //    (60 items that are 60 separate events got chained into 1 cluster). So one more condition:
      //    numbers/dates must be compatible - a true duplicate obviously has matching numbers, while
      //    two items differing only by an id are not the same event.
      if (!sharesRareToken(p.tokens, q.tokens, idf, docCount)) {
        if (score < 0.8 || !numbersCompatible(p.tokens, q.tokens)) continue;
      }
      const samePerson = p.people.size && q.people.size && [...p.people].some((x) => q.people.has(x));
      // Both sides are tagged with people but the people differ -> the bar goes up a lot: once a wrong
      // merge happens, it means hanging A's event on B, the hardest error to spot and the one with the
      // heaviest consequences
      const disjointPeople = p.people.size > 0 && q.people.size > 0 && !samePerson;
      let need = threshold;
      if (samePerson && titleSim >= 0.3) need = Math.min(threshold, 0.38);
      else if (disjointPeople) need = Math.max(threshold, 0.78);
      if (score < need) continue;
      union(i, j);
      edges++;
    }
  }

  const groups = new Map();
  for (let i = 0; i < prepared.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const built = [...groups.values()].map((ms, k) => buildCluster(k, ms.map((m) => prepared[m]), weigh, { edges }));

  // stable ordering: by time first (unknown time last), then by weight
  built.sort((a, b) => {
    const ta = a.firstAt ? Date.parse(a.firstAt) : -1;
    const tb = b.firstAt ? Date.parse(b.firstAt) : -1;
    return tb - ta || b.weight - a.weight;
  });
  return built;
}

function neighbourDays(day) {
  const base = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(base)) return [day];
  return [0, -1, 1].map((d) => new Date(base + d * 86400000).toISOString().slice(0, 10));
}

function buildCluster(seed, members, weigh, meta = {}) {
  const items = members.map((m) => m.item);
  const times = members.map((m) => m.ts).filter((t) => t !== null).sort((a, b) => a - b);
  const sources = [...new Set(items.map((i) => i.sourceId).filter(Boolean))];
  const weighed = items
    .map((it) => ({ it, w: weigh(it.sourceId) }))
    .sort((a, b) => b.w - a.w || String(a.it.id).localeCompare(String(b.it.id)));
  const best = weighed[0]?.it ?? items[0] ?? {};
  // the source that reported it first: multi-source confirmation and "learned weights" both use it
  const earliest = members
    .filter((m) => m.ts !== null)
    .sort((a, b) => a.ts - b.ts)[0];
  const totalWeight = weighed.reduce((n, x) => n + x.w, 0);
  return {
    id: clusterId(best.id ?? best.url ?? best.title ?? String(seed)),
    title: best.title ?? String(best.text ?? '').slice(0, 100),
    url: best.url ?? null,
    firstAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    sources,
    sourceCount: sources.length,
    items: weighed.map((x) => x.it),
    weight: Number(totalWeight.toFixed(3)),
    leadSourceId: best.sourceId ?? null,
    firstSourceId: earliest ? items[earliest.idx - members[0].idx]?.sourceId ?? members[0].item.sourceId : null,
    people: [...new Set(items.flatMap((i) => i.people ?? []))],
    duplicateCount: Math.max(0, items.length - 1),
    // multi-source confirmation: when >= 2 sources report the same event, trust is clearly higher
    confirmed: sources.length >= 2,
    similarity: meta.sim ?? null,
  };
}

/**
 * Similarity dedupe: keep only the **highest-weight** item of each event and report what was dropped.
 * Unlike cluster, this does not change the order, it only dedupes, so it can be attached straight to a feed.
 */
export function dedupe(items, { weight = () => 1, threshold = DEFAULT_THRESHOLD, windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const clusters = cluster(items, { weight, threshold, windowHours });
  const kept = [];
  const dropped = [];
  for (const c of clusters) {
    const winner = c.items[0];
    kept.push(winner);
    for (const it of c.items.slice(1)) {
      dropped.push({ id: it.id, sourceId: it.sourceId ?? null, keptId: winner.id, eventId: c.id });
    }
  }
  // keep the same time order as the input (unknown time last)
  kept.sort((a, b) => (tsOf(b) ?? -1) - (tsOf(a) ?? -1));
  return { kept, dropped, events: clusters };
}

/** A summary for the UI */
export function clusterStats(clusters) {
  const multi = clusters.filter((c) => c.confirmed);
  const bySource = {};
  for (const c of clusters) for (const s of c.sources) bySource[s] = (bySource[s] ?? 0) + 1;
  return {
    events: clusters.length,
    itemsMerged: clusters.reduce((n, c) => n + c.items.length, 0),
    confirmedEvents: multi.length,
    duplicatesRemoved: clusters.reduce((n, c) => n + c.duplicateCount, 0),
    leadSources: Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, n]) => ({ id, events: n })),
  };
}

// --------------------------------------------- weight history (persistence)

function historyPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'source-weight.json');
}

export function loadWeightHistory(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(cfg), 'utf8'));
    if (raw && typeof raw === 'object') return { firstSeen: raw.firstSeen ?? {}, totalEvents: raw.totalEvents ?? 0 };
  } catch {
    // no history means starting from zero, which is not an error
  }
  return { firstSeen: {}, totalEvents: 0 };
}

export function saveWeightHistory(cfg, history) {
  try {
    const p = historyPath(cfg);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(history, null, 2), 'utf8');
  } catch {
    // a failed write to disk does not affect this run
  }
}

/**
 * Run one clustering pass + record "who reported it first" into history (so the weights grow by
 * themselves over time as the tool is used).
 * @returns {{clusters:object[], stats:object, weights:object}}
 */
export function runClustering(cfg, items, opts = {}) {
  const history = loadWeightHistory(cfg);
  const weigh = makeWeighter(cfg, history);
  const clusters = cluster(items, {
    weight: weigh,
    threshold: Number(cfg?.cluster?.threshold ?? DEFAULT_THRESHOLD),
    windowHours: Number(cfg?.cluster?.windowHours ?? DEFAULT_WINDOW_HOURS),
    ...opts,
  });
  if (opts.learn !== false) {
    let h = history;
    for (const c of clusters) if (c.items.length > 1 && c.firstSourceId) h = recordFirstReporter(h, c.firstSourceId);
    if (h !== history) saveWeightHistory(cfg, h);
  }
  const weights = {};
  for (const c of clusters) for (const s of c.sources) if (!(s in weights)) weights[s] = Number(weigh(s).toFixed(3));
  return { clusters, stats: clusterStats(clusters), weights };
}
