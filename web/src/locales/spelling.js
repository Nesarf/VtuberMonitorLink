// spelling.js — British spelling derivation
//
// Why it is a separate file: this logic used to live only inside i18n.jsx, but the tools side
// (the proofreading scripts) needs it too - and "write the same thing twice and it will drift" is a
// trap this project has already hit several times (the fallback chain, entry parsing, the
// suspected-untranslated criterion).
// So the tables live in overlays.js, the derivation lives here, and both the UI and the tools
// import this one copy.

import { GB_SPELL, GB_STEMS } from './overlays.js';

/** Whole-word replacement (using \b boundaries, never touching substrings: parameter is never turned into parametre) */
function spell(word, map) {
  const hit = map.find(([a]) => a === word);
  return hit ? hit[1] : word;
}

/** British spelling derivation: color->colour, organize->organise, analyze->analyse */
export function toBritish(s) {
  const map = new Map(GB_SPELL);
  let out = String(s).replace(/\b[A-Za-z]+\b/g, (w) => {
    const lower = w.toLowerCase();
    const hit = map.get(lower) ?? map.get(w);
    if (!hit) return w;
    // Preserve the initial letter's case
    return w[0] === w[0].toUpperCase() ? hit[0].toUpperCase() + hit.slice(1) : hit;
  });
  for (const stem of GB_STEMS) {
    const re = new RegExp(`\\b(${stem}(?:e|es|ed|ing|er|ers|ation|ations|ational)?)\\b`, 'gi');
    out = out.replace(re, (m) => m.replace(/z/i, 's').replace(/ze$/i, 'se'));
  }
  return out;
}

/** Derive a whole dictionary entry by entry (values that are not strings are kept as they are) */
export function convertDict(dict, fn) {
  const out = {};
  for (const [k, v] of Object.entries(dict)) out[k] = typeof v === 'string' ? fn(v) : v;
  return out;
}
