// spelling.js — 英式拼写推导 / British spelling derivation
//
// 为什么单独一个文件：这段逻辑原先只写在 i18n.jsx 里，而工具侧（校对脚本）也要用 ——
// 「同一件事写两份必然漂移」这个坑这个项目已经踩过好几次（回落链、词条解析、疑似漏译判据）。
// 所以表在 overlays.js，推导在这里，界面与工具都 import 这一份。

import { GB_SPELL, GB_STEMS } from './overlays.js';

/** 整词替换（用 \b 边界，绝不动子串：parameter 不会被改成 parametre） */
function spell(word, map) {
  const hit = map.find(([a]) => a === word);
  return hit ? hit[1] : word;
}

/** 英式拼写推导：color→colour、organize→organise、analyze→analyse */
export function toBritish(s) {
  const map = new Map(GB_SPELL);
  let out = String(s).replace(/\b[A-Za-z]+\b/g, (w) => {
    const lower = w.toLowerCase();
    const hit = map.get(lower) ?? map.get(w);
    if (!hit) return w;
    // 保持首字母大小写
    return w[0] === w[0].toUpperCase() ? hit[0].toUpperCase() + hit.slice(1) : hit;
  });
  for (const stem of GB_STEMS) {
    const re = new RegExp(`\\b(${stem}(?:e|es|ed|ing|er|ers|ation|ations|ational)?)\\b`, 'gi');
    out = out.replace(re, (m) => m.replace(/z/i, 's').replace(/ze$/i, 'se'));
  }
  return out;
}

/** 整本字典逐条推导（值不是字符串的原样保留） */
export function convertDict(dict, fn) {
  const out = {};
  for (const [k, v] of Object.entries(dict)) out[k] = typeof v === 'string' ? fn(v) : v;
  return out;
}
