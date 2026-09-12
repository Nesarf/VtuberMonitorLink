// locale-chain.mjs — 回落链的**唯一一份**工具侧实现 / one canonical chain resolver for tools
//
// 为什么抽出来：同一条规则原先在三个地方各写了一遍 ——
//   · web/src/i18n.jsx 的 usableChain（浏览器侧，真正决定界面显示什么）
//   · tools/locale-coverage.mjs 里「复刻」的一份（算覆盖度）
//   · tools/i18n-translate.mjs 的 humanKeys（决定哪些键不用机翻）
// 前两份还一致，第三份写成了「同 base 的**所有**地区都算人工」，于是
// pt-BR 的人工词条把 pt-PT 的机翻挡住了 —— 可是 pt-PT 的 chain 是 ['pt-PT','en-US']，
// 运行时**根本不会**继承 pt-BR，结果那 4 条在葡萄牙葡语界面里一直是英文兜底，
// 而所有工具都显示「覆盖度 100%」。工具之间漂移的代价就是这种「表格全绿、界面漏字」。
//
// 语义（与 i18n.jsx 的 usableChain 必须一致）：
//   · 递归展开 chain（zh-TW → zh-Hant → zh-Hans → zh）
//   · 只保留**同语言**的成员 —— 跨语言回落是英文，不是把俄语当乌克兰语
import { byCode } from '../../web/src/locales/index.js';

/** 递归展开 chain，返回「基础 → 具体」的顺序 */
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

/** 真正可用的回落链：只继承同语言的地区差异 */
export function usableChain(code) {
  const base = String(code).split('-')[0];
  return resolveChain(code).filter((c) => String(c).split('-')[0] === base);
}

/** 该语言能继承到的**同语言祖先**（不含自己）—— 祖先写过的词条，运行时会继承 */
export function inheritableAncestors(code) {
  return usableChain(code).filter((c) => c !== code);
}
