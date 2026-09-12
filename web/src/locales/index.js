// locales/index.js — locale registry
//
// Design points (these decide how expensive adding a language is later):
//
// 1. **A regional dialect is an override, not a copy**. zh-TW and zh-Hans differ only in wording,
//    en-GB and en-US only in spelling / date order, and pt-BR vs pt-PT is the same story.
//    So each locale writes only the keys where it **differs**, and everything else falls back level
//    by level along its chain, which brings the cost of 16 languages down from "16 x 600 entries"
//    to "2 complete sets + 14 sets of differences".
//
// 2. **The fallback chain must be written out explicitly**, never guessed: zh-HK -> zh-Hant -> zh-Hans;
//    en-AU/GB/CA/NZ -> en-US; es-MX/AR -> es-419 -> es-ES; pt-BR -> pt-PT.
//    Note the direction is asymmetric: pt-BR inherits pt-PT, but pt-PT does **not** inherit pt-BR
//    (the tools-side tools/lib/locale-chain.mjs must agree with the semantics here - stop writing
//    a second copy of it).
//    Note also that uk/sr/pl are **independent languages**: putting ru in their chain is only
//    "a fallback when a key is missing", not "they are dialects of Russian" - getting this wrong
//    in the UI is not acceptable.
//
// 3. **Regional differences are not only in the copy**: date order, first day of the week and
//    number/currency formats all differ.
//    Leave those to Intl + the weekStart field; do not assemble strings by hand.
//
// 4. RTL languages such as Arabic drive <html dir> through dir:'rtl'.
//
// To add a language: add one line to LOCALES, then write one dict. Missing keys fall back
// automatically, so it never goes blank.

/** First day of the week: 0=Sunday (US / JP / KR / HK / TW ...), 1=Monday (CN / EU / RU / LatAm ...) */
export const LOCALES = [
  { code: 'zh-Hans', name: '简体中文', chain: ['zh-Hans', 'zh'], weekStart: 1, lang: 'zh' },
  { code: 'zh-Hant', name: '繁體中文', chain: ['zh-Hant', 'zh-Hans'], weekStart: 1, lang: 'zh' },
  { code: 'zh-HK', name: '香港繁體', chain: ['zh-HK', 'zh-Hant', 'zh-Hans'], weekStart: 0, lang: 'zh' },
  { code: 'zh-TW', name: '臺灣正體', chain: ['zh-TW', 'zh-Hant', 'zh-Hans'], weekStart: 0, lang: 'zh' },
  { code: 'ja-JP', name: '日本語', chain: ['ja-JP', 'en-US'], weekStart: 0 },
  { code: 'ko-KR', name: '한국어', chain: ['ko-KR', 'en-US'], weekStart: 0 },
  { code: 'en-US', name: 'English (US)', chain: ['en-US', 'en'], weekStart: 0 },
  { code: 'en-GB', name: 'English (UK)', chain: ['en-GB', 'en-US'], weekStart: 1 },
  { code: 'en-AU', name: 'English (Australia)', chain: ['en-AU', 'en-GB', 'en-US'], weekStart: 1 },
  { code: 'en-CA', name: 'English (Canada)', chain: ['en-CA', 'en-GB', 'en-US'], weekStart: 0 },
  { code: 'es-ES', name: 'Español (España)', chain: ['es-ES', 'en-US'], weekStart: 1 },
  { code: 'es-419', name: 'Español (Latinoamérica)', chain: ['es-419', 'es-ES', 'en-US'], weekStart: 1 },
  { code: 'es-MX', name: 'Español (México)', chain: ['es-MX', 'es-419', 'es-ES'], weekStart: 1 },
  { code: 'es-AR', name: 'Español (Argentina)', chain: ['es-AR', 'es-419', 'es-ES'], weekStart: 1 },
  { code: 'pt-PT', name: 'Português (Portugal)', chain: ['pt-PT', 'en-US'], weekStart: 1 },
  { code: 'pt-BR', name: 'Português (Brasil)', chain: ['pt-BR', 'pt-PT'], weekStart: 0 },
  { code: 'fr-FR', name: 'Français', chain: ['fr-FR', 'en-US'], weekStart: 1 },
  { code: 'fr-CA', name: 'Français (Canada)', chain: ['fr-CA', 'fr-FR'], weekStart: 0 },
  { code: 'de-DE', name: 'Deutsch', chain: ['de-DE', 'en-US'], weekStart: 1 },
  { code: 'it-IT', name: 'Italiano', chain: ['it-IT', 'en-US'], weekStart: 1 },
  { code: 'ru-RU', name: 'Русский', chain: ['ru-RU', 'en-US'], weekStart: 1 },
  { code: 'uk-UA', name: 'Українська', chain: ['uk-UA', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'sr-RS', name: 'Српски', chain: ['sr-RS', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'pl-PL', name: 'Polski', chain: ['pl-PL', 'ru-RU', 'en-US'], weekStart: 1 },
  { code: 'ar-SA', name: 'العربية', chain: ['ar-SA', 'en-US'], weekStart: 0, dir: 'rtl' },
];

export const byCode = (code) => LOCALES.find((l) => l.code === code) ?? null;

/** Pick one of the regions we support out of the browser's language list */
export function negotiate(langs) {
  const list = (langs ?? []).map((s) => String(s).replace('_', '-'));
  for (const raw of list) {
    const exact = LOCALES.find((l) => l.code.toLowerCase() === raw.toLowerCase());
    if (exact) return exact.code;
    const base = raw.split('-')[0].toLowerCase();
    // First look at which full regions exist for this same language: if any, give it the first one
    // (usually the "home country")
    const sameLang = LOCALES.filter((l) => l.code.split('-')[0].toLowerCase() === base);
    if (sameLang.length) {
      const preferred = { zh: 'zh-Hans', en: 'en-US', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR' }[base];
      return (preferred && sameLang.find((l) => l.code === preferred)?.code) || sameLang[0].code;
    }
  }
  return 'en-US';
}

// ─────────────────────────────────────────────────────────────
// Overlay entries: only the keys that differ from the level above.
// The two complete sets, zh-Hans / en-US, live in i18n.jsx (they already have 600+ entries).
// ─────────────────────────────────────────────────────────────

// The Simplified -> Traditional mapping table has been **removed**: a hand-written table cannot
// tell "same glyph in both scripts" from "a character that was missed", and it produced mixed-script
// UIs.
// Traditional is now generated wholesale at build time by tools/i18n-hant.mjs from the OpenCC
// dictionaries (locales/generated.js), with the hk / twp dictionaries for Hong Kong and Taiwan
// Traditional, including wording differences (software / network / information / default /
// storage all differ between zh-Hans and zh-Hant).
// British spelling lives in GB_SPELL / GB_STEMS in locales/overlays.js.
