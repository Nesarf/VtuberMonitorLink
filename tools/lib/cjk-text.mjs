// cjk-text.mjs — one definition of "does this text still contain Chinese?", shared by the guards
// that need it, so the rule cannot drift the way it did before (three copies, three behaviours).
//
// Two rules, and the difference is deliberate:
//   ENGINEERING_RE — what source code may not contain: comments, server logs, test and traversal
//                    output. It stops at Han, CJK punctuation, full-width forms and enclosed
//                    numerals, because those are what actually arrives as translation leftovers
//                    in code.
//   MESSAGE_RE     — what a commit message may not contain, which is wider: the history is read
//                    by people who may not read Chinese at all, so kana, hangul, CJK radicals and
//                    the translation pipeline's sentinel brackets are out too.
//
// What MESSAGE_RE deliberately still allows: a quoted string in *another* script used as evidence
// (a Russian plural form, an Arabic date phrase, French word order). That is data about a
// translation, not Chinese prose, and dropping it would drop the evidence with it.
//
// A single em dash (U+2014) is ordinary English punctuation under both rules; only the doubled
// form is the Chinese dash.
const ENGINEERING_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef\\u2460-\\u24ff';

const MESSAGE_CLASS =
  '\\u2e80-\\u2eff\\u3000-\\u303f\\u3040-\\u30ff\\u31c0-\\u31ef\\u3200-\\u32ff\\u3400-\\u4dbf' +
  '\\u4e00-\\u9fff\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uffef\\uac00-\\ud7af\\u2460-\\u24ff\\u27e6\\u27e7';

const DOUBLED_DASH = '\\u2014\\u2014';

export const ENGINEERING_RE = new RegExp(`[${ENGINEERING_CLASS}]|${DOUBLED_DASH}`);
export const MESSAGE_RE = new RegExp(`[${MESSAGE_CLASS}]|${DOUBLED_DASH}`);

const ENGINEERING_CHAR = new RegExp(`[${ENGINEERING_CLASS}]`);
const MESSAGE_CHAR = new RegExp(`[${MESSAGE_CLASS}]`);

const code = (ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

/** Which characters (as U+XXXX codes) break the rule, and whether the doubled dash is present. */
function scan(text, charRe) {
  const found = new Set();
  if (DOUBLED_DASH && /\u2014\u2014/.test(text)) found.add('U+2014U+2014');
  for (const ch of text) if (charRe.test(ch)) found.add(code(ch));
  return [...found];
}

/** Characters that break the engineering-layer rule (comments, logs, test output). */
export const engineeringOffenders = (text) => scan(text, ENGINEERING_CHAR);

/** Characters that break the commit-message rule (a wider class on purpose). */
export const offenders = (text) => scan(text, MESSAGE_CHAR);
