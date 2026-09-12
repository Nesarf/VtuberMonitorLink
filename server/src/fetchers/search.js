// fetchers/search.js — search-only sources
// Some sources (YouTube, Fanbox, Booth...) expose no stable public endpoint we could
// fetch directly, so the analysis phase's web search covers them; this is only a
// placeholder, letting the UI and the report know "this one is enabled".
export async function fetchSearchOnly(source, { log }) {
  log?.info(`${source.id}: search-only (handled by the analysis phase)`);
  return {
    ok: true,
    content: '',
    ext: 'txt',
    note: 'search-only',
  };
}
