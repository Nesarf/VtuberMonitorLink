// fetchers/mediawiki.js — MediaWiki API 抓取（如 Fandom 的 recentchanges）
// 注意：部分 Wiki（如萌娘百科）会拒绝匿名 recentchanges 调用（action-notallowed），
// 这类站点应改用 fetch: 'browser'。
export async function fetchMediaWiki(source, { log }) {
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  try {
    const r = await fetch(source.url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // MediaWiki 的错误也是 200 + {"error":{...}}，需要显式判别
    try {
      const j = JSON.parse(text);
      if (j.error) throw new Error(`API ${j.error.code}: ${j.error.info}`);
    } catch (e) {
      if (String(e.message).startsWith('API ')) throw e;
      // 非 JSON 视为正常文本继续
    }
    log?.info(`${source.id}: ok ${text.length}B`);
    return { ok: true, content: text, ext: 'json' };
  } catch (err) {
    log?.warn(`${source.id}: failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}
