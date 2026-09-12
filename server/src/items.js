// items.js — normalize each source's fetch result into an "intel item"
// The web card stream, the source list inside reports and the follow-count growth all consume this one shape.
//
// item shape:
//   { id, kind, sourceId, sourceName:{zh,en}, title, text, url, time, images[], stats{}, extra }
//
// id is **content-derived** rather than positional: stars/read flags have to survive across runs, and a
// positional id like `sourceId#3` stops matching anything the moment the order changes next run.
import crypto from 'node:crypto';
import { CATEGORIES } from './sources.js';

const LIMIT_DEFAULT = 60;

function contentId(sourceId, it) {
  const basis = `${sourceId}|${it.url ?? ''}|${it.title ?? ''}|${it.id ?? ''}`;
  return `${sourceId}:${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

function clean(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Atom / RSS entries → items */
function fromRss(content, src) {
  const out = [];
  const blocks = [...String(content).matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const items = blocks.length ? blocks.map((m) => m[1]) : [...String(content).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  for (const b of items) {
    const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? '');
    const link = /<link[^>]*href="([^"]+)"/.exec(b)?.[1] ?? clean(/<link>([\s\S]*?)<\/link>/.exec(b)?.[1] ?? '');
    const when = clean(/<(updated|pubDate|published)>([\s\S]*?)<\/\1>/.exec(b)?.[2] ?? '');
    const body = clean(/<(content|summary|description)[^>]*>([\s\S]*?)<\/\1>/.exec(b)?.[2] ?? '');
    if (!title && !link) continue;
    out.push({ title, text: body.slice(0, 600), url: link, time: when, images: [], stats: {} });
  }
  return out;
}

/** MediaWiki recentchanges JSON → items */
function fromMediaWiki(content, src) {
  try {
    const j = JSON.parse(content);
    const rows = j?.query?.recentchanges ?? [];
    return rows.map((r) => ({
      title: r.title ?? '',
      text: r.comment ?? '',
      url: `https://${(src.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}/wiki/${encodeURIComponent(String(r.title ?? '').replace(/ /g, '_'))}`,
      time: r.timestamp ?? '',
      images: [],
      stats: { user: r.user ?? '', delta: typeof r.newlen === 'number' && typeof r.oldlen === 'number' ? r.newlen - r.oldlen : undefined },
      extra: { rcid: r.rcid, type: r.type, anon: !!r.anon, bot: !!r.bot, new: !!r.new },
    }));
  } catch {
    return [];
  }
}

/**
 * one fetch result → an array of intel items
 * @param {object} result a single entry out of fetchAll()
 */
export function normalizeResult(result, limit = LIMIT_DEFAULT) {
  const src = result.source ?? {};
  const base = {
    sourceId: src.id,
    sourceName: src.name ?? { zh: src.id, en: src.id },
    category: src.category ?? 'community',
  };
  let raw = [];

  if (Array.isArray(result.items) && result.items.length) {
    // the fetcher already handed back structured items (bilibili and friends)
    raw = result.items;
  } else if (!result.ok || !result.content) {
    return [];
  } else if (src.fetch === 'rss') {
    raw = fromRss(result.content, src);
  } else if (src.fetch === 'mediawiki-api') {
    raw = fromMediaWiki(result.content, src);
  } else {
    raw = [{ title: '', text: String(result.content).slice(0, 800), url: src.url ?? '', time: '', images: [], stats: {} }];
  }

  return raw.slice(0, limit).map((it, i) => {
    const item = {
      ...base,
      id: it.id ?? contentId(src.id, it),
      kind: it.kind ?? src.fetch ?? 'text',
      title: it.title ?? '',
      text: it.text ?? '',
      url: it.url ?? src.url ?? '',
      time: it.time ?? '',
      images: Array.isArray(it.images) ? it.images.slice(0, 12) : [],
      stats: it.stats ?? {},
      extra: it.extra ?? undefined,
      sourceUid: it.sourceUid,
      seq: i,
    };
    return item;
  });
}

/** collect every result into one flat list */
export function collectItems(results, limitPerSource = LIMIT_DEFAULT) {
  const out = [];
  for (const r of results) out.push(...normalizeResult(r, limitPerSource));
  return out;
}

/**
 * keyword hit check (used for alert highlighting)
 * @returns {string[]} the keywords that matched
 */
export function matchedKeywords(item, keywords = []) {
  if (!keywords.length) return [];
  const hay = `${item.title ?? ''}\n${item.text ?? ''}`.toLowerCase();
  return keywords.filter((k) => k && hay.includes(String(k).toLowerCase()));
}

export function categoryLabel(id) {
  const c = CATEGORIES?.[id];
  return c ?? { zh: id, en: id };
}
