// fetchers/search.js — 仅检索类来源
// 有些来源（YouTube、Fanbox、Booth…）没有稳定的公开直抓端点，
// 交给分析层的 web 检索去覆盖；这里只做占位，让 UI 与报告知道「这条已启用」。
export async function fetchSearchOnly(source, { log }) {
  log?.info(`${source.id}: search-only（交给分析层检索 / handled by the analysis phase）`);
  return {
    ok: true,
    content: '',
    ext: 'txt',
    note: 'search-only',
  };
}
