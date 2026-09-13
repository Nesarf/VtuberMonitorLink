// i18n-proofread.mjs — proofread every locale, entry by entry / proofread every locale, every used key
//
// Why it is needed: the translation pipeline and the coverage check can only answer "is there a value"
// and "is there still Chinese left". The mistakes that actually break the UI are **structural**:
// a placeholder got eaten ({target} is gone -> the hint turns into a broken sentence), a Markdown **
// lost its pair (the whole block renders bold), a newline got swallowed (two hints glued into one line),
// full-width punctuation leaked into a European locale, a button label got cut off mid-sentence.
// These mistakes **throw nothing and never show a white screen**, they just quietly turn ugly --
// so every single string has to be compared against its source.
//
// Two tiers of verdicts:
//   hard    structural breakage (placeholder/bold/newline/leading-trailing space) -> fail outright, the ratchet holds
//   suspect suspicious but possibly right (identical to English, absurd length, full-width punctuation,
//           duplicate translation...) -> recorded, must not grow
//
//   node tools/i18n-proofread.mjs                 all locales + compare against the baseline
//   node tools/i18n-proofread.mjs --locale ko-KR  one locale only
//   node tools/i18n-proofread.mjs --max 20        at most N rows per check
//   node tools/i18n-proofread.mjs --update        write the current suspect counts out as the new baseline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCALES, byCode } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';
import { convertDict, toBritish } from '../web/src/locales/spelling.js';
import { readDicts, usedKeys } from './lib/i18n-source.mjs';
import { usableChain } from './lib/locale-chain.mjs';
import { looksUntranslated } from './i18n-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'web/src/locales/proofread.json');

const args = { locale: '', max: 6, update: false, quiet: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--locale') args.locale = String(process.argv[++i] ?? '');
  else if (a === '--max') args.max = Number(process.argv[++i]) || 6;
  else if (a === '--update') args.update = true;
  else if (a === '--quiet') args.quiet = true;
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const { zh, en } = readDicts();
const USED = [...usedKeys()];
const MACHINE = readJson(path.join(ROOT, 'web/src/locales/machine.json'), {});
const GLOSSARY = readJson(path.join(ROOT, 'web/src/locales/glossary.json'), {});
const GENERATED = (await import(pathToFileURL(path.join(ROOT, 'web/src/locales/generated.js')).href)).GENERATED ?? {};

// The merge that corresponds **character for character** to the dict memo in i18n.jsx (per-level
// forward merge, then English fallback).
// The moment the order differs, the thing being proofread is no longer the same thing the UI shows --
// and then this report means nothing at all.
// In particular the `OVERLAY[c] ?? derived[c] ?? STRINGS[c] ?? {}` at the end of every level:
// what goes here is **{}**, not the English dictionary. With the English dictionary, every region that
// has no hand layer of its own (fr-CA, say) gets buried under the whole English file -- which is how I
// wrote the first version, and it "found" a fake problem of 560 English rows (the real UI is French).
// A false positive of your own checker lies to you just as well.
const EN_DICT = Object.fromEntries(en);
const derived = { ...GENERATED, 'en-GB': convertDict(EN_DICT, toBritish), 'en-AU': convertDict(EN_DICT, toBritish), 'en-CA': convertDict(EN_DICT, toBritish) };
const ZH_DICT = Object.fromEntries(zh);

/** The base text of one level itself (only zh / en have a whole dictionary; other regions have none, so an empty object) */
const baseDictFor = (c) => (c === 'zh' || c === 'zh-Hans' ? ZH_DICT : c === 'en' || c === 'en-US' ? EN_DICT : {});

function mergedDict(code) {
  let out = {};
  for (const c of usableChain(code)) {
    const level = {
      ...(MACHINE[c] ?? {}),
      ...(HAND_COMMON[c] ?? {}),
      ...(HAND[c] ?? derived[c] ?? baseDictFor(c)),
    };
    out = { ...out, ...level };
  }
  return { ...EN_DICT, ...out };
}

/** The values this locale supplies **itself** (English fallbacks do not count), to tell "missing translation" from "English fallback" */
function ownDict(code) {
  const own = {};
  if (code.split('-')[0] === 'en') return { ...EN_DICT }; // English is the base language itself, its whole dictionary counts as "its own"
  for (const c of usableChain(code)) {
    for (const layer of [MACHINE[c], HAND_COMMON[c], HAND[c], derived[c]]) {
      if (layer) Object.assign(own, layer);
    }
    Object.assign(own, baseDictFor(c));
  }
  return own;
}

// ───────────────────────────────────────────── structural fingerprint

/**
 * Any sentinel shape at all, not just the numbered kind.
 *
 * BUGS #64: i18n-translate.mjs's hasStraySentinel() only matches ⟦<digits>⟧, so a leftover sentinel
 * carrying a *name* walked straight through the pipeline: web/src/locales/machine.json shipped
 * `ar-SA outsideRange = "تم استبعاد ⟦n⟧ عنصرًا بسبب شرط الوقت"` and Arabic users literally saw ⟦n⟧ in
 * the UI. A named sentinel is exactly as broken as a numbered one -- the numeric-only regex is what
 * let this one ship -- so anything between ⟦ and ⟧ is a hard failure for the locale that shows it.
 */
const SENTINEL_RE = /⟦[^⟧]*⟧/g;
/** Non-global twin of SENTINEL_RE for `.test()` (a /g regex would carry `lastIndex` from call to call) */
const SENTINEL_TEST = /⟦[^⟧]*⟧/;

/**
 * Tokens that must stay **character for character unchanged**: touch one and the UI breaks
 * ({target} gone -> the hint turns into a broken sentence).
 * Note that date/time formats are deliberately **not** in here -- those are instructions for the
 * reader, and translating "MM-DD" into "MM-JJ" / "MM-TT" is actually **correct** (that is how the
 * French write dates); counting it as structural breakage would raise a pile of false alarms
 * (which is exactly what the first version did).
 */
const LITERAL_RES = [
  /\{[A-Za-z_][\w.]*\}/g, // {target} / {n}
  /\$\{[^}]+\}/g, // ${x}
  /%[sdif]\b/g, // %s
  /%[A-Z_]+%/g, // %TEMP%
  SENTINEL_RE,
  /<\/?[a-z][a-z0-9]*>/g, // <video>
];

/** Date/time format tokens: compared by **class** (all-caps shapes: MM-DD / YYYY-MM-DD / MM-JJ / ДД-ММ) */
const FORMAT_RE = /\b[A-ZА-Я]{2,4}(?:-[A-ZА-Я]{2,4}){1,2}\b/g;

export function literalTokens(text) {
  const out = [];
  for (const re of LITERAL_RES) for (const m of String(text).matchAll(re)) out.push(m[0]);
  return out.sort();
}

export function formatTokens(text) {
  return [...String(text).matchAll(FORMAT_RE)].map((m) => m[0]);
}

const countOf = (text, needle) => String(text).split(needle).length - 1;
/** Full-width punctuation: normal writing in Chinese/Japanese/Korean, a problem only once it leaks into European or Arabic locales */
const cjkPunct = /[（）【】「」『』，。；：？！、]/;

// ───────────────────────────────────────────── per-locale proofreading

const HARD = [];
const SUSPECT = [];
const lengthSamples = [];
const addHard = (code, key, why, val, src) => HARD.push({ code, key, why, val, src });

const rows = [];
for (const loc of LOCALES) {
  if (args.locale && loc.code !== args.locale) continue;
  const dict = mergedDict(loc.code);
  const own = ownDict(loc.code);
  const lang = String(loc.code).split('-')[0];
  const ownHan = [];
  const ownSuspect = [];

  for (const key of USED) {
    const src = zh.get(key);
    if (!src) continue; // a key with no source string cannot be compared (and should not exist)
    const val = dict[key];
    if (val === undefined) {
      addHard(loc.code, key, 'no value at all (not even the English fallback)', '', src);
      continue;
    }
    const inOwn = Object.prototype.hasOwnProperty.call(own, key);

    // ── hard: structural breakage (checked on the **value that gets displayed**, hand-written or machine-translated alike)
    const tSrc = literalTokens(src).join(' ');
    const tVal = literalTokens(val).join(' ');
    if (tSrc !== tVal) addHard(loc.code, key, `placeholder mismatch: source "${literalTokens(src).join('') || 'none'}" -> translation "${literalTokens(val).join('') || 'none'}"`, val, src);
    // A count label with no noun left: "{n}" with the noun dropped passes every other gate the
    // pipeline has - the placeholder is intact, there are no Han characters, no length rule fires -
    // and the UI then shows a bare number. Indonesian's cookieCount shipped exactly like that and was
    // caught by hand; this check exists so the next one is caught by the tool.
    if (/\{n\}/.test(src)) {
      const bare = String(val).replace(/\{n\}/g, '').replace(/[0-9\s.,'"(){}[\]<>:;!?…·–—-]/g, '');
      if (!bare) addHard(loc.code, key, 'count label lost its noun: the value interpolates {n} and carries nothing else', val, src);
    }
    if (SENTINEL_TEST.test(val)) addHard(loc.code, key, 'stray sentinel (a ⟦...⟧ the model invented, nothing should survive the restore)', val, src);
    const boldSrc = countOf(src, '**');
    const boldVal = countOf(val, '**');
    if (boldSrc !== boldVal) addHard(loc.code, key, `bold markers unbalanced: source ${boldSrc} ** / translation ${boldVal}`, val, src);
    const nlSrc = countOf(src, '\n');
    const nlVal = countOf(val, '\n');
    if (nlSrc !== nlVal) addHard(loc.code, key, `newline count differs: source ${nlSrc} / translation ${nlVal}`, val, src);
    if (src.trim() !== src || String(val).trim() !== String(val)) {
      const srcPad = src.length - src.trim().length;
      const valPad = String(val).length - String(val).trim().length;
      if (srcPad !== valPad) addHard(loc.code, key, `leading/trailing whitespace differs: source ${srcPad} / translation ${valPad}`, val, src);
    }
    // Date-format tokens: only the **whole class disappearing** counts as structural (a count difference is a suspect item, see below)
    const fmtSrc = formatTokens(src);
    const fmtVal = formatTokens(val);
    if (fmtSrc.length && fmtVal.length === 0) addHard(loc.code, key, `date-format hint lost entirely: source "${[...new Set(fmtSrc)].join(', ')}"`, val, src);
    if (fmtSrc.length && fmtVal.length && fmtVal.length !== fmtSrc.length) {
      ownSuspect.push({ key, why: `date-format occurrence count differs (source ${[...new Set(fmtSrc)].join(',')} / translation ${[...new Set(fmtVal)].join(',')})`, val, src, kind: 'datefmt' });
    }

    // ── suspect: suspicious but possibly right
    // Keys whose "source text is English" (LLM / API Key / product names) need no translation at all, so they do not count as missing
    const langNeutral = src === en.get(key);
    if (!inOwn && !langNeutral) {
      ownSuspect.push({ key, why: 'this row is an English fallback (this locale never wrote its own)', val, src, kind: 'fallback' });
      continue;
    }
    if (lang !== 'en' && !langNeutral && src.length >= 12 && en.get(key) === val && src !== en.get(key)) {
      // A short label happening to equal the English is perfectly normal (cognates like Total / No / Proxy);
      // only a whole sentence still in English is worth a second look
      ownSuspect.push({ key, why: 'long sentence identical to the English word for word (the source string is not English)', val, src, kind: 'same-as-en' });
    }
    if (lang !== 'zh' && lang !== 'ja' && lang !== 'ko') {
      // Full-width punctuation that the **source string** already carries as *data* (the ideographic comma in
      // "ideographic-comma separated", say -- it is a character the user really does have to type) does not
      // count as "leaked in": only punctuation the source lacks and the translation produces by itself does.
      const srcPunct = new Set(String(src).match(/[（）【】「」『』，。；：？！、]/g) ?? []);
      const strayPunct = [...new Set(String(val).match(/[（）【】「」『』，。；：？！、]/g) ?? [])].filter((c) => !srcPunct.has(c));
      if (strayPunct.length) ownSuspect.push({ key, why: `full-width punctuation leaked in: "${strayPunct.join('')}"`, val, src, kind: 'cjk-punct' });
    }
    if (lang !== 'zh' && lang !== 'ja' && src.length >= 5 && String(en.get(key) ?? '').length >= 8) {
      // Absurd length is judged one step later, **across locales**: comparing one locale against English alone
      // says nothing -- Korean "알림 창 안" against English "Within reminder window" is only 0.29 too, and that
      // is not a mistake, the language is simply compact. See lengthOutliers() below.
      lengthSamples.push({ code: loc.code, key, val: String(val) });
    }
    if (src.trimEnd().endsWith('…') !== String(val).trimEnd().endsWith('…')) {
      ownSuspect.push({ key, why: 'ellipsis presence differs', val, src, kind: 'ellipsis' });
    }
    // The glossary gives this locale's agreed wording, yet the translation still carries the **Chinese source
    // word** -> the override value never took effect.
    // Only Chinese terms are checked: Latin terms (bilibili / VTuber) may legitimately appear in their original
    // form, and an alias like the short form of bilibili maps to the same value, so using it as the criterion
    // would necessarily raise false positives (learnt the hard way).
    for (const [term, spec] of Object.entries(GLOSSARY)) {
      if (term.startsWith('_')) continue;
      if (!/[\u4e00-\u9fff]/.test(term)) continue;
      const target = spec?.[loc.code];
      if (!target || target === term) continue;
      if (String(src).includes(term) && String(val).includes(term)) {
        ownSuspect.push({ key, why: `glossary term "${term}" should be written "${target}" but the translation still carries the source word`, val, src, kind: 'glossary' });
        break;
      }
    }
    // A glossary term whose `default` is a **translation** rather than the source term leaks that
    // translation into every locale without an override. The glossary's own note says `default` means
    // "keep as-is", but 25 Chinese terms carry an English default, so a French or Russian sentence ends
    // up with an English noun phrase inside it ("Importar desde VDBPersonas seguidas"), and nothing
    // reported it: looksUntranslated() strips keep-terms before testing, and needsRetranslate() hashes
    // the text after the term was substituted. This measures it instead of guessing.
    if (lang !== 'en') {
      for (const [term, spec] of Object.entries(GLOSSARY)) {
        if (term.startsWith('_') || !spec || typeof spec.default !== 'string') continue;
        if (!/[\u4e00-\u9fff]/.test(term)) continue; // a Latin term: keeping it is the whole point
        if (/[\u4e00-\u9fff]/.test(spec.default)) continue; // default is the source term: keep as-is, fine
        if (spec[loc.code]) continue; // this locale has agreed wording of its own
        if (!String(src).includes(term)) continue;
        if (String(val).includes(spec.default)) {
          ownSuspect.push({ key, why: `glossary "${term}" fell back to its English default "${spec.default}" (this locale has no override for it)`, val, src, kind: 'glossary-default' });
          break;
        }
      }
    }
    if (lang !== 'zh' && lang !== 'ja' && looksUntranslated(val, loc.code, GLOSSARY)) {
      addHard(loc.code, key, 'the translation still carries the Chinese source text', val, src);
    }
    ownHan.push(key);
  }

  // ── suspect: two different source strings inside one locale translated into the **same long sentence**
  // (usually a copy-paste slip). Long sentences only: short labels colliding is normal
  // (calAdded and calAlready are the very same string in Japanese).
  const byValue = new Map();
  for (const key of USED) {
    const val = own[key];
    if (typeof val !== 'string' || val.length < 25) continue;
    const src = zh.get(key);
    if (!src) continue;
    if (!byValue.has(val)) byValue.set(val, []);
    byValue.get(val).push(key);
  }
  let dupCount = 0;
  for (const [val, keys] of byValue) {
    if (keys.length < 2) continue;
    const srcs = new Set(keys.map((k) => zh.get(k)));
    if (srcs.size < 2) continue; // the source strings were identical to begin with, so identical values are right
    dupCount += keys.length;
    if (ownSuspect.length < 400) ownSuspect.push({ key: keys.join(' / '), why: 'different source strings translated into the same value (check for a copy-paste slip)', val, src: [...srcs].join(' | '), kind: 'duplicate' });
  }

  rows.push({ code: loc.code, name: loc.name, hard: HARD.filter((h) => h.code === loc.code).length, suspect: ownSuspect.length, dupCount, covered: ownHan.length });
  for (const s of ownSuspect) SUSPECT.push({ code: loc.code, ...s });
}

// Cross-locale length outliers: appended to the suspect list (every one names its locale, so it can be fixed directly)
for (const x of lengthOutliers()) {
  SUSPECT.push(x);
  const row = rows.find((r) => r.code === x.code);
  if (row) row.suspect++;
}

// ───────────────────────────────────────────── cross-locale: length outliers

/**
 * The **median** length of one key across the 25 locales is a very good baseline:
 * each language's own tightness is already expressed in the median, and only a real mistake
 * (truncated, reduced to a single sentence, or the whole paragraph dropped while translating) stands out.
 */
function lengthOutliers() {
  const byKey = new Map();
  for (const s of lengthSamples) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  const out = [];
  for (const [key, list] of byKey) {
    if (list.length < 6) continue; // too few samples, the median is not trustworthy
    const lens = list.map((x) => x.val.length).sort((a, b) => a - b);
    const mid = lens[Math.floor(lens.length / 2)];
    if (mid < 6) continue;
    for (const x of list) {
      if (x.val.length > mid * 3 || x.val.length < mid * 0.3) {
        out.push({ code: x.code, key, val: x.val, src: zh.get(key) ?? '', why: `length outlier: the median of the other locales is ${mid}, this one is ${x.val.length}`, kind: 'length' });
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────── report

const byKind = (kind) => SUSPECT.filter((s) => s.kind === kind);
const hardByWhy = new Map();
for (const h of HARD) {
  // Group by the category part of the reason, i.e. the text before the colon; the detail after it varies per key
  const k = h.why.replace(/:.*$/, '');
  if (!hardByWhy.has(k)) hardByWhy.set(k, []);
  hardByWhy.get(k).push(h);
}

/** Which locales one and the same key fails in -- "one key broken 25 times" and "25 keys broken once each" are two different things */
function hardByKey() {
  const m = new Map();
  for (const h of HARD) {
    if (!m.has(h.key)) m.set(h.key, { key: h.key, why: h.why, codes: [] });
    m.get(h.key).codes.push(h.code);
  }
  return [...m.values()].sort((a, b) => b.codes.length - a.codes.length);
}

process.stdout.write(`\nproofread scope: ${USED.length} UI entries × ${rows.length} locales\n`);
process.stdout.write(`source strings come from the simplified dictionary (${zh.size} entries); displayed values are computed with the i18n.jsx merge order\n\n`);
for (const r of rows.sort((a, b) => b.hard - a.hard || b.suspect - a.suspect || a.code.localeCompare(b.code))) {
  const flag = r.hard ? `✗ structural ${r.hard}` : '✓ fine';
  process.stdout.write(`  ${r.code.padEnd(9)} ${flag.padEnd(16)} suspect ${String(r.suspect).padStart(3)}  own entries ${r.covered}\n`);
}

const show = (title, list, fmt) => {
  if (!list.length) return;
  process.stdout.write(`\n${title} (${list.length} rows)\n`);
  for (const x of list.slice(0, args.max)) process.stdout.write('  ' + fmt(x) + '\n');
  if (list.length > args.max) process.stdout.write(`  ...and ${list.length - args.max} more\n`);
};

if (!args.quiet) {
  for (const [why, list] of hardByWhy) {
    show(`✗ ${why}`, list, (x) => `${x.code} ${x.key}\n      source: ${JSON.stringify(String(x.src).slice(0, 90))}\n      value: ${JSON.stringify(String(x.val).slice(0, 90))}`);
  }
  show('✗ the same key fails in several locales (grouped by key)', hardByKey(), (x) => `${x.key} -- ${x.codes.join(', ')}\n      ${x.why}`);
  show('suspect: this row is really an English fallback (the locale did not write its own)', byKind('fallback'), (x) => `${x.code} ${x.key}`);
  show('suspect: identical to the English word for word', byKind('same-as-en'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 60))}`);
  show('suspect: date-format occurrence count differs (localizing to JJ/TT/GG and the like is normal; only a count difference is suspicious)', byKind('datefmt'), (x) => `${x.code} ${x.key}\n      ${x.why}`);
  show('suspect: full-width punctuation leaked into a European/Arabic locale', byKind('cjk-punct'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('suspect: short text with an absurd length', byKind('length'), (x) => `${x.code} ${x.key}\n      source: ${JSON.stringify(String(x.src).slice(0, 50))}\n      value: ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('suspect: ellipsis presence differs', byKind('ellipsis'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('suspect: the glossary wording never took effect', byKind('glossary'), (x) => `${x.code} ${x.key}\n      ${x.why}\n      value: ${JSON.stringify(String(x.val).slice(0, 80))}`);
  show('suspect: different source strings translated into the same value', byKind('duplicate'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 60))}`);
}

const counts = Object.fromEntries(rows.map((r) => [r.code, r.suspect]));
const totalSuspect = SUSPECT.length;

if (args.update) {
  fs.writeFileSync(BASELINE, JSON.stringify({ generatedAt: new Date().toISOString(), used: USED.length, locales: counts }, null, 2) + '\n', 'utf8');
  process.stdout.write(`\nbaseline written: ${path.relative(ROOT, BASELINE)}\n`);
  process.exit(HARD.length ? 1 : 0);
}

const baseline = readJson(BASELINE, null);
let regressed = [];
if (baseline?.locales) {
  regressed = rows.filter((r) => (baseline.locales[r.code] ?? 0) < r.suspect).map((r) => `${r.code}: ${baseline.locales[r.code] ?? 0} → ${r.suspect}`);
}

process.stdout.write(`\nstructural (hard) problems: ${HARD.length} · suspect: ${totalSuspect}\n`);
if (regressed.length) {
  process.stdout.write('\nsuspect counts grew against the baseline (fix them, or confirm and --update):\n');
  for (const r of regressed) process.stdout.write('  - ' + r + '\n');
}
if (HARD.length || regressed.length) {
  process.stdout.write('\nproofread failed\n');
  process.exit(1);
}
process.stdout.write('\nproofread passed ✓\n');
