// digest.js — 把抓到的原始 feed 压缩成可喂给 LLM 的精简摘要
// 目的：RSS 原文动辄数十 KB，直接喂给模型会烧掉大量 token；
// 这里只保留「标题 / 链接 / 时间」等要点，并截断条数。
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

/** Atom（Reddit .rss 等）/ parse Atom entries */
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

/** 浏览器渲染出的长文本：截断 / truncate long rendered text */
export function digestText(text, limit = 6000) {
  const t = String(text ?? '');
  return t.length > limit ? t.slice(0, limit) + `\n…（已截断，原文 ${t.length} 字符）` : t;
}

/**
 * 按来源类型生成精简摘要
 * @returns {string} markdown 片段
 */
export function digestResult({ source, content }) {
  if (source.fetch === 'search-only' || !content) return '（仅检索类来源，交给检索阶段覆盖）';
  if (source.fetch === 'rss') return digestAtom(content) || '（无条目）';
  if (source.fetch === 'mediawiki-api') return digestMediaWiki(content) || '（无变更）';
  return digestText(content);
}
