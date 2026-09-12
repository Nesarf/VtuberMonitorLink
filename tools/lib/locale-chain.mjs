// locale-chain.mjs — the one and only tool-side implementation of the fallback chain
//
// Why it was extracted: the same rule used to be written out three separate times -
//   - usableChain in web/src/i18n.jsx (browser side, the one that really decides what the UI shows)
//   - a copy "replicated" in tools/locale-coverage.mjs (to compute coverage)
//   - humanKeys in tools/i18n-translate.mjs (decides which keys skip machine translation)
// The first two still agreed; the third was written as "ALL locales sharing the base count as human",
// so pt-BR's human entries masked pt-PT's machine translation - yet pt-PT's chain is ['pt-PT','en-US'],
// so at runtime it NEVER inherits pt-BR. Result: those 4 entries stayed English fallbacks in the
// Portuguese (Portugal) UI, while every tool still reported "coverage 100%". That is what drift
// between tools costs: every table green, characters missing in the UI.
//
// Semantics (must match usableChain in i18n.jsx):
//   - expand the chain recursively (zh-TW -> zh-Hant -> zh-Hans -> zh)
//   - keep only members of the SAME language - a cross-language fallback is English,
//     not treating Russian as Ukrainian
import { byCode } from '../../web/src/locales/index.js';

/** Expand the chain recursively, returning base -> specific order */
export function resolveChain(code, seen = new Set()) {
  if (seen.has(code)) return [];
  seen.add(code);
  const loc = byCode(code);
  const parents = (loc?.chain ?? [code]).filter((c) => c !== code);
  const out = [];
  for (const p of parents) out.push(...resolveChain(p, seen));
  out.push(code);
  return out;
}

/** The actually usable fallback chain: inherit only regional variants of the same language */
export function usableChain(code) {
  const base = String(code).split('-')[0];
  return resolveChain(code).filter((c) => String(c).split('-')[0] === base);
}

/** The same-language ancestors this locale can inherit from (excluding itself) - whatever an ancestor wrote is inherited at runtime */
export function inheritableAncestors(code) {
  return usableChain(code).filter((c) => c !== code);
}
