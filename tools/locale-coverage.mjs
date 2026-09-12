// locale-coverage.mjs - real per-locale coverage
//
// Why this exists: claiming "12 languages were added" is easy, but what is actually useful is
// **how much of the UI is native and how much falls back to English**. Missing keys fall back to
// English silently, so users see a half-English, half-native UI and nothing anywhere reports an
// error - that "looks finished" state is the easiest one to fool yourself with.
//
// This script computes coverage and **holds a floor under it**:
//   - only keys the language provides itself count; English fallbacks are not coverage
//   - coverage is written to web/src/locales/coverage.json as a baseline, and dropping below it
//     is an error (a ratchet: coverage may only move up, and features added later cannot quietly
//     degrade it)
//
//   node tools/locale-coverage.mjs            report + compare against the baseline
//   node tools/locale-coverage.mjs --update   write the current numbers as the new baseline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, byCode } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';
import { usableChain } from './lib/locale-chain.mjs';
import { readDicts } from './lib/i18n-source.mjs';
import { looksBroken, humanKeys } from './i18n-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'web/src/i18n.jsx');
const BASELINE = path.join(ROOT, 'web/src/locales/coverage.json');

/**
 * Entry parsing goes through tools/lib/i18n-source.mjs (the single implementation).
 * This file used to carry its own stripStrings/blockFor/topLevelKeys/zhValueLengths, which let
 * "the entries the pipeline knows" and "the entries coverage counts" diverge - exactly where
 * untranslated entries hide.
 */
const dicts = readDicts(fs.readFileSync(I18N, 'utf8'));
const zhKeys = new Set(dicts.zh.keys());
const enKeys = new Set(dicts.en.keys());

// The keys the UI actually uses (only these are worth counting: dead keys in the dictionary do not count)
const CODE = ['.js', '.jsx'];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (CODE.includes(path.extname(e.name))) files.push(path.join(dir, e.name));
  }
})(path.join(ROOT, 'web/src'));
const used = new Set();
for (const f of files) {
  // `tn('key', n)` (number-aware labels) references a key just like `t('key')` does — see BUGS #54
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/\btn?\(\s*'([^']+)'\s*[,)]/g)) used.add(m[1]);
}
// Dynamic keys: tab_<id> / calKind_<kind> / llmFeat_<key> and the like
const dynamicPrefixes = ['tab_', 'calKind_', 'llmFeat_', 'taskMode_', 'on_', 'freq_', 'field_', 'mode_', 'sort_'];
for (const k of enKeys) if (dynamicPrefixes.some((p) => k.startsWith(p))) used.add(k);

/**
 * Keys that "never needed translating": the zh source text is **character-for-character** the
 * same as English (brand names and abbreviations, e.g. LLM / API Key). They render the same
 * string in every language, and counting them in the denominator only creates a gap that can
 * never be closed (every language shows 563/565, looking like 2 missing entries when in fact
 * those 2 need no translation). The predicate comes from the source itself, with no separate
 * "exemption list" - a list drifts, the source does not.
 */
const LANG_NEUTRAL = new Set(
  [...used].filter((k) => {
    const v = dicts.zh.get(k);
    return !!v && v === dicts.en.get(k);
  }),
);
const localizable = [...used].filter((k) => !LANG_NEUTRAL.has(k));
const langNeutral = [...LANG_NEUTRAL].sort();

/**
 * The fallback chain comes from tools/lib/locale-chain.mjs (the single implementation, also used
 * by the translation pipeline). This file used to re-implement the i18n.jsx logic, and drifted
 * into a second, different semantic than humanKeys.
 */

let GENERATED = {};
try {
  GENERATED = (await import(path.join(ROOT, 'web/src/locales/generated.js'))).GENERATED ?? {};
} catch {
  GENERATED = {};
}

// The machine-translation layer (optional): the output of tools/i18n-translate.mjs. It **counts
// as localized** - to a user, "has a Japanese translation" versus "was written by hand" makes no
// difference to the UI experience; tracking them separately is only so we know which entries
// still need human review (that is what --review is for).
let MACHINE = {};
try {
  MACHINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/machine.json'), 'utf8'));
} catch {
  MACHINE = {};
}

// Glossary: both the exemption basis for "intentionally kept as-is" and an input to the pipeline's predicate functions
let GLOSSARY = {};
try {
  GLOSSARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8'));
} catch {
  GLOSSARY = {};
}

/** The keys this language provides **itself** (excluding whatever finally falls back to English) */
function ownKeys(code) {
  const keys = new Set();
  // English itself and its spelling variants are not a "translation" but the base language
  // (en-GB/AU/CA spellings are derived from en by toBritish(), they cover the whole dictionary
  // and must not show 0%)
  if (code.split('-')[0] === 'en') return enKeys;
  for (const c of usableChain(code)) {
    for (const layer of [HAND_COMMON[c], HAND[c], GENERATED[c]]) {
      if (!layer) continue;
      for (const k of Object.keys(layer)) keys.add(k);
    }
    // zh-Hans is a base language, its own dictionary is enough; zh-Hant is generated from it in full at build time
    if (c === 'zh' || c === 'zh-Hans') for (const k of zhKeys) keys.add(k);
  }
  // Machine translations count as "this language's own" too - they directly decide what the user sees
  for (const c of [code, ...usableChain(code)]) {
    const m = MACHINE[c];
    if (m) for (const k of Object.keys(m)) keys.add(k);
  }
  return keys;
}

const total = localizable.length;
const rows = [];
for (const loc of LOCALES) {
  const own = ownKeys(loc.code);
  const covered = localizable.filter((k) => own.has(k)).length;
  // "Has a value" is not "is usable": a missed machine translation leaves the source text
  // behind, and the model also invents sentinels (real incident: "daqui a ⟦0⟧ dias" showed up in
  // the Portuguese UI). The predicate is the one function from the pipeline - this file used to
  // carry a copy of it, and even disagreed about stripping long terms before short ones.
  // Machine entries shadowed by the human layer do not count: they **never render**, so reporting
  // them only sends people off to fix something invisible.
  const mach = MACHINE[loc.code] ?? (loc.code.split('-')[0] === 'en' ? {} : null);
  const shadowed = humanKeys(loc.code);
  let suspicious = 0;
  if (mach) {
    for (const [k, v] of Object.entries(mach)) {
      if (shadowed.has(k)) continue;
      if (looksBroken(v, loc.code, GLOSSARY)) suspicious++;
    }
  }
  rows.push({ code: loc.code, name: loc.name, covered, total, pct: total ? covered / total : 0, suspicious });
}
rows.sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code));

const bar = (p) => {
  const n = Math.round(p * 20);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};

process.stdout.write(`\nEntries the UI uses: ${used.size} (of which ${langNeutral.length} have a zh source text identical to English, so no language needs them translated: ${langNeutral.join(' / ')})\n`);
process.stdout.write(`Entries needing localization: ${total}\n\n`);
for (const r of rows) {
  const warn = r.suspicious ? `   ⚠ broken translations ${r.suspicious}` : '';
  process.stdout.write(`  ${r.code.padEnd(9)} ${bar(r.pct)} ${String(Math.round(r.pct * 100)).padStart(3)}%  ${r.covered}/${r.total}  ${r.name}${warn}\n`);
}
const suspiciousTotal = rows.reduce((n, r) => n + r.suspicious, 0);
if (suspiciousTotal) {
  process.stdout.write(`\n  ⚠ ${suspiciousTotal} machine translations are broken (they still hold the source text, or a stray ⟦n⟧ sentinel - coverage only counts "has a value", this counts "is usable")\n`);
  process.stdout.write(`     Fix: node tools/i18n-translate.mjs --engine app --bust suspicious --locales <...>\n`);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
const update = process.argv.includes('--update');

/**
 * "Key -> value length" for zh entries, taken straight from the parser instead of yet another
 * hand-written regex. Bucketing must key off the length of the **value**, not of the key name -
 * buttons/fields are short values (cheap to translate, most visible), hint sentences are long
 * values (far more expensive). The first version bucketed by key name, so all 516 entries were
 * classified as "short keys" (though plenty of them were long sentences), which made the split
 * useless.
 */
const valueLen = new Map([...dicts.zh].map(([k, v]) => [k, (v ?? '').length || 400]));

/** Fetch a zh entry's value (shown alongside the missing list to make translation decisions easier) */
const zhValueOf = (key) => dicts.zh.get(key) ?? '';

// --missing <code>: list the UI entries this language has **not localized yet** (used to pick the
// next batch of keys to translate instead of guessing from memory which ones are missing).
// Short values first - those are the buttons and fields a user sees the moment the page opens.
const missingIdx = process.argv.indexOf('--missing');
if (missingIdx >= 0) {
  const code = process.argv[missingIdx + 1];
  const loc = byCode(code);
  if (!loc) {
    process.stderr.write(`unknown locale code: ${code}\n`);
    process.exit(1);
  }
  const own = ownKeys(code);
  const missing = localizable.filter((k) => !own.has(k));
  const short = missing.filter((k) => (valueLen.get(k) ?? 99) <= 12).sort();
  const mid = missing.filter((k) => (valueLen.get(k) ?? 99) > 12 && (valueLen.get(k) ?? 99) <= 40).sort();
  const long = missing.filter((k) => (valueLen.get(k) ?? 99) > 40).sort();
  process.stdout.write(
    `\n${code} (${loc.name}) is missing ${missing.length} entries: short values ${short.length} / medium ${mid.length} / long sentences ${long.length}\n\n`,
  );
  const show = (title, list, n) => {
    process.stdout.write(`${title} (first ${Math.min(n, list.length)}):\n`);
    for (const k of list.slice(0, n)) process.stdout.write(`  ${k}  = ${(zhValueOf(k) ?? '').slice(0, 40)}\n`);
    process.stdout.write('\n');
  };
  show('Short values (priority: buttons/fields/status)', short, 120);
  show('Medium (panel titles/short hints)', mid, 60);
  show('Long sentences (hint text, the most expensive)', long, 10);
  process.exit(0);
}

if (update) {
  const out = { generatedAt: new Date().toISOString(), total, locales: Object.fromEntries(rows.map((r) => [r.code, r.covered])) };
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stdout.write(`\nbaseline written: ${path.relative(ROOT, BASELINE)}\n`);
  process.exit(0);
}

if (!baseline) {
  process.stdout.write('\nNo baseline yet - run node tools/locale-coverage.mjs --update to create one.\n');
  process.exit(0);
}

// Ratchet: coverage must not drop (a drop means features added later did not keep up with translation)
const regressions = [];
for (const r of rows) {
  const was = baseline.locales?.[r.code];
  if (was === undefined) continue;
  if (r.covered < was) regressions.push(`${r.code}: ${was} → ${r.covered}`);
}
if (regressions.length) {
  process.stdout.write('\ncoverage regressed:\n');
  for (const x of regressions) process.stdout.write('  - ' + x + '\n');
  process.stdout.write('\n(either add the missing entries, or confirm and run --update to refresh the baseline)\n');
  process.exit(1);
}
process.stdout.write('\ncoverage did not regress ✓\n');
