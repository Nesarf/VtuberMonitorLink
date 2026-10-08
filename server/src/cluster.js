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

/**
 * The identity layers, in the order they are applied. L1..L4 are exact keys that need no time bound;
 * L5 (`WINDOWED_LAYER`) is exact too but its key has no day in it, so the time window is applied to it
 * inside the pass that runs L6. `similar` is applied after all of them.
 */
const IDENTITY_LAYERS = ['native', 'url', 'urlId', 'titleDay'];
const WINDOWED_LAYER = 'title';

/**
 * L5 diameter floor: the minimum pair similarity any two members of a similarity-only cluster may have.
 *
 * Why 0.38 and not 0.52 (the admission threshold): the defect is *transitive* merges — the merge that
 * has to be refused is the one holding a chain together, and measured on the shipped corpus those
 * bridges score between 0.52 and 0.78 (Deluta/Gallery ≈ FeraLune/Gallery = 0.696). Setting the floor
 * equal to the admission threshold would refuse the genuine near-duplicates too: the community text
 * pairs that really are the same post score as low as 0.55 against each other. 0.38 sits below every
 * genuine duplicate measured and above the chain bridges measured; tools/cluster-identity-test.mjs
 * pins both directions, and the corpus measurement is in the report.
 */
export const DEFAULT_DIAMETER = 0.38;

/**
 * L5 width cap. A backstop against unbounded growth when a batch is full of near-identical text with
 * no shared identifier (scheduled posts, template announcements). Identity groups (L1..L4) are exempt
 * — see the long note on `cluster()`.
 */
export const DEFAULT_MAX_GROUP = 12;

/**
 * Cross-group rule: when two groups that each carry identity keys meet through similarity, the text has
 * to be a near-duplicate (this score) unless they share a key.
 *
 * The rule exists because identity groups are the new nodes of the graph: without it, A's group and C's
 * group — which have nothing in common — get chained through B's group, which is the defect one level up.
 * A plain "they must share a key" rule was the first attempt and it is too strong: measured on the corpus
 * it refused 20 928 candidate pairs and broke every genuine cross-source duplicate, because two sources
 * reporting the same thing never carry the same native id (192 clusters instead of 177). 0.7 sits above
 * the chain bridges measured (the Deluta/Gallery ≈ FeraLune/Gallery link scores 0.696) and below the
 * scores of merges that are obviously the same report; the self-test pins both sides of it.
 */
export const DEFAULT_CROSS_GROUP_SIMILARITY = 0.7;

/** CJK unified ideographs + kana + Hangul */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { asDay, dayOfInstant, dayStamp, effectiveTimeZone } from './day.js';
import { LAYERS, LAYER_LABEL, canonicalUrl, identityKeys, shortHash, titleFingerprint, urlIdentity } from './identity.js';
export { canonicalUrl, identityKeys, titleFingerprint, urlIdentity, LAYERS, LAYER_LABEL };

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
  // `social` is not an offered category any more, but `sanitizeCustomSource` does not validate `category`
  // against `CATEGORIES`, so a hand-declared source can still carry it and `makeWeighter` reads the weight by
  // the id's prefix -- the entry is still meaningful and is kept deliberately (fixing that by validating the
  // category would break hand-declared sources).
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
 *
 * Identity is decided by **layers**, strongest first, and the similarity machinery above is the last
 * layer rather than the first (identity.js owns the keys; the reasoning behind this order is written
 * out at the top of that file):
 *
 *   L1 native id -> L2 canonical url -> L3 extracted item id -> L4 exact title + day -> L5 similarity
 *
 * L1..L4 are exact: a shared key *is* the merge, and it is applied before any text is compared, so
 * "same video, two wordings" no longer depends on a similarity score at all. L5 keeps everything the
 * old code did (IDF-weighted Dice, the rare-token gate, the number/date gate, the person-aware
 * threshold, the day buckets, the candidate cap, the time window) but adds two guards that make a
 * single-link chain impossible:
 *
 *   · **diameter** — a cluster's diameter is the minimum pair similarity between its members. A new
 *     member is admitted only if `min(sim(member, each existing member)) >= max(DEFAULT_DIAMETER,
 *     cluster.diameter)`; merging two clusters is judged on their two representatives (the member with
 *     the highest minimum similarity to its own cluster). The cluster's diameter therefore only ever
 *     stays level or tightens, and the chain A≈B, B≈C, A≉C cannot form: A and C are compared, directly.
 *     The rule is *pairwise*, not "distance to the representative" alone — with a representative-only
 *     rule the far end of a chain is still never compared against the near end, which is the very hole
 *     that let the defect in. The representative is used only to make the *merge of two clusters* cheap.
 *   · **width** — a similarity-only cluster is capped at `maxGroup` members (default
 *     DEFAULT_MAX_GROUP). A group grown by L1..L4 is exempt: a shared native id is a fact, and a
 *     "cap" that split a run of 100 identical reports would be worse than the disease. Measured on the
 *     shipped corpus the widest similarity-only cluster is 16 (bilibili opus text-only posts), so this
 *     cap is a backstop, not the mechanism that does the work.
 *
 * @param {object[]} items
 * @param {object} opts
 * @param {(id:string)=>number} opts.weight source weight function
 * @param {number} opts.threshold Dice threshold (L5)
 * @param {number} opts.windowHours time window (beyond it, not the same event)
 * @param {number} opts.max how many items to process at most (guards against an accidental flood)
 * @param {number} opts.diameter L5 diameter floor (see above)
 * @param {number} opts.maxGroup L5 width cap (see above)
 * @param {boolean} opts.evidence attach the per-member `clusterReason` and the per-cluster `evidence`
 *   summary. On by default: an event that cannot say why it is one event is a bug you cannot see.
 * @param {string} opts.timeZone override the day rule's zone (tests)
 * @param {object} opts.cfg config, for the day rule's zone
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

/**
 * Whether the two number sets intersect; returns true when neither side has a number (nothing to compare,
 * so no veto).
 *
 * Takes pre-computed arrays: this is asked for every candidate pair (120 000 of them on the 2000-item
 * fixture) and filtering two token sets into arrays each time was 6% of the run on its own.
 */
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
  // The day bucket below is a pre-filter, but it has to be built and queried in one calendar (day.js):
  // `dayOfInstant` here and the neighbouring days it is compared against must agree, or an item at local
  // midnight is compared against the wrong pair of buckets and a genuine duplicate is never a candidate.
  const tz = effectiveTimeZone(opts.cfg ?? null, opts.timeZone);

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
  // The day of an instant, memoised per **instant**: `dayOf` is asked once per item for the buckets, once
  // per item for the identity keys, and up to three times per candidate pair while the similarity loop
  // walks the neighbouring buckets, and `dayOfInstant` builds an `Intl.DateTimeFormat` per call. Measured:
  // on the 2000-item fixture that was 61% of the whole run (32 000 calls for 40 distinct instants).
  // The rule itself is untouched — it is still day.js that decides, this only stops asking it repeatedly.
  const dayCache = new Map();
  const dayOfTs = (ms) => {
    let d = dayCache.get(ms);
    if (d === undefined) {
      d = dayOfInstant(ms, tz);
      dayCache.set(ms, d);
    }
    return d;
  };
  const dayOf = (p) => (p.ts === null ? 'unknown' : dayOfTs(p.ts));
  // Same treatment for the three buckets a candidate can hide in: 2000 items x 3 lookups, 40 distinct days.
  const neighbourCache = new Map();
  const neighbourDaysMemo = (day) => neighbourDays(day, neighbourCache);
  prepared.forEach((p, i) => {
    const d = dayOf(p);
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(i);
  });

  // ── the union-find every layer writes into. Stability rule kept from the old code: the smaller index
  // wins, so which member represents a group never depends on the order the merges happened in.
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
    if (ra === rb) return false;
    parent[Math.max(ra, rb)] = Math.min(ra, rb);
    return true;
  };

  // ── L1..L4: identity keys. Exact, and applied before any text is compared. Each layer unions on its
  // own key and only on its own key: keys of different layers are different kinds of evidence and are
  // never pooled.
  const keys = prepared.map((p) => identityKeys(p.item, p.ts === null ? null : dayOfTs(p.ts)));
  // Which identity layers are live. Default: all of them. `layers: []` is the *control* used by the
  // self-test and by the corpus measurement: with no identity layer the algorithm is the old
  // similarity-only single link, which is how "this chains, the layered method does not" is stated as
  // a comparison on one input instead of as a claim.
  const activeLayers = Array.isArray(opts.layers) ? IDENTITY_LAYERS.filter((l) => opts.layers.includes(l)) : IDENTITY_LAYERS;
  // The windowed title layer (L5) is the one identity layer whose key has no day in it, so it is applied
  // inside the L5/L6 pass where the time window is available. It follows the same `layers` option as the
  // rest, and `layers: []` is the control: no identity layer at all, i.e. the old similarity-only method.
  const windowedEnabled = !Array.isArray(opts.layers) || opts.layers.includes(WINDOWED_LAYER);

  // ── the knobs and the per-group bookkeeping, before any layer runs, because `link` (below) is the one
  // way any layer joins two items and it needs all of it.
  const diameterFloor = Number(opts.diameter ?? DEFAULT_DIAMETER);
  const maxGroup = Math.max(1, Number(opts.maxGroup ?? DEFAULT_MAX_GROUP));
  const crossGroupSimilarity = Number(opts.crossGroupSimilarity ?? DEFAULT_CROSS_GROUP_SIMILARITY);
  const withEvidence = opts.evidence !== false;

  // Per-group bookkeeping, keyed by the group's root and **re-rooted on every union**: a union picks
  // the smaller index as the new root, so an entry filed under the old root would go stale and the next
  // read would see "size unknown, diameter unknown" — which is how this was first written, and it made
  // a group of 20 identical reports split in two because the second read of a merged group looked like
  // a singleton and skipped the width rule. One read path, always through `find`.
  const groupMeta = new Map(); // root -> { size, diameter }
  const ensureMeta = (root) => {
    let m = groupMeta.get(root);
    if (!m) {
      m = { size: 0, diameter: null };
      groupMeta.set(root, m);
    }
    return m;
  };
  for (let i = 0; i < prepared.length; i++) ensureMeta(find(i)).size++;
  const metaOf = (root) => groupMeta.get(find(root)) ?? { size: 1, diameter: null };
  // The caches below live here (as references) so that re-rooting can merge them in place rather than
  // throw them away: a stale cache cleared on every merge costs a full rescan of all items on the next
  // read, and on a 2000-item batch that rescan was the whole difference between 1.9 s and 3.2 s.
  const groupKeys = new Map(); // root -> Set('native:<key>', 'url:<key>', ...)
  const groupMembers = new Map(); // root -> [item index, ...]
  /**
   * Move everything filed under `from` onto `to`, which has to be the root the union landed on.
   *
   * The `ensureMeta(to)` is not defensive style, it is the bug this function had: a root whose members
   * were all entered through `ensureMeta` always has an entry, but a *new* root produced by a later union
   * may not — and the earlier version returned a throwaway `{ size: 1 }` for it, so the combined group
   * was then written back as a singleton. That is how the chain fixture merged two unrelated subjects:
   * the size read back as 1, the diameter rule was skipped as "not a group yet", and A≈B, B≈C put A and C
   * in one event.
   */
  const reroot = (from, to) => {
    const a = ensureMeta(to);
    if (from === to) return a; // a union that does not move anything must not "absorb" the target into itself
    const b = groupMeta.get(from);
    if (!b) return a;
    if (b !== a) a.size += b.size;
    if (b.diameter !== null && (a.diameter === null || b.diameter < a.diameter)) a.diameter = b.diameter;
    groupMeta.delete(from);
    // only the surviving root's entries matter; the absorbed one is unreachable from here on
    const ka = groupKeys.get(to);
    const kb = groupKeys.get(from);
    if (kb) groupKeys.set(to, ka ? new Set([...ka, ...kb]) : kb);
    groupKeys.delete(from);
    const ma = groupMembers.get(to);
    const mb = groupMembers.get(from);
    if (mb) groupMembers.set(to, ma ? [...ma, ...mb] : mb);
    groupMembers.delete(from);
    return a;
  };
  const representative = new Map(); // root -> the most central member (evidence, never a decision)

  /**
   * The one way to join two items: union, then move the bookkeeping to the surviving root.
   *
   * Why it is a function and not three lines in each caller: **every** union has to re-root the caches,
   * and an earlier version only did it in the similarity loop. The identity layers unioned without
   * re-rooting, so a group that was built by a native id and then extended by similarity reported the
   * wrong members — measured, the chain fixture merged Deluta with FeraLune because `membersOf` handed
   * the diameter rule one member instead of two. One step, one owner, no exceptions.
   */
  const link = (a, b, reason, minCross = null) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    if (reason && withEvidence) prepared[b].reason = reason;
    const diaA = metaOf(ra).diameter ?? 1;
    const diaB = metaOf(rb).diameter ?? 1;
    union(ra, rb);
    const root = find(ra);
    reroot(ra, root);
    const merged = reroot(rb, root);
    if (merged) merged.diameter = Math.min(minCross ?? diaA, diaA, diaB);
    representative.delete(root);
    return true;
  };

  // The identity layers, declared after `link` so that there is exactly one way in.
  const mergeByKey = (layer) => {
    const seen = new Map();
    let merged = 0;
    for (let i = 0; i < prepared.length; i++) {
      const k = keys[i][layer];
      if (!k) continue; // no key of this layer -> this item simply does not take part in it
      const ts = prepared[i].ts;
      const prev = seen.get(k);
      if (prev === undefined) {
        seen.set(k, { first: i, epoch: ts });
        continue;
      }
      // The time window is applied to the identity layers too, and for the same reason the old code
      // applied it to similarity: "the same id a year apart" is not one event, it is the same resource
      // used twice (a yearly page, a reused id, a stale feed). Measured: without this the "last year's
      // identical item" case merges, and an identity key becomes a way around a rule that already
      // existed. Items with no timestamp cannot exceed the window, so they merge as before.
      if (ts !== null && prev.epoch !== null && Math.abs(ts - prev.epoch) > windowMs) {
        seen.set(k, { first: i, epoch: ts }); // new epoch: a later run of the same key
        continue;
      }
      if (link(prev.first, i, null)) merged++;
    }
    return merged;
  };
  const identityMerges = {};
  for (const layer of [...activeLayers, WINDOWED_LAYER]) identityMerges[layer] = mergeByKey(layer);

  // Which identity keys each group carries, and which items it holds. Both are derived from the group's
  // membership, so both are cached per root and moved to the surviving root on every union (`link`).
  //
  // Careful, and measured — this is the one place where a comfortable-looking implementation cost a
  // third of the runtime budget. Both are built **lazily**: the keys are computed for an item only when
  // some group that contains it is actually asked, and never materialised per item up front. The first
  // version built a key array for all items and a Set for every group it looked at; on the 2000-item
  // fixture that was ~0.8 s of allocation for data nothing read. What the cross-group rule needs is a
  // shared key between two groups, and in this corpus a group is usually a singleton whose only keys are
  // its own, so the common path never builds a Set at all.
  const keysOf = (i) => {
    const out = [];
    for (const layer of activeLayers) if (keys[i][layer]) out.push(layer + ':' + keys[i][layer]);
    if (windowedEnabled && keys[i][WINDOWED_LAYER]) out.push(WINDOWED_LAYER + ':' + keys[i][WINDOWED_LAYER]);
    return out;
  };
  const keySetOf = (root) => {
    const r = find(root);
    let s = groupKeys.get(r);
    if (!s) {
      s = new Set();
      for (let i = 0; i < prepared.length; i++) if (find(i) === r) for (const k of keysOf(i)) s.add(k);
      groupKeys.set(r, s);
    }
    return s;
  };
  const membersOf = (root) => {
    const r = find(root);
    let out = groupMembers.get(r);
    if (!out) {
      out = [];
      for (let i = 0; i < prepared.length; i++) if (find(i) === r) out.push(i);
      groupMembers.set(r, out);
    }
    return out;
  };
  /**
   * Do these two groups share at least one identity key, or is one of them keyless?
   *
   * The first version of this rule was "a group that was *built* by an identity layer may only be joined
   * by similarity when the other group shares a key with it" — and it was wrong in a way worth recording,
   * because it looked right: a run of 20 identical reports carries 20 distinct native ids, so the two
   * halves of that run share no *native* key, and the rule split the run in two. The question that
   * matters is not which layer built the group but whether there is a key the two groups have in common;
   * "do they share a key now" answers it, and it is the same test for every caller.
   */
  const shareIdentityKey = (a, b) => {
    const ka = keySetOf(a);
    const kb = keySetOf(b);
    // A group with no key at all is the residue the identity layers could not name (no id, no url, no
    // exact duplicate title). For it, similarity is the only evidence that exists, so it is not held to
    // the rule in either direction — refusing those merges would make the layer dead.
    if (!ka.size || !kb.size) return true;
    for (const k of kb) if (ka.has(k)) return true;
    return false;
  };
  // The similarity an item has with the *least* similar member of a group: the number the diameter rule
  // turns on, and the comparison single-link never made (the far end of a chain versus the near end).
  //
  // The score of the pair `minPair` last looked at. The diameter rule asks for a similarity that the
  // candidate loop has *just* computed (once an edge is admitted, `minPair(i, ...)` and `pairSim(i, j)`
  // are the same number), and on the 2000-item fixture that recomputation was a measurable share of the
  // run. A one-entry memo rather than a cache keyed by pair: pairs are visited in a fixed order, so it
  // catches the reuse that exists and cannot grow with the batch.
  let lastPair = null;
  let lastScore = 0;
  const pairSim = (a, b) => {
    if (lastPair && ((lastPair[0] === a && lastPair[1] === b) || (lastPair[0] === b && lastPair[1] === a))) return lastScore;
    return Math.max(
      weightedSimilarity(prepared[a].tokens, prepared[b].tokens, idf),
      weightedSimilarity(prepared[a].titleTokens, prepared[b].titleTokens, idf) * 0.95
    );
  };
  const minPair = (i, members) => {
    const rest = members.filter((m) => m !== i);
    if (!rest.length) return 1;
    let min = Infinity;
    for (const m of rest) {
      const s = pairSim(i, m);
      if (s < min) min = s;
    }
    return min;
  };
  // The representative is the **most central** member: the one whose minimum similarity to the rest of
  // its group is highest. It is reported as evidence ("this is the member the cluster is tightest
  // around"), not used as a decision: an earlier version used it as a fast path and it refused edges
  // the pairwise rule accepts (see the note in the L5 loop). The map itself is declared with the rest of
  // the bookkeeping, above `link`, because `link` invalidates it on every union.
  const repOf = (root) => {
    if (representative.has(root)) return representative.get(root);
    const members = membersOf(root);
    let best = members[0] ?? root;
    let bestMin = -1;
    for (const i of members) {
      const m = members.length > 1 ? minPair(i, members) : 1;
      if (m > bestMin) {
        bestMin = m;
        best = i;
      }
    }
    representative.set(root, best);
    return best;
  };

  const shared = {
    find,
    link,
    metaOf,
    groupKeys,
    groupMembers,
    prepared,
    withEvidence,
  };
  // ── L5: the same exact title without the day, inside the time window. It runs here, after the group
  // bookkeeping exists, and before similarity — see the note on mergeTitleWithinWindow for why it is a
  // pass of its own rather than a line in either neighbour.
  identityMerges[WINDOWED_LAYER] = (identityMerges[WINDOWED_LAYER] ?? 0) +
    mergeTitleWithinWindow(prepared, keys, windowMs, windowedEnabled, shared).merged;

  let edges = 0;
  let identityPaths = 0;
  let refusedByDiameter = 0;
  let refusedByWidth = 0;
  let refusedByIdentity = 0;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const day = dayOf(p);
    const candidateDays = p.ts === null ? [...buckets.keys()] : neighbourDays(day);
    const candidates = [];
    for (const d of candidateDays) for (const j of buckets.get(d) ?? []) if (j > i) candidates.push(j);
    candidates.sort((a, b) => Math.abs((prepared[a].ts ?? 0) - (p.ts ?? 0)) - Math.abs((prepared[b].ts ?? 0) - (p.ts ?? 0)));

    let compared = 0;
    for (const j of candidates) {
      const q = prepared[j];
      const ri0 = find(i);
      const rj0 = find(j);
      if (ri0 === rj0) continue; // the identity layers (or an earlier edge) already joined them
      if (compared++ >= CANDIDATE_CAP) break;
      if (p.ts !== null && q.ts !== null && Math.abs(p.ts - q.ts) > windowMs) continue;
      const sim = weightedSimilarity(p.tokens, q.tokens, idf);
      const titleSim = weightedSimilarity(p.titleTokens, q.titleTokens, idf);
      // The score, and the one-entry memo that lets the diameter rule reuse it instead of recomputing it.
      const score = Math.max(sim, titleSim * 0.95);
      lastPair = [i, j];
      lastScore = score;
      let nearIdentical = false;
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
        // This is the "near-identical with matching numbers" road: it is only reached when *no* token
        // in the batch is rare, i.e. when the whole batch is the same text. For the width cap that
        // matters: a run of reports that are near-identical to each other is exactly the "20 identical
        // items" case the old gate was paid for, and splitting it in two because a counter reached 12
        // would be a regression, not a guard. So this road is exempt from the cap (the identity layers
        // L1..L4 are exempt too, for the same reason: a fact is not a drift). The diameter rule still
        // applies to it in full.
        nearIdentical = true;
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

      // ── the three guards. Read the note on `cluster()` before touching any of them: this is the part
      // that replaces single-link chaining, and loosening it brings the defect straight back.
      //
      // (a) cross-group rule: two groups that each carry identity keys may only be joined by similarity
      //     when they share one — or when the text is a near-duplicate, which is the same evidence by
      //     another route. The decision itself is in crossGroupDecision() above, where it can be tested
      //     on its own inputs instead of only through a batch big enough to reach it.
      const sizeI = metaOf(ri0).size;
      const sizeJ = metaOf(rj0).size;
      if (opts.crossGroupRule !== false) {
        const ka = keySetOf(ri0);
        const kb = keySetOf(rj0);
        const verdict = crossGroupDecision({
          sizeI,
          sizeJ,
          score,
          crossover: crossGroupSimilarity,
          shareKey: shareIdentityKey(ri0, rj0),
          hasKeys: ka.size > 0 && kb.size > 0,
        });
        if (!verdict.merge) {
          refusedByIdentity++;
          continue;
        }
      }      if (!nearIdentical && sizeI + sizeJ > maxGroup) {
        refusedByWidth++;
        continue;
      }
      // `metaOf(root).diameter` is the *minimum pair similarity seen inside that group so far* —
      // "unknown yet" for a single-member group, which is why an unset entry must not contribute a clamp.
      //
      // This is the first version's second bug, and it is worth leaving a note about: the lookup used
      // `?? Infinity` as the "no diameter yet" value, which then went through `Math.max` and made the
      // floor Infinity, so **every** similarity edge was refused and nothing merged at all — a silent
      // 100% refusal rather than an error. Neutral is `-Infinity` here because the value is combined
      // with `Math.max`; `?? 1` would clamp every merge in a group down to perfect similarity.
      const floor = Math.max(
        diameterFloor,
        Math.min(metaOf(ri0).diameter ?? -Infinity, metaOf(rj0).diameter ?? -Infinity)
      );
      // Pairwise, in both directions: i against *every* member of j's group, j against every member of
      // i's; the floor is `max(DEFAULT_DIAMETER, the two groups' own diameters)`, so a cluster's
      // diameter can only tighten and the chain A≈B, B≈C, A≉C cannot form — A and C are compared.
      //
      // There was a "cheap refusal" here first: one comparison through each group's most central
      // member, to skip the pairwise scan. It was WRONG and it took the fixture above to show it: the
      // centrality is measured over a member's *whole* group, so the most central member of the group
      // can be further from the incoming item than some other member is. It refused i2-vs-{i1,i3}
      // (whose true pairwise minimum, 0.776, passes) because the central member scored 0.459. A
      // shortcut that can refuse what the rule accepts is not a shortcut, it is a second rule. The
      // scan it tried to avoid is O(k) with k <= maxGroup, which is nothing.
      const minCross = Math.min(minPair(i, membersOf(rj0)), minPair(j, membersOf(ri0)));
      if (minCross < floor) {
        refusedByDiameter++;
        continue;
      }
      // read the two diameters *before* re-rooting, because re-rooting moves the entries
      const diaI = metaOf(ri0).diameter;
      const diaJ = metaOf(rj0).diameter;
      link(
        ri0,
        rj0,
        {
          layer: 'similar',
          score: Number(score.toFixed(4)),
          minCross: Number(minCross.toFixed(4)),
          matched: p.item.id ?? null,
        },
        Math.min(minCross, diaI ?? 1, diaJ ?? 1)
      );
      edges++;
    }
  }

  const groups = new Map();
  for (let i = 0; i < prepared.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const built = [...groups.values()].map((ms, k) =>
    buildCluster(k, ms.map((m) => prepared[m]), weigh, {
      edges,
      keys,
      merges: identityMerges,
      identityPaths,
      refusedByDiameter,
      refusedByWidth,
      refusedByIdentity,
      withEvidence,
      idf,
      prepared,
    })
  );

  // stable ordering: by time first (unknown time last), then by weight
  built.sort((a, b) => {
    const ta = a.firstAt ? Date.parse(a.firstAt) : -1;
    const tb = b.firstAt ? Date.parse(b.firstAt) : -1;
    return tb - ta || b.weight - a.weight;
  });
  return built;
}

function neighbourDays(day, cache) {
  // The three buckets a candidate can hide in, from the one rule (day.js) rather than from a UTC
  // subtraction: a calendar day is not always 86400000 ms long, and the neighbours have to be the same
  // kind of day as the bucket key they are looked up by (a day string, indexed as itself).
  if (!asDay(day)) return [day];
  const hit = cache?.get(day);
  if (hit) return hit;
  const middle = dayStamp(day);
  const out = [middle - 86400000, middle, middle + 86400000].map((ms) => dayOfInstant(ms, 'UTC'));
  cache?.set(day, out);
  return out;
}

/**
 * The cross-group rule, as a function of its inputs — deliberately handed the numbers and the two key
 * sets rather than reaching for them, so that it can be reasoned about and tested on its own decision
 * instead of only through a batch large enough to reach it.
 *
 * `nearDuplicate` is the D<sub>cross</sub> crossover in the code; `shareKey` is identity evidence.
 *
 * Why the rule is written at all: the identity layers turn items into groups, and a group is a new node
 * for the similarity graph. Two groups that have nothing in common can still both be similar to a third,
 * which is the original defect one level up. Measured on the shipped corpus, 2 148 candidate pairs were
 * refused by `no-shared-key` at the default crossover.
 *
 * @returns {{merge: boolean, reason: 'identity'|'near-duplicate'|'keyless'|'gate'}}
 */
export function crossGroupDecision({ sizeI, sizeJ, score, crossover, shareKey, hasKeys }) {
  if (sizeI <= 1 || sizeJ <= 1) return { merge: true, reason: 'gate' }; // not two groups yet
  if (!hasKeys) return { merge: true, reason: 'keyless' }; // the residue: similarity is all the evidence there is
  if (shareKey) return { merge: true, reason: 'identity' };
  if (score >= crossover) return { merge: true, reason: 'near-duplicate' };
  return { merge: false, reason: 'identity' };
}

/** The identity layers, in the order they are applied. `similar` is applied after all of them. */
const IDENTITY_LAYERS_OLD_PLACEHOLDER = null;

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
    // Kept as it was. `similarity` was always null (the old code never passed meta.sim along) and is
    // still null, deliberately: it never held a value, and giving it one now would change what an
    // existing reader sees under a different meaning. The answer to "how similar are these, really"
    // is in `similarityRange` (the min/max pair similarity inside the event).
    similarity: meta.sim ?? null,
    similarityRange: pairSimilarityRange(members, meta),
    ...(meta.withEvidence === false ? {} : { evidence: clusterEvidence(members, meta) }),
  };
}

/** min/max pair similarity inside an event — "how tight is this cluster, really" */
function pairSimilarityRange(members, meta) {
  if (members.length < 2) return null;
  const { idf, prepared } = meta;
  if (!idf || !prepared) return null;
  const sim = (a, b) =>
    Math.max(
      weightedSimilarity(prepared[a].tokens, prepared[b].tokens, idf),
      weightedSimilarity(prepared[a].titleTokens, prepared[b].titleTokens, idf) * 0.95
    );
  let min = Infinity;
  let max = -Infinity;
  for (let x = 0; x < members.length; x++)
    for (let y = x + 1; y < members.length; y++) {
      const s = sim(members[x].idx, members[y].idx);
      if (s < min) min = s;
      if (s > max) max = s;
    }
  return { min: Number(min.toFixed(4)), max: Number(max.toFixed(4)), pairs: (members.length * (members.length - 1)) / 2 };
}

/**
 * L5: exact title agreement inside the time window, as an epoch sweep over each title fingerprint.
 *
 * Returns the ids it merged and how many unions it made. Deterministic in the input order, which is the
 * sorted order (`cluster()` normalises it first) — the "same title" groups are built by first appearance
 * in that order, so the result does not depend on how the caller happened to pass the batch.
 */
function mergeTitleWithinWindow(prepared, keys, windowMs, enabled, cx) {
  if (!enabled) return { merged: 0 };
  const byFp = new Map();
  for (let i = 0; i < prepared.length; i++) {
    const fp = keys[i].titleFingerprint;
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(i);
  }
  let merged = 0;
  for (const [fp, idxs] of byFp) {
    if (idxs.length < 2) continue;
    const epoch = Math.min(...idxs.map((i) => prepared[i].ts ?? Infinity));
    if (epoch === Infinity) {
      // no timestamps at all: nothing can exceed the window, so they are the same report
      for (const i of idxs.slice(1)) if (unionRoots(i, idxs[0], cx, fp, 'title')) merged++;
      continue;
    }
    let run = { root: idxs[0], epoch: prepared[idxs[0]].ts ?? epoch };
    for (const i of idxs.slice(1)) {
      const ts = prepared[i].ts;
      const within = ts === null || ts === undefined || Math.abs(ts - run.epoch) <= windowMs;
      if (within && unionRoots(i, run.root, cx, fp, 'title')) merged++;
      else run = { root: i, epoch: ts ?? run.epoch };
    }
  }
  return { merged };
}

/** The title-run lane's union step: the same `link` as every other layer, via the shared context. */
function unionRoots(i, j, cx, fp, layer) {
  if (cx.find(i) === cx.find(j)) return false;
  const reason = layer === 'title' ? { layer, key: fp, score: null, minCross: 1, matched: cx.prepared[i].item.id ?? null } : null;
  return cx.link(i, j, reason);
}

/**
 * Why is this event one event? One row per layer that did any joining, plus the similarity range.
 *
 * This is what makes a merged-cluster bug visible: without it a wrong event is just "these six things
 * are one thing", with no way to ask which comparison put them there. Costs one small object per
 * cluster and is computed from data the pass already holds. `by` is the strongest layer that actually
 * joined something — the direct answer to "why are these members together".
 */
function clusterEvidence(members, meta) {
  const keys = meta.keys ?? [];
  const layers = [];
  if (members.length > 1) {
    for (const layer of [...IDENTITY_LAYERS, WINDOWED_LAYER]) {
      const byKey = new Map();
      for (const m of members) {
        const key = keys[m.idx]?.[layer];
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(m.item.id ?? null);
      }
      for (const [key, ids] of byKey) {
        if (ids.length > 1) layers.push({ layer, label: LAYER_LABEL[layer], key, items: ids });
      }
    }
    const similarMembers = members.filter((m) => m.reason?.layer === 'similar');
    if (similarMembers.length) {
      layers.push({
        layer: 'similar',
        label: LAYER_LABEL.similar,
        key: null,
        items: similarMembers.map((m) => m.item.id ?? null),
        scores: similarMembers.map((m) => m.reason.score),
        minCross: Math.min(...similarMembers.map((m) => m.reason.minCross ?? 0)),
      });
    }
  }
  const ordered = layers.slice().sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer));
  return {
    by: ordered.length ? ordered[0].layer : 'single',
    layers: ordered,
    merges: meta.merges ?? null,
    identityPaths: meta.identityPaths ?? 0,
    refused: { diameter: meta.refusedByDiameter ?? 0, width: meta.refusedByWidth ?? 0, identity: meta.refusedByIdentity ?? 0 },
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
