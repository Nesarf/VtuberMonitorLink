// digest.js — squeeze the raw fetched feeds into a compact digest that can be fed to the LLM
// Why: a raw RSS document is routinely tens of KB, and handing it straight to the model burns
// a lot of tokens; so we keep only the essentials (title / link / time) and cap the entry count.
const LIMIT_PER_FEED = 25;

function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Atom (Reddit .rss and friends) / parse Atom entries */
export function digestAtom(xml, limit = LIMIT_PER_FEED) {
  const blocks = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, limit);
  const lines = blocks.map((m) => {
    const b = m[1];
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? '');
    const link = /<link[^>]*href="([^"]+)"/.exec(b)?.[1] ?? '';
    const updated = decode(/<updated>([\s\S]*?)<\/updated>/.exec(b)?.[1] ?? '');
    return `- ${title} | ${updated} | ${link}`;
  });
  return lines.length ? lines.join('\n') : '';
}

/** MediaWiki recentchanges JSON / parse MediaWiki API result */
export function digestMediaWiki(json, limit = 50) {
  try {
    const j = JSON.parse(json);
    const rows = j?.query?.recentchanges ?? [];
    return rows
      .slice(0, limit)
      .map((r) => `- ${r.title} | ${r.user ?? ''} | ${r.timestamp ?? ''} | ${(r.comment ?? '').slice(0, 80)}`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Long text rendered by a browser: truncate / truncate long rendered text */
export function digestText(text, limit = 6000) {
  const t = String(text ?? '');
  return t.length > limit ? t.slice(0, limit) + `\n…（已截断，原文 ${t.length} 字符）` : t;
}

/** bilibili entries (structured items) -> compact digest / bilibili items to a compact digest */
export function digestBilibili(items, limit = LIMIT_PER_FEED) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .slice(0, limit)
    .map((it) => {
      const text = String(it.text ?? '').replace(/\s+/g, ' ').slice(0, 140);
      const like = it.stats?.like ? ` | 赞 ${it.stats.like}` : '';
      const imgs = it.images?.length ? ` | 图×${it.images.length}` : '';
      const when = it.time ? ` | ${it.time}` : '';
      return `- ${text}${when}${like}${imgs} | ${it.url}`;
    })
    .join('\n');
}

/**
 * Build a compact digest per source type
 * @returns {string} markdown fragment
 */
export function digestResult({ source, content, items }) {
  if (source.fetch === 'search-only' || (!content && !items?.length)) return '（仅检索类来源，交给检索阶段覆盖）';
  if (source.fetch === 'bili-opus' || source.fetch === 'bili-dynamic') return digestBilibili(items) || '（无新动态）';
  if (source.fetch === 'rss') return digestAtom(content) || '（无条目）';
  if (source.fetch === 'mediawiki-api') return digestMediaWiki(content) || '（无变更）';
  return digestText(content);
}

/** watch results -> digest for the analysis layer to read / watch results as LLM context */
export function digestWatch(watchResults = [], limit = 40) {
  const lines = [];
  for (const r of watchResults) {
    if (!r.ok) {
      lines.push(`- 【监视】${r.target?.label ?? r.target?.id}：检查失败 —— ${r.error}`);
      continue;
    }
    lines.push(`- 【监视】${r.target?.label ?? r.target?.id}（${r.target?.kind}）：${r.summary}`);
    for (const e of (r.events ?? []).slice(0, limit)) {
      const reasons = e.reasons?.length ? `（告警：${e.reasons.join('、')}）` : '';
      const text = String(e.text ?? e.title ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const delta = typeof e.delta === 'number' && e.delta ? ` Δ${e.delta > 0 ? '+' : ''}${e.delta}` : '';
      lines.push(`    · ${text}${delta}${reasons}${e.url ? ` | ${e.url}` : ''}`);
    }
  }
  return lines.join('\n');
}
