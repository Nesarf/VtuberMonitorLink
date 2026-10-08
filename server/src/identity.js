// identity.js — layered identity resolution: "are these two items the same thing?"
//
// Why this module exists: cluster.js used to answer that question with similarity alone, and similarity
// is transitive by accident. If A is similar to B and B to C, single-link union-find put A, B and C in
// one event even when A and C have nothing in common. Measured on the shipped corpus (332 items,
// 2026-09-14 + 2026-09-15): the fandom wiki page `Deluta` and the page `FeraLune` — two different
// characters — landed in one 13-item event, joined only through `Deluta/Gallery` ≈ `FeraLune/Gallery`
// (both share the `/Gallery` suffix), while sim(Deluta, FeraLune) = 0.000. The report then presented
// two unrelated characters as one event.
//
// The fix is to decide identity from **identity evidence first** and to keep similarity for the residue
// where no such evidence exists. The evidence, strongest first:
//
//   L1  native id       `id` as the fetcher declared it (`bili-opus-<opusId>`) — same id, same thing,
//                       whatever the text says. Namespaced by sourceId: an id is only native to its source.
//   L2  canonical url   after normalisation (scheme/host case, `www.`, trailing slash, tracking
//                       parameters, mirror hosts, default ports, percent-encoding)
//   L3  extracted id    the item/video/opus/submission id inside the url or inside the payload, which
//                       lets two *different* urls (a reddit post and its `?utm_...` twin, a bilibili
//                       opus and the opus page url) meet on one key
//   L4  title + day     exact agreement of the normalised title (NFKC, case-folded, punctuation dropped,
//                       tokens sorted) on the same calendar day — *exact*, not "similar"
//   L5  similarity      what cluster.js already did, now applied last and under a diameter limit
//
// Every key this module produces is a string, and the layer that produced a shared key is what an event
// reports as its reason (cluster.js `evidence`), so a wrong merge can be traced to a layer instead of
// being invisible.
//
// Note on what is NOT here: no mirror table for hosts that are not in the corpus, and no parameters
// allow-listed beyond the ones that identify content. Both are measured choices, see the comments.

// Tracking / analytics parameters: they identify the *visit*, never the thing. Dropped unless the host
// rule below explicitly keeps a parameter (some hosts use query strings as content ids: `?v=` on YouTube).
const TRACKING = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid',
  'ref', 'ref_src', 'referrer', 'source', 'spm_id_from', 'vd_source', 'share_source', 'share_medium',
  'share_plat', 'share_session_id', 'share_tag', 'timestamp', 'unique_k', 'from_source', 'from_spmid',
  'broadcast_type', 'seid', 'bbid', 'ts', 'tab', 'si', 'feature', 'ab_channel',
]);

/**
 * Hosts that serve the same content. Deliberately tiny and explicit: each row is a pair someone
 * actually reported seeing, not a guess. Measured on the shipped corpus there are 17 hosts and no
 * mirror pair at all, so this table buys nothing today — it is here because the corpus is two days of
 * one machine and a mirror pair is the cheapest kind of duplicate to get wrong. `every caller` is
 * cluster.js; adding a row is a one-line change with a test in tools/cluster-identity-test.mjs.
 */
/**
 * Hosts that serve the same content, written **without** the `www.` prefix, because the canonicaliser
 * strips it before looking a host up. Deliberately tiny and explicit: each row is a pair someone
 * actually reported seeing, not a guess. Measured on the shipped corpus there are 17 hosts and no mirror
 * pair at all, so this table buys nothing today — it is here because the corpus is two days of one
 * machine and a mirror pair is the cheapest kind of duplicate to get wrong. Adding a row is a one-line
 * change with a test in tools/cluster-identity-test.mjs.
 */
export const MIRROR_HOSTS = new Map([
  ['m.youtube.com', 'youtube.com'],
  ['youtu.be', 'youtube.com'], // the short link's path IS the id; canonicalUrl folds it into /watch?v=
  ['old.reddit.com', 'reddit.com'],
  ['np.reddit.com', 'reddit.com'],
  ['mobile.twitter.com', 'x.com'],
  ['twitter.com', 'x.com'],
  ['m.moegirl.org.cn', 'zh.moegirl.org.cn'],
  ['mzh.moegirl.org.cn', 'zh.moegirl.org.cn'],
  ['mzh.moegirl.org', 'zh.moegirl.org.cn'],
  ['moegirl.org.cn', 'zh.moegirl.org.cn'],
]);

/** Query parameters that DO identify content, per host (no `www.`: the canonicaliser strips it first). */
const CONTENT_PARAMS = new Map([
  ['youtube.com', ['v', 'list']],
  ['bilibili.com', ['p', 't', 'bvid', 'aid', 'cid']],
  ['reddit.com', []], // reddit keeps content in the path: /r/<sub>/comments/<id>/<slug>/
  ['zh.moegirl.org.cn', ['oldid', 'diff', 'curid']],
  ['virtualyoutuber.fandom.com', ['oldid', 'diff', 'curid']],
]);

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * Canonical form of a url, or null when it is not a url at all.
 *
 * Deliberately lossy in exactly one direction: two urls that differ only in the ways listed below
 * canonicalise to the same string, and every other difference is kept. Keeping `https` (rather than
 * folding it into `http`) is the one place where this is more conservative than it could be: the
 * corpus carries no `http://` twin of anything, and folding them would make two genuinely different
 * resources (`http://` and `https://` on a host that serves different content) look identical.
 */
export function canonicalUrl(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.') && host !== 'www.') host = host.slice(4);
  host = MIRROR_HOSTS.get(host) ?? MIRROR_HOSTS.get(u.hostname.toLowerCase()) ?? host;
  // A short link carries its identity in the path (`youtu.be/<id>`), which is a different shape from
  // the canonical one (`/watch?v=<id>`). Folding the host alone would create a *new* false negative,
  // so youtu.be is mapped to the watch form explicitly.
  let pathname = u.pathname || '/';
  if (u.hostname.toLowerCase() === 'youtu.be') {
    const id = pathname.replace(/^\/+|\/+$/g, '');
    pathname = id ? `/watch` : pathname;
    u.searchParams.set('v', id);
  }
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/';

  const keep = CONTENT_PARAMS.get(host) ?? [];
  const params = [];
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (TRACKING.has(key) && !keep.includes(key)) continue;
    if (!keep.includes(key)) continue; // allow-list, not deny-list: an unknown parameter is not identity
    params.push([key, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');

  const port = u.port && u.port !== DEFAULT_PORTS[u.protocol] ? `:${u.port}` : '';
  const scheme = u.protocol === 'https:' ? 'https://' : `${u.protocol}//`; // http: stays explicit
  return `${scheme}${host}${port}${pathname}${query ? '?' + query : ''}`;
}

// ───────────────────────────────────────────── L3: ids carried by a url

/**
 * Content ids that hosts put in their urls. Host-specific on purpose: a generic "long number in the
 * path" rule would let `/wiki/12345` and `/news/12345` on two different hosts collide, which is a
 * wrong merge produced by the layer that exists to prevent wrong merges.
 *
 * The return value is namespaced (`r:<id>`) so that an id from one host can never match an id from
 * another; the namespace is what the event reports as its reason.
 */
/**
 * The host-specific content-id rules, named so that the check that keeps this module the only place that
 * decides identity can count them (tools/integrity-check.mjs §5n).
 */
export const URL_ID_RULES = [
  { host: 'reddit.com', ns: 'reddit', note: 'submission id', re: /\/comments\/([a-z0-9]{4,12})(?:\/|$)/i },
  { host: 'bilibili.com', ns: 'bili-opus', note: 'opus (dynamic) id', re: /\/opus\/(\d{6,})/ },
  { host: 'bilibili.com', ns: 'bili-video', note: 'video id', re: /\/(?:video\/)?(BV[0-9A-Za-z]{8,12})/ },
  { host: 'bilibili.com', ns: 'bili-av', note: 'legacy video id', re: /\/video\/av(\d{4,})/i },
  { host: 'bilibili.com', ns: 'bili-space', note: 'space (user) id', re: /\/space\/(\d{3,})/ },
  { host: 'bilibili.com', ns: 'bili-read', note: 'read (article) id', re: /\/read\/cv(\d{4,})/i },
  { host: 'youtube.com', ns: 'yt-video', note: 'video id in the path', re: /\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{8,})/ },
  { host: 'youtube.com', ns: 'yt-channel', note: 'channel id', re: /\/channel\/(UC[A-Za-z0-9_-]{10,})/ },
  { host: 'x.com', ns: 'x-status', note: 'status id', re: /\/status(?:es)?\/(\d{6,})/ },
  { host: 'twitch.tv', ns: 'twitch-video', note: 'video id', re: /\/videos\/(\d{4,})/ },
  { host: 'fandom.com', ns: 'fandom-page', note: 'wiki page (rev-independent) id', re: /\/wiki\/([^/?#]+)/ },
  { host: 'moegirl.org.cn', ns: 'moegirl-page', note: 'wiki page id', re: /\/(?:wiki|index\.php)\/([^/?#]+)/ },
];

/** The content id inside a url, or null. Host matching is suffix-based, so `www.` and mirrors both hit. */
export function urlIdentity(raw) {
  const c = canonicalUrl(raw);
  if (!c) return null;
  if (c.includes('youtube.com/watch')) {
    const v = new URL(c).searchParams.get('v');
    if (v) return { ns: 'yt-video', id: v };
  }
  const host = new URL(c).hostname;
  for (const rule of URL_ID_RULES) {
    if (host !== rule.host && !host.endsWith('.' + rule.host)) continue;
    const m = rule.re.exec(c);
    if (m) return { ns: rule.ns, id: decodeURIComponent(m[1]).toLowerCase() };
  }
  return null;
}

// ───────────────────────────────────────────── L4: exact title agreement

/** Normalise a title down to "the same words": NFKC, case-folded, punctuation and symbols dropped. */
export function titleFingerprint(title) {
  const s = String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  // sorted tokens: word order in a headline is not identity ("3D debut Alice" vs "Alice 3D debut")
  return s.split(' ').filter(Boolean).sort().join(' ');
}

/** A stable, short key out of an arbitrary string (for map keys and cluster ids, not for security). */
export function shortHash(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * The identity keys an item carries, tagged by layer. Keys are compared **only inside their layer**:
 * L2's url key and L4's title key are different kinds of evidence and must never be pooled.
 *
 * `day` is supplied by the caller (cluster.js) rather than derived here, so that this module never
 * becomes a second place that decides which calendar day an instant belongs to (that rule lives in
 * day.js alone, and integrity-check §5m enforces it).
 *
 * @param {object} item
 * @param {string|null} day the item's calendar day (day.js), or null
 * @returns {{native: string|null, url: string|null, urlId: string|null, title: string|null}}
 */
export function identityKeys(item, day = null) {
  const sourceId = item?.sourceId ? String(item.sourceId) : '';
  // L1: the fetcher's own id. `bili-opus-1247772228144070661` is bilibili's opus id; the same string
  // under two different sources is two different things, which is why sourceId is part of the key.
  const rawId = item?.id === null || item?.id === undefined ? '' : String(item.id).trim();
  const native = rawId && sourceId ? `${sourceId}|${rawId}` : null;

  // L2: the canonical url of this item.
  const url = canonicalUrl(item?.url);

  // L3: a content id, either out of the url or out of the payload. `item.nativeId` / `item.videoId` /
  // `item.itemId` are accepted because a fetcher that already knows the platform id should not have to
  // put it in the url for the layer to work; none of them exist in today's corpus (see the note in the
  // report), so the payload route is dormant but not dead code — it is one `sourceUid`-shaped field away.
  const fromUrl = urlIdentity(item?.url);
  const payloadId = item?.nativeId ?? item?.videoId ?? item?.itemId ?? item?.contentId ?? null;
  const urlId = payloadId !== null && String(payloadId).trim() !== ''
    ? `${sourceId ? sourceId.split('-')[0] : 'payload'}:${String(payloadId).trim().toLowerCase()}`
    : fromUrl
      ? `${fromUrl.ns}:${fromUrl.id}`
      : null;

  // L4: exact title agreement on the same calendar day. Two items with the same title on the same day
  // are the same event; it is *exact* (a fingerprint, not a score), so it needs no threshold.
  const fp = titleFingerprint(item?.title);
  const titleDay = fp && day ? `T|${day}|${shortHash(fp)}` : null;
  // L5: the same title without the day. It exists because the calendar day is not always knowable — the
  // event might be the same one reported on either side of local midnight — and because a batch of
  // identical reports splits across days for no reason (measured: 20 identical items whose local days
  // differ, so L4 made two groups of 4 and 16). This key is only ever applied inside the time window
  // (cluster.js), which is what keeps "the same title two days apart is a rerun" from becoming "last
  // year's identical title is the same event".
  const title = fp ? `T*|${shortHash(fp)}` : null;

  return { native, url, urlId, titleDay, title, titleFingerprint: fp };
}

/** The layer names, in the order they are applied. `similar` is the last resort, not the first. */
export const LAYERS = ['native', 'url', 'urlId', 'titleDay', 'title', 'similar'];

/** Human-readable names for the evidence an event reports. */
export const LAYER_LABEL = {
  native: 'L1 platform-native id',
  url: 'L2 canonical url',
  urlId: 'L3 extracted item id',
  titleDay: 'L4 exact title + day',
  title: 'L5 exact title within the time window',
  similar: 'L6 similarity',
  single: 'single item (no merge)',
};

/**
 * Every module that decides identity through this one.
 *
 * Same shape as DAY_KEY_CALLERS in day.js and the URL-policy inventory in remote-url.js, and for the same
 * reason: a rule that lives in one file is only single while its callers are named. A new consumer is a
 * one-line addition here; a consumer that is not named is what the integrity check reports. There is
 * deliberately no "exempt" list — unlike the day rule, a module has no legitimate reason to reshape a url
 * or a title without saying so here.
 */
export const IDENTITY_CALLERS = [
  { file: 'server/src/cluster.js', via: 'identity.js', note: 'applies the layers and the evidence' },
  { file: 'tools/cluster-identity-test.mjs', via: 'identity.js', note: 'the self-test for all of it' },
  { file: 'tools/integrity-check.mjs', via: 'source', note: 'reads this module to check its callers' },
];

/**
 * The shapes that mean "a url is being reshaped **into a key**" and "a title is being reshaped into a key".
 *
 * Declared here, in the module that owns the rules, rather than in the checker: a detector is part of the
 * contract it enforces, and this file is the one a second implementation would be written next to. Each
 * url rule is a **conjunction** with `new URL(`, and each is specific to canonicalisation, so that
 * parsing a url for an unrelated reason — reading a webhook host, deriving a favicon directory, grouping
 * observations by site — is not reported as a competing normaliser. The title rule is likewise a
 * conjunction: tokenising text (dropping punctuation to split words) is not the same thing as deciding
 * that two titles *are the same title*, which is what the fingerprint does.
 */
export const CANONICAL_URL_RULES = [
  { name: 'parses a url', re: /new URL\(/, sample: "const u = new URL(raw);" },
  { name: 'strips a trailing slash from a pathname', re: /pathname\.replace\(\/\\\/\+\$\/|pathname = pathname\.replace\(/, sample: "pathname = pathname.replace(/\\/+$/, '')" },
  { name: 'edits query parameters', re: /searchParams\.(delete|set|append)\(/, sample: "u.searchParams.delete('utm_source')" },
  { name: 'knows tracking parameters', re: /utm_/, sample: "if (k.startsWith('utm_')) skip();" },
];

/** The shape that means a title is being reduced to a comparison key: NFKC **and** punctuation dropped. */
export const TITLE_RULES = [
  { name: 'NFKC-normalises a string', re: /normalize\('NFKC'\)/, sample: "s.normalize('NFKC')" },
  { name: 'strips punctuation or symbols', re: /\\p\{P\}\\p\{S\}/, sample: "s.replace(/[\\p{P}\\p{S}]+/gu, ' ')" },
];
