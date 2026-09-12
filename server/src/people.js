// people.js — follow people, not sources / follow people, not sources
//
// Why this layer is needed: a source is a **collection unit**, not what the user actually cares about --
// what the user has in mind is "I want to watch these 20 people". Previously that could only be approximated by
// "turning on all 20 sources", which meant missing the people you care about and flooding on the ones you do not.
//
// This layer has exactly three responsibilities:
//   1) bind a "person" to where that person's accounts live (bilibili uid / X handle / YouTube channel / Twitch)
//   2) attribute intel items to people **locally** (pure string matching, no network, no LLM)
//   3) aggregate output per person (intel stream / export / notification text)
//
// Two key points of the matching rules (both written this way only after stepping on the pitfalls):
//   · **There is no word boundary in the CJK script**, so a CJK alias must use substring matching (otherwise a Chinese
//     name would never match a title that wraps it in corner brackets, which is the usual shape of a post title)
//   · **Latin text must require word boundaries**, otherwise `Mika` hits `Mikado` and `Rei` hits `Reimu` --
//     that is the most common false positive in name matching
//   · A hit must **carry evidence** (which alias hit, in which field), so the UI can explain "why is this one theirs"

import { PLATFORM_URLS } from './vdb.js';

/** Whether an alias contains CJK (Han/kana/Hangul) -> decides substring vs word-boundary matching */
function hasCJK(s) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(s);
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract every alias usable for matching from a person (name, aliases, accounts on any platform).
 *
 * **Platform-agnostic**: bilibili is not hardcoded here. Whatever platform is in `links` gets aliases generated in
 * that platform's shape --
 *   · the raw id/handle itself (`someone_tv`)
 *   · the `@handle` form (common on twitter / tiktok / instagram)
 *   · the canonical link (`twitch.tv/someone_tv`, `space.bilibili.com/672328094`…)
 * Rationale: the people a user follows may only be active on twitch / youtube / twitter,
 * while our sources (news sites, wikis, RSS) tend to refer to them by handle or link --
 * if only bilibili were recognized, those items would never be attributed to anyone.
 */
export function aliasesOf(person) {
  const out = new Set();
  const add = (v, source) => {
    const s = String(v ?? '').trim();
    if (s.length >= 2) out.add(JSON.stringify([s, source])); // use JSON to dedupe while preserving order
  };
  add(person?.name, 'name');
  add(person?.enName, 'enName');
  for (const a of person?.aliases ?? []) add(a, 'alias');
  for (const t of person?.tags ?? []) add(t, 'tag');

  const links = person?.links ?? {};
  for (const [platform, rawId] of Object.entries(links)) {
    const id = String(rawId ?? '').trim();
    if (!id || !PLATFORM_URLS[platform]) continue;
    add(id, `${platform}-id`);
    // Link shapes: twitch.tv/xxx, space.bilibili.com/123, youtube.com/channel/UCxx…
    // Add both with and without www: sources use both spellings (the www templates come from VDB's link table)
    const url = PLATFORM_URLS[platform].replace('{id}', id);
    const bare = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    add(bare, `${platform}-url`);
    if (bare.startsWith('www.')) add(bare.slice(4), `${platform}-url`);
    // Handle-like platforms also get an @ form
    if (['twitter', 'tiktok', 'instagram', 'telegram', 'afdian'].includes(platform)) {
      const h = id.replace(/^@/, '');
      add(h, `${platform}-handle`);
      add('@' + h, `${platform}-handle`);
    }
  }
  return [...out].map((s) => {
    const [value, source] = JSON.parse(s);
    return { value, source };
  });
}

/**
 * The fields of an item that take part in matching (title has the highest weight).
 *
 * `sourceName` must be in there: a source name is itself often a person's name (e.g. the bilibili-dynamics source
 * named after one person's account), which means "this source is this person's account" -- one of the strongest
 * attribution signals there is; leaving it out makes a whole class of items (those without a name in the title)
 * unattributable.
 */
const FIELDS = [
  ['title', 3],
  ['sourceName', 3],
  ['text', 2],
  ['contentText', 2],
  ['summary', 2],
  ['content', 2],
  ['author', 2],
  ['uploader', 2],
  ['desc', 2],
  ['url', 1],
];

/**
 * Compile the matchers. The regexes are built up front to avoid compiling per item.
 * @returns {{person:object, alias:string, source:string, re:RegExp}[]}
 */
export function buildMatchers(people) {
  const matchers = [];
  for (const p of people ?? []) {
    if (!p || p.enabled === false) continue;
    for (const { value, source } of aliasesOf(p)) {
      const re = hasCJK(value)
        ? new RegExp(escapeRe(value), 'iu') // CJK: substring
        : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, 'iu'); // Latin: word boundary
      matchers.push({ person: p, alias: value, source, re });
    }
  }
  return matchers;
}

/**
 * Pull **every matchable string** out of one field.
 *
 * Why not simply String(field): `sourceName` in an item is a localized object `{ zh, en }`, and
 * `String({zh,en})` equals `"[object Object]"` -- that would make the source name, the strongest attribution
 * signal, **completely useless** on production data, without raising any error (only the absurd case of matching
 * an object-as-alias would hit). So objects have to be flattened into a list of candidate strings.
 */
function fieldStrings(value) {
  if (!value) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(fieldStrings);
  if (typeof value === 'object') return Object.values(value).flatMap(fieldStrings);
  return [];
}

/**
 * Which people an intel item belongs to.
 * @returns {{ids:string[], hits:{id:string,name:string,alias:string,source:string,field:string}[]}}
 */
export function matchItem(item, matchers) {
  const hits = [];
  const ids = new Set();
  for (const m of matchers) {
    for (const [field, weight] of FIELDS) {
      const candidates = fieldStrings(item?.[field]);
      if (!candidates.length) continue;
      if (!candidates.some((s) => m.re.test(s))) continue;
      ids.add(m.person.id);
      hits.push({ id: m.person.id, name: m.person.name, alias: m.alias, source: m.source, field, weight });
      break; // one hit per person per field is enough
    }
  }
  return { ids: [...ids], hits };
}

/** Attribute a whole batch of items (writes people / peopleHits in place) */
export function annotateItems(items, people) {
  const matchers = buildMatchers(people);
  let matched = 0;
  const list = (items ?? []).map((it) => {
    const { ids, hits } = matchItem(it, matchers);
    if (ids.length) matched++;
    return { ...it, people: ids, peopleHits: hits };
  });
  return { items: list, matched, peopleCount: new Set(matchers.map((m) => m.person.id)).size };
}

/**
 * Aggregate per person: each person's item count, most recent item, and the items themselves.
 * Sorting uses "most recent appearance" rather than item count -- what the follow list needs to show first is always "who just moved".
 */
export function feedByPerson(items, people, { id = null, limit = 100 } = {}) {
  const matchers = buildMatchers(people);
  const byId = new Map();
  for (const p of people ?? []) byId.set(p.id, { person: p, items: [], count: 0, lastAt: null, kinds: {} });

  for (const it of items ?? []) {
    const { ids, hits } = matchItem(it, matchers);
    for (const pid of ids) {
      if (id && pid !== id) continue;
      const bucket = byId.get(pid);
      if (!bucket) continue;
      bucket.items.push({ ...it, peopleHits: hits.filter((h) => h.id === pid) });
      bucket.count++;
      const at = it.publishedAt ?? it.at ?? it.ts ?? null;
      if (at && (!bucket.lastAt || String(at) > String(bucket.lastAt))) bucket.lastAt = at;
      const k = it.kind ?? it.category ?? 'other';
      bucket.kinds[k] = (bucket.kinds[k] ?? 0) + 1;
    }
  }

  let rows = [...byId.values()];
  if (id) rows = rows.filter((r) => r.person.id === id);
  for (const r of rows) r.items = r.items.slice(0, limit);
  rows.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')) || b.count - a.count);
  return rows;
}

/** Recommend "people worth adding to the follow list" from entity aggregates (local stats, no network) */
export function suggestFromPeople(entities, people, { minCount = 2, limit = 30 } = {}) {
  const known = new Set();
  for (const p of people ?? []) for (const { value } of aliasesOf(p)) known.add(value.toLowerCase());
  return (entities ?? [])
    .filter((e) => (e.count ?? 0) >= minCount)
    .filter((e) => !known.has(String(e.value ?? '').toLowerCase()))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, limit)
    .map((e) => ({ name: e.value, count: e.count, kind: e.kind ?? null, sample: e.sample ?? null }));
}

/**
 * The allowed link platform keys.
 *
 * This **must** stay aligned with PLATFORM_URLS in vdb.js (rather than a hand-written short list):
 * VDB import writes the accounts from a record into links verbatim, so if this allowlist only knows
 * bilibili/twitter/youtube/twitch, then at import time the accounts of everyone outside twitch (weibo, acfun,
 * niconico, showroom, pixiv, afdian…) would be **silently dropped** --
 * and "the people a user follows are not necessarily on bilibili" is exactly what this layer has to support.
 */
const LINK_KEYS = Object.keys(PLATFORM_URLS);

export function sanitizePerson(input, i = 0) {
  const id = String(input?.id ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 60);
  const name = String(input?.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'name is required' };
  const links = {};
  for (const k of LINK_KEYS) {
    const v = String(input?.links?.[k] ?? '').trim().slice(0, 120);
    if (v) links[k] = v;
  }
  const uniq = (arr, n) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x ?? '').trim()).filter((x) => x.length >= 2))].slice(0, n);
  return {
    person: {
      id: id || `p-${Date.now().toString(36)}-${i}`,
      name,
      enName: String(input?.enName ?? '').trim().slice(0, 80),
      agency: String(input?.agency ?? '').trim().slice(0, 60),
      aliases: uniq(input?.aliases, 20),
      tags: uniq(input?.tags, 20),
      notes: String(input?.notes ?? '').trim().slice(0, 500),
      links,
      enabled: input?.enabled !== false,
      // What level this person's messages are pushed at (urgent bypasses the quiet hours)
      notifyLevel: ['info', 'alert', 'urgent'].includes(input?.notifyLevel) ? input.notifyLevel : 'alert',
    },
  };
}

/** Single-person export (for "send someone's intel to a friend" and for RSS/JSON consumers) */
export function personExport(person, items, format = 'json') {
  const rows = items ?? [];
  if (format === 'json') {
    return {
      mime: 'application/json; charset=utf-8',
      file: `${person.id}.json`,
      body: JSON.stringify({ person: { ...person }, count: rows.length, generatedAt: new Date().toISOString(), items: rows }, null, 2),
    };
  }
  const lines = rows.map((it) => {
    const when = it.publishedAt ?? it.at ?? '';
    const title = it.title ?? String(it.text ?? '').slice(0, 80);
    return `- ${when ? `**${when}** · ` : ''}${title}${it.url ? ` — ${it.url}` : ''}`;
  });
  const md = `# ${person.name}${person.agency ? `（${person.agency}）` : ''}\n\n共 ${rows.length} 条 · 生成于 ${new Date().toISOString()}\n\n${lines.join('\n')}\n`;
  return { mime: 'text/markdown; charset=utf-8', file: `${person.id}.md`, body: md };
}
