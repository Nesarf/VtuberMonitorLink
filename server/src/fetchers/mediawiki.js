// fetchers/mediawiki.js - MediaWiki API fetching (e.g. Fandom's recentchanges)
// Note: some wikis (e.g. Moegirlpedia) reject anonymous recentchanges calls (action-notallowed),
// so those sites should switch to fetch: 'browser'.
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
    // MediaWiki errors also come back as 200 + {"error":{...}}, so they must be checked explicitly
    try {
      const j = JSON.parse(text);
      if (j.error) throw new Error(`API ${j.error.code}: ${j.error.info}`);
    } catch (e) {
      if (String(e.message).startsWith('API ')) throw e;
      // non-JSON is treated as ordinary text and processing continues
    }
    log?.info(`${source.id}: ok ${text.length}B`);
    return { ok: true, content: text, ext: 'json' };
  } catch (err) {
    log?.warn(`${source.id}: failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}
