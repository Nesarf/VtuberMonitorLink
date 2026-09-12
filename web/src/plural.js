// plural.js — number-aware labels (see BUGS #54)
//
// The UI is full of "number + noun" labels: `20 items`, `3 days`, `21 элемент`.
// English can almost be served by one fixed string, but Russian, Ukrainian, Polish,
// Serbian and Arabic inflect the noun by the numeral (`1 запись` / `2 записи` / `5 записей`),
// and Spanish / Portuguese / French / German / Italian at least need singular vs plural.
// A single string per key simply cannot express that — it was flagged as BUGS #54.
//
// The mechanism, deliberately kept out of JSX so it can be unit-tested in plain Node:
//   * the dictionary may carry extra keys `<key>_<category>` (`items_one`, `items_few`, …)
//     where `<category>` is an Intl.PluralRules category (zero/one/two/few/many/other);
//   * `pickPlural()` selects the category for the number, then falls back to the plain key
//     — the same-language-only rule the rest of the i18n layer follows (no cross-language
//     fallback), so a language that lacks a category keeps its own generic wording;
//   * a chosen value may embed `{n}` when the number belongs *inside* the phrase
//     (Arabic, Russian, …); if it does not, the caller's number is prepended (`20 items`).
//
// These `<key>_<category>` keys are looked up dynamically, so the UI never names them literally:
// coverage and proofreading (which work on keys the UI references) are unaffected, and
// integrity-check's zh/en parity rule applies to them like any other key.
const RULES = new Map();

function rulesFor(locale) {
  let r = RULES.get(locale);
  if (!r) {
    try {
      r = new Intl.PluralRules(locale);
    } catch (e) {
      // Unknown/invalid locale tag: fall back to a single-form rule rather than throwing
      // in the middle of rendering (the UI would go blank over a label).
      r = new Intl.PluralRules('en');
    }
    RULES.set(locale, r);
  }
  return r;
}

/** CLDR category for `n` in `locale`: zero | one | two | few | many | other. */
export function pluralCategory(locale, n) {
  // Note: `Number(null)` is 0 and `Number('')` is 0, so a missing value would silently look
  // like "zero items" and pick the wrong form. Anything that is not a real number falls back
  // to `other`, which is the form that always exists.
  if (n === null || n === undefined || n === '' || typeof n === 'boolean') return 'other';
  const num = Number(n);
  if (!Number.isFinite(num)) return 'other';
  try {
    return rulesFor(locale).select(num);
  } catch (e) {
    return 'other';
  }
}

/**
 * Raw dictionary value for "key + number": `<key>_<category>` when the language provides it,
 * otherwise the plain `<key>` of the same dictionary. Returns null when neither exists
 * (the caller then falls back to English, exactly like `t()` does).
 */
export function pickPlural(dict, key, locale, n) {
  const cat = pluralCategory(locale, n);
  const suffixed = dict?.[`${key}_${cat}`];
  if (typeof suffixed === 'string' && suffixed) return suffixed;
  const base = dict?.[key];
  return typeof base === 'string' ? base : null;
}

/** Replace `{n}` (and any other `{name}` given in params) in a label. */
export function fillParams(text, params) {
  if (!params) return String(text);
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

/**
 * A complete "count + noun" label.
 * The number lives inside the phrase when the chosen wording contains `{n}`
 * (that is how the inflected languages do it), otherwise it is prepended as before.
 */
export function countLabel(raw, n) {
  if (raw === null || raw === undefined || raw === '') return String(n);
  return /\{n\}/.test(raw) ? fillParams(raw, { n }) : `${n} ${raw}`;
}
