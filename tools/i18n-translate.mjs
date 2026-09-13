// i18n-translate.mjs — machine-translation pipeline for UI strings
//
// The mechanism follows MTool (that toolkit has already stepped in every pitfall of "batch-translating UI
// text"), taking its five most important points:
//
//   1) **Multiple engines**: the engine is pluggable (a local mock / any OpenAI-compatible endpoint),
//      and swapping it does not change the pipeline. With no configuration it refuses to run outright
//      rather than calling out with an empty key.
//   2) **Hashed cache by "source string + target language"**: the same sentence never costs money twice;
//      an edited source string is naturally a new key, and the old translation stays in the cache without
//      polluting anything. The cache is reusable and committable (it holds no keys).
//   3) **Glossary**: person names and product words must be pinned (one glossary key must not be
//      translated as "Intel" in one place and "Info" in another).
//      The method is to replace the term with a sentinel before translating and restore it afterwards -- 
//      that way the model never gets a chance to change it.
//   4) **Placeholder protection**: `{target}`, `${x}`, `%s`, newlines and shapes like `MM-DD` must survive verbatim.
//      After translating it **verifies that every sentinel was restored**; one missing means that entry
//      failed, and a value the model broke is never written.
//   5) **Incremental, and one failed entry does not take the batch down**: only missing keys are translated;
//      failures are accounted for separately and retried next time.
//
// One deliberate difference from MTool: **machine translations are a separate layer and never override human entries**.
// The layer order is in web/src/i18n.jsx: human (HAND/COMMON) -> build-time generated (Traditional) -> machine -> English fallback.
// That way "the machine went over it once" cannot overwrite anything a human proofread.
//
//   node tools/i18n-translate.mjs --engine mock --locales ja-JP,ko-KR --limit 20
//   node tools/i18n-translate.mjs --engine openai --locales ja-JP --dry-run
//   node tools/i18n-translate.mjs --review ja-JP         # list machine translations for human review
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, readDicts, usedKeys } from './lib/i18n-source.mjs';
import { inheritableAncestors } from './lib/locale-chain.mjs';
import { byCode, LOCALES } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';

const CACHE_DIR_DEFAULT = path.join(ROOT, 'web/src/locales/.cache');
const OUT_FILE_DEFAULT = path.join(ROOT, 'web/src/locales/machine.json');
const GLOSSARY_FILE = path.join(ROOT, 'web/src/locales/glossary.json');

const args = {
  engine: 'mock',
  locales: [],
  keys: [],
  limit: 0,
  dryRun: false,
  review: null,
  concurrency: 2,
  batch: 8,
  url: '',
  key: '',
  model: '',
  retry: 1,
  bust: 'none',
  // Sandbox: point the cache and the output somewhere else. The self-test uses it to keep runs from
  // interfering (otherwise an assertion like "the first run should newly translate N entries" would be
  // defeated by a real cache hit); when run by hand it is also handy for "try another model once
  // without polluting the real cache".
  cacheDir: '',
  out: '',
  // Behaviour switches of the fake engine (only read when --engine mock): echo = return the source
  // verbatim, used to test "invalid means do not write"
  mockMode: '',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--engine') args.engine = process.argv[++i];
  else if (a === '--locales') args.locales = String(process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Fix only a few keys: when proofreading finds "this one key is broken in ten languages", there is no
  // need to re-run the whole book
  else if (a === '--keys') args.keys = String(process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--batch') args.batch = Number(process.argv[++i]);
  else if (a === '--concurrency') args.concurrency = Number(process.argv[++i]);
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--bust') args.bust = String(process.argv[++i] ?? 'terms');
  else if (a === '--cache-dir') args.cacheDir = path.resolve(process.argv[++i]);
  else if (a === '--out') args.out = path.resolve(process.argv[++i]);
  else if (a === '--mock-mode') args.mockMode = String(process.argv[++i] ?? '');
  else if (a === '--review') args.review = process.argv[++i];
  else if (a === '--url') args.url = process.argv[++i];
  else if (a === '--key') args.key = process.argv[++i];
  else if (a === '--model') args.model = process.argv[++i];
}

const log = (s) => process.stdout.write(s + '\n');

// ───────────────────────────────────────────── cache

function cachePath(locale) {
  return path.join(args.cacheDir || CACHE_DIR_DEFAULT, `${locale}.json`);
}

export function loadCache(locale) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(locale), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* start empty when there is none */
  }
  return {};
}

export function saveCache(locale, cache) {
  const dir = args.cacheDir || CACHE_DIR_DEFAULT;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

/** Cache key: source string + target language (a different language naturally re-translates, and an edited source string is a new key) */
export function cacheKey(text, locale) {
  return crypto.createHash('sha256').update(`${locale}\u0000${text}`).digest('hex').slice(0, 20);
}

// ───────────────────────────────────────────── glossary and placeholders

export function loadGlossary() {
  try {
    const raw = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* it can run without a glossary */
  }
  return {};
}

/**
 * Replace everything that must be preserved with sentinels.
 * Returns { text, tokens } -- tokens are used to restore and **verify** after translating.
 */
export function protect(text, glossary = {}, locale = '') {
  const tokens = [];
  let out = String(text);
  const push = (value, kind) => {
    const i = tokens.length;
    tokens.push({ value, kind });
    return `⟦${i}⟧`;
  };
  // Glossary: replace each whole term occurring in the source string (longest first, so a short term does not cut a longer one apart)
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (!out.includes(term)) continue;
    const target = glossary[term]?.[locale] ?? glossary[term]?.default ?? term;
    // Do the global replacement with split/join (avoiding regex-escaping problems)
    out = out.split(term).join(push(target, 'term'));
  }
  // Placeholder kinds: {} / ${} / %s / %d / newline / date and number shapes
  out = out.replace(/\$\{[^}]+\}/g, (m) => push(m, 'tpl'));
  out = out.replace(/\{[^}]+\}/g, (m) => push(m, 'brace'));
  out = out.replace(/%[sdif]/g, (m) => push(m, 'printf'));
  out = out.replace(/\\n/g, (m) => push(m, 'newline'));
  out = out.replace(/\b\d{2}-\d{2}\b/g, (m) => push(m, 'date'));
  out = out.replace(/\bYYYY-MM-DD\b/g, (m) => push(m, 'datefmt'));
  return { text: out, tokens };
}

/** Restore the sentinels. Missing any one -> ok:false (rather write nothing than a value the model broke) */
export function restore(text, tokens) {
  let out = String(text ?? '');
  const missing = [];
  for (let i = 0; i < tokens.length; i++) {
    const marker = `⟦${i}⟧`;
    // Tolerate the model turning the square brackets into round ones, or adding spaces
    const loose = new RegExp(`[⟦\\[（(]\\s*${i}\\s*[⟧\\]）)]`);
    if (out.includes(marker)) out = out.split(marker).join(tokens[i].value);
    else if (loose.test(out)) out = out.replace(loose, tokens[i].value);
    else missing.push(i);
  }
  return { ok: missing.length === 0, text: out, missing };
}

/**
 * Does this translation look like it was **not translated at all**?
 *
 * Why this is needed: coverage only counts "is there a value", so "the value is the Chinese source"
 * also counts as 100% -- the metric would be hollow.
 * The criterion: Han characters appear in a target language that is neither Chinese nor Japanese (words
 * the glossary deliberately keeps in the source form are stripped first).
 * Japanese is the exception (Han characters are normal writing there).
 *
 * Kept words must be stripped **longest first**: when the glossary holds both "Jia Ran" and
 * "Jia Ran's What to Eat Today", stripping the short one first chops the long one into "What to Eat Today",
 * manufacturing a pile of false "untranslated" reports.
 */
export function looksUntranslated(text, locale, glossary = {}) {
  if (!text || String(locale).startsWith('ja')) return false;
  const keep = Object.keys(glossary)
    .filter((k) => !k.startsWith('_') && glossary[k]?.default === k)
    .sort((a, b) => b.length - a.length);
  let s = String(text);
  for (const t of keep) s = s.split(t).join('');
  return /[\u4e00-\u9fff]/.test(s);
}

/**
 * Is there a **sentinel left unrestored** in the translation?
 *
 * This is a real incident: the source string for "days later" held no placeholder at all (tokens was empty), yet
 * the model wrote a ⟦0⟧ of its own (it had seen that thing in the prompt), and restore() only checked
 * "did an emitted sentinel go missing", never "did extra sentinels appear in the translation" -- so
 * "daqui a ⟦0⟧ dias" was written into the Portuguese UI that way, and four languages were hit.
 * The criterion: any sentinel in the translation is disallowed (after restoring there should be none).
 *
 * BUGS #64: this used to match digits only, so a sentinel carrying a *name* slipped through both this
 * gate and the proofreading tool — `machine.json` shipped `ar-SA outsideRange` = "تم استبعاد ⟦n⟧ عنصرًا…",
 * i.e. Arabic users literally saw ⟦n⟧. A named sentinel is exactly as broken as a numbered one, so both
 * this and tools/i18n-proofread.mjs now match any ⟦…⟧ shape.
 */
export function hasStraySentinel(text) {
  return /⟦[^⟧]*⟧/.test(String(text ?? ''));
}

/** The single criterion for "this translation is broken": not finished (Han characters left) or a stray sentinel */
export function looksBroken(text, locale, glossary = {}) {
  return hasStraySentinel(text) || looksUntranslated(text, locale, glossary);
}

/**
 * Cache invalidation strategy.
 *
 * Why this is needed: the cache key is "source string + language", so **changing the prompt or the
 * glossary still hits the old translations** -- the proper-noun policy changed and the old entries
 * cannot be pulled back, leaving you staring at them helplessly. Four modes:
 *   none       normal cache use (default)
 *   terms      re-translate only entries whose **source string contains a proper noun** (a word from the
 *              glossary, or a Latin fragment with capitals)
 *   suspicious re-translate only entries that "look untranslated" (Han characters left in the translation) -- used to fix machine-translation misses
 *   all        re-translate everything (only when the model changed or the whole approach is wrong; it costs the money again)
 */
export function needsRetranslate(sourceText, mode, glossary = {}, existing = null, locale = '') {
  if (mode === 'all') return true;
  // Broken translations (unfinished / stray sentinel) are always re-translated -- both are the classic "has a value but is unusable"
  if (mode === 'suspicious') return looksBroken(existing, locale, glossary);
  if (mode !== 'terms') return false;
  for (const term of Object.keys(glossary)) if (String(sourceText).includes(term)) return true;
  // A Latin fragment that "looks like a brand name": at least 2 consecutive characters including a capital (Telegram / SQLite / X)
  return /\b[A-Z][A-Za-z0-9.+#-]{1,}\b/.test(String(sourceText));
}

// ───────────────────────────────────────────── engines

async function translateBatchOpenAI({ texts, locale, target }, provider = {}, { task = 'translate' } = {}) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  // "Finishing off a half-done translation" is a call with a **different task**: the input is not the
  // Chinese source but the previous output with "Chinese and English/Korean mixed together". This point
  // is crucial -- the temperature is 0, so as long as the input and the prompt are unchanged the model
  // hands back the same broken translation again (hit before: 6 ko-KR entries returned verbatim three times in a row).
  const finishing = task === 'finish';
  const body = {
    model: provider.model || args.model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [
          finishing
            ? `These UI strings were supposed to be in ${target} (${locale}) but are still partly in the source language. Rewrite each one completely in ${target}.`
            : `You translate UI strings for a desktop app into ${target} (${locale}).`,
          'Output JSON only: {"t":["...","..."]} with exactly ' + texts.length + ' items, same order. Keep it short like a UI label.',
          'Never translate ⟦n⟧ placeholders — copy them exactly.',
          // Proper-noun policy (set by the user): prefer keeping the original form; replace only where the target language has an established local name.
          // This has to go into the prompt -- the glossary only covers the words listed in it, and anything it does not cover relies on the model policing itself.
          'PROPER NOUNS: keep person names, group names, brand names, product names and service names in their original form.',
          'Only replace a proper noun when the target language has a widely established local name for it (e.g. YouTube→유튜브 in Korean, Telegram→Телеграм in Russian, hololive→ホロライブ in Japanese).',
          'If unsure, keep the original — never invent a transliteration.',
          ...(finishing
            ? [
                'Translate every single word. Chinese characters in the output are a hard failure, unless they are part of a proper noun you are told to keep.',
                'Do not just copy the input: it is a rejected draft.',
              ]
            : []),
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ t: texts }) },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
  const m = /\{[\s\S]*\}/.exec(content);
  const arr = m ? JSON.parse(m[0])?.t : null;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error(`返回条数不对（期望 ${texts.length}）`);
  return arr.map((s) => String(s ?? ''));
}

async function translateBatchMock({ texts, locale }) {
  // Fake engine: a deterministic "translation", only to exercise the pipeline (real translation needs --engine openai)
  const marker = { 'ja-JP': '【JA】', 'ko-KR': '【KO】', 'de-DE': '【DE】' }[locale] ?? `【${locale}】`;
  await new Promise((r) => setTimeout(r, 5));
  // --mock-mode echo: simulates the bad behaviour of "the model echoes the source", to verify
  // end-to-end that "retranslate -> still invalid -> do not write".
  if (args.mockMode === 'echo') return texts.map((s) => String(s));
  // --mock-mode sentinel: simulates "the model invents a sentinel out of thin air" (real incident: "daqui a ⟦0⟧ dias" appeared in the Portuguese UI)
  if (args.mockMode === 'sentinel') return texts.map((s) => marker + String(s).replace(/[\u4e00-\u9fff]/g, '~') + ' ⟦0⟧');
  // The normal fake engine strips Han characters: a fake translation should also "look translated",
  // otherwise the 25-language inspection gets stuck on its own fake data
  return texts.map((s) => marker + String(s).replace(/[\u4e00-\u9fff]/g, '~'));
}

async function translateBatch({ texts, locale, target }, opts = {}) {
  if (args.engine === 'mock') return translateBatchMock({ texts, locale });
  if (args.engine === 'app' || args.engine === 'openai') {
    const p = args.engine === 'app' ? providerFromApp() : { baseUrl: args.url, apiKey: args.key, model: args.model };
    if (!p?.baseUrl || !p?.apiKey) throw new Error('没有可用的模型档位（界面里配好，或显式给 --url/--key）');
    return translateBatchOpenAI({ texts, locale, target }, p, opts);
  }
  throw new Error(`未知引擎: ${args.engine}`);
}

/**
 * Read the model tier from the **local application config**.
 *
 * Why this engine exists: passing the key with `--key` would put it into the command line and the shell
 * history -- a translation script that "types the key into the command line" is a hazard in itself.
 * Going through this engine keeps the key in this process's memory only, and uses the tier you already
 * configured in the UI (the packaged build wins, then the dev tree's config.json).
 */
function providerFromApp() {
  const candidates = [
    path.join(ROOT, 'dist/VtuberMonitorLink/app/config.json'),
    path.join(ROOT, 'config.json'),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = cfg?.llm?.providers ?? [];
      const active = list.find((x) => x.id === cfg.llm.activeId) ?? list[0];
      if (active?.apiKey) return { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model, name: active.name };
      if (cfg?.llm?.apiKey) return { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, model: cfg.llm.model, name: '默认' };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ───────────────────────────────────────────── main flow

/** The keys "already written by a human" for this language (the machine layer may not override them) */
export function humanKeys(locale) {
  const keys = new Set();
  // Itself plus its **same-language ancestors** (es-MX inherits es-419/es-ES, zh-TW inherits zh-Hant/zh-Hans).
  // Sibling regions do not count: pt-PT's chain does not contain pt-BR and it cannot inherit at runtime,
  // so treating pt-BR's entries as "already human" would only mean pt-PT never gets a machine translation
  // (the gap gets reported by the tools as 100% coverage).
  for (const c of [locale, ...inheritableAncestors(locale)]) {
    for (const layer of [HAND_COMMON[c], HAND[c]]) {
      if (layer) for (const k of Object.keys(layer)) keys.add(k);
    }
  }
  return keys;
}

function readMachine() {
  try {
    const raw = JSON.parse(fs.readFileSync(args.out || OUT_FILE_DEFAULT, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* start empty when there is none */
  }
  return {};
}

/**
 * Prune before writing: clear the entries in the machine layer that would **never be displayed**.
 *
 * Which two kinds: (1) keys the human layer already wrote (human beats machine, so the machine entry is
 * dead); (2) keys whose Simplified Chinese source is character-for-character identical to the English
 * (every language uses the same string, so no translation is needed).
 * What happens without pruning: machine.json piles up invisible old translations, and the ones holding
 * Han characters get caught by the "suspected untranslated" statistics -- turning into a chore of fixing
 * a broken translation for something that does not exist in the UI at all.
 */
export function pruneMachine(machine, { zh, en } = {}) {
  const removed = [];
  for (const [code, dict] of Object.entries(machine)) {
    if (!dict || typeof dict !== 'object') continue;
    const shadowed = humanKeys(code);
    for (const key of Object.keys(dict)) {
      const neutral = zh && en ? isLanguageNeutral(zh.get(key), en.get(key)) : false;
      if (!neutral && !shadowed.has(key)) continue;
      removed.push(`${code}.${key}`);
      delete dict[key];
    }
  }
  return removed;
}

function writeMachine(all) {
  fs.writeFileSync(args.out || OUT_FILE_DEFAULT, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/**
 * This one does not need translating at all: the Simplified Chinese source and the English are **character-for-character
 * identical** (brand names and abbreviations such as LLM / API Key).
 * The criterion comes from the source itself (zh value === en value); no separate exemption list -- a list would drift.
 */
export function isLanguageNeutral(zhValue, enValue) {
  return !!zhValue && zhValue === enValue;
}

async function main() {
  const { zh, en } = readDicts();
  const used = usedKeys();
  const glossary = loadGlossary();

  if (args.review) {
    const machine = readMachine();
    const dict = machine[args.review] ?? {};
    const keys = Object.keys(dict);
    log(`\n${args.review}: ${keys.length} machine translations\n`);
    for (const k of keys.slice(0, 60)) log(`  ${k}\n    zh: ${zh.get(k) ?? ''}\n    mt: ${dict[k]}\n`);
    if (keys.length > 60) log(`  ...and ${keys.length - 60} more`);
    return;
  }

  if (!args.locales.length) {
    log('usage: node tools/i18n-translate.mjs --engine mock|openai --locales ja-JP,ko-KR [--limit N] [--dry-run]');
    log('       node tools/i18n-translate.mjs --review ja-JP');
    process.exit(2);
  }
  if (args.engine === 'openai' && (!args.url || !args.key)) {
    log('the openai engine needs --url and --key (or configure the tier in the UI first; this is only the script entry point)');
    process.exit(2);
  }

  const machine = readMachine();
  let grand = { translated: 0, cached: 0, failed: 0, skippedHuman: 0 };

  for (const locale of args.locales) {
    const loc = byCode(locale);
    if (!loc) {
      log(`  ! unknown locale code ${locale}, skipped`);
      continue;
    }
    const human = humanKeys(locale);
    const cache = loadCache(locale);
    const todo = [];
    let skippedHuman = 0;
    let skippedNeutral = 0;
    for (const key of used) {
      if (args.keys.length && !args.keys.includes(key)) continue;
      if (human.has(key)) {
        skippedHuman++;
        continue;
      }
      const value = zh.get(key);
      if (!value) continue;
      if (isLanguageNeutral(value, en.get(key))) {
        skippedNeutral++;
        continue;
      }
      const ck = cacheKey(value, locale);
      const existing = cache[ck];
      if (existing && !needsRetranslate(value, args.bust, glossary, existing, locale)) {
        grand.cached++;
        machine[locale] ??= {};
        machine[locale][key] = existing;
        continue;
      }
      todo.push({ key, value, ck });
    }
    const batchSize = Math.max(1, args.batch);
    const queue = args.limit > 0 ? todo.slice(0, args.limit) : todo;
    log(`\n${locale} (${loc.name}): human entries ${human.size} (skipped ${skippedHuman}) · source = English so no translation needed ${skippedNeutral} · to translate ${todo.length} · handling now ${queue.length} · cache hits ${grand.cached}`);

    if (args.dryRun) {
      for (const t of queue.slice(0, 10)) log(`  [dry-run] ${t.key} = ${t.value.slice(0, 40)}`);
      continue;
    }

    let translated = 0;
    let failed = 0;
    const batches = [];
    for (let i = 0; i < queue.length; i += batchSize) batches.push(queue.slice(i, i + batchSize));

    let idx = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(args.concurrency, batches.length || 1)) }, async () => {
      while (true) {
        const b = batches[idx++];
        if (!b) return;
        // Full flow: terminology and placeholder protection -> translate -> restore and verify
        const prepared = b.map((x) => protect(x.value, glossary, locale));
        let out = null;
        for (let attempt = 0; attempt <= args.retry; attempt++) {
          try {
            out = await translateBatch({ texts: prepared.map((p) => p.text), locale, target: loc.name });
            break;
          } catch (e) {
            if (attempt === args.retry) {
              failed += b.length;
              log(`  ✕ batch failed (${b.length} entries): ${e.message}`);
            }
          }
        }
        if (!out) continue;

        // First pass result: restore and verify the placeholders
        const draft = b.map((_, i) => {
          const restored = restore(out[i], prepared[i].tokens);
          return restored.ok ? { ok: true, text: restored.text } : { ok: false, missing: restored.missing };
        });

        // Second pass (only for the entries that "look broken"): feed those half-finished results back in as the input.
        // Why not resend the source: the temperature is 0, so with the input and prompt unchanged the model hands the same broken translation back.
        const leftover = draft.map((d, i) => (d.ok && looksBroken(d.text, locale, glossary) ? i : -1)).filter((i) => i >= 0);
        if (leftover.length) {
          const again = leftover.map((i) => protect(draft[i].text, glossary, locale));
          let out2 = null;
          try {
            out2 = await translateBatch({ texts: again.map((p) => p.text), locale, target: loc.name }, { task: 'finish' });
          } catch (e) {
            log(`  ! retranslation batch failed (${leftover.length} entries): ${e.message}`);
          }
          if (out2) {
            leftover.forEach((slot, k) => {
              const r = restore(out2[k], again[k].tokens);
              if (r.ok) draft[slot] = { ok: true, text: r.text, refinished: true };
            });
          }
        }

        for (let i = 0; i < b.length; i++) {
          const d = draft[i];
          if (!d.ok) {
            // A lost sentinel -> this entry is not written (better missing than broken), and it is accounted for so it retries next time
            failed++;
            log(`  ✕ ${b[i].key}: missing placeholders ${d.missing.join(',')}, discarded`);
            continue;
          }
          if (looksBroken(d.text, locale, glossary)) {
            // **Still** invalid after retranslation -> not written into the machine layer.
            // What writing it would cost: a whole Chinese sentence showing up in the Korean UI (this really happened),
            // "daqui a ⟦0⟧ dias" showing up in the Portuguese UI (a stray sentinel, this really happened too),
            // and because it "has a value" the coverage would still report 100%. Not writing it falls back to English.
            failed++;
            const prev = machine[locale]?.[b[i].key];
            const why = hasStraySentinel(d.text) ? 'stray sentinel' : 'still the source text';
            if (looksBroken(prev, locale, glossary)) {
              // The old value is broken too -> clear it as well, otherwise "better missing than broken" is just a slogan:
              // the broken value stays in machine.json and the UI still shows that Chinese sentence / that ⟦0⟧.
              // (When the old value is good, never touch it -- do not delete a translation just because the model has a bad day.)
              delete machine[locale][b[i].key];
              log(`  ✕ ${b[i].key}: retranslation ${why}, removed from the machine layer (UI falls back to English, retry next run)`);
            } else {
              log(`  ✕ ${b[i].key}: retranslation ${why}, not written (kept the existing translation, UI falls back to English, retry next run)`);
            }
            continue;
          }
          cache[b[i].ck] = d.text;
          machine[locale] ??= {};
          machine[locale][b[i].key] = d.text;
          translated++;
        }
      }
    });
    await Promise.all(runners);
    saveCache(locale, cache);
    // Each language is written to disk as soon as it finishes: one run over 7000 entries takes several
    // minutes, and a mid-run error should not throw away work that has already been paid for.
    // (The cache is also stored per language and a re-run hits it automatically, so this only affects machine.json.)
    writeMachine(machine);
    log(`  ✓ translated ${translated} · failed ${failed}`);
    grand.translated += translated;
    grand.failed += failed;
    grand.skippedHuman += skippedHuman;
  }

  if (!args.dryRun) {
    const pruned = pruneMachine(machine, { zh, en });
    writeMachine(machine);
    log(`\nwrote ${path.relative(ROOT, args.out || OUT_FILE_DEFAULT)}`);
    if (pruned.length) log(`pruned ${pruned.length} machine entries that would never be displayed (already in the human layer / source is already English)`);
    log('the machine layer has the **lowest priority** (human entries always override it); after changing it run npm run i18n:coverage to see the effect.');
  }
  log(`\nTotal: translated ${grand.translated} · cache hits ${grand.cached} · failed ${grand.failed}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('i18n-translate.mjs')) {
  main().catch((e) => {
    process.stderr.write('translation pipeline error: ' + (e?.stack ?? e) + '\n');
    process.exit(1);
  });
}
