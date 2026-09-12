// i18n-hant.mjs — build-time Traditional Chinese variants
//
// Why not a runtime lookup table: a hand-written Simplified->Traditional table cannot tell "this character has the same
// form in both scripts" apart from "I simply missed this character", so it quietly produces an interface that mixes
// partial Traditional with partial Simplified (it really happened: two characters were missed, and a tab label ended up
// as a Simplified pair sitting among Traditional ones).
//
// So OpenCC's authoritative dictionaries are used instead, and the entire Simplified dictionary is converted at **build time**
// into three regional variants:
//   zh-Hant -> t    generic Traditional
//   zh-HK   -> hk   Hong Kong Traditional
//   zh-TW   -> twp  Taiwan standard (localised wording too: the Taiwan terms for software / network / information / preset / storage)
// The artifact is the static web/src/locales/generated.js — zero runtime dependency, zero conversion cost.
//
// Self-check (idempotence): convert the generated result once more with the same converter, and it must come out **completely unchanged**.
// That single rule catches every case of "the conversion was incomplete" — far more reliable than eyeballing several hundred characters.
//
//   node tools/i18n-hant.mjs          generate / refresh
//   node tools/i18n-hant.mjs --check  only verify it is up to date (for CI / before release; exits 1 when stale)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web', 'src', 'i18n.jsx');
const OUT = path.join(ROOT, 'web', 'src', 'locales', 'generated.js');

const VARIANTS = [
  { code: 'zh-Hant', to: 't', label: '繁體中文（通用）' },
  { code: 'zh-HK', to: 'hk', label: '香港繁體' },
  { code: 'zh-TW', to: 'twp', label: '臺灣正體' },
];

/** Pull the zh dictionary out of i18n.jsx (a plain object literal, so it can be evaluated safely) */
function readZhDict() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('  zh: {');
  const end = src.indexOf('  en: {');
  if (start < 0 || end < 0 || end < start) throw new Error('no zh/en dictionary block found in i18n.jsx');
  const block = src.slice(start, end).replace(/,\s*$/, '');
  const obj = new Function('return {' + block + '};')();
  if (!obj?.zh || typeof obj.zh !== 'object') throw new Error('failed to parse the zh dictionary');
  return obj.zh;
}

/**
 * Reviewed "same form in both scripts / one-to-many" characters — a per-character check reports them as false positives,
 * but they were confirmed by hand.
 *
 * Why review them all in one go: at the character level there is no way to tell whether U+91CC is a legitimate
 * Traditional form (as in "kilometer", or the name "Mario") or a Simplified character the conversion missed —
 * both readings are legal. So the tool lists every suspicious character **in full** first, a human looks through them,
 * and the reviewed ones go into this table, which acts as a ratchet: from then on a newly appearing character fails
 * the build and forces one more review.
 */
// U+91CC ("li", inside / kilometer): same form in both scripts, and OpenCC conservatively refuses to convert it — reviewed, no conversion needed.
// U+6E38 ("you", to swim / to wander): same reasoning. "upstream" is written with this same form in Traditional too (the "you" of "to play / to wander" is a different character), so no conversion is needed here either.
const REVIEWED_SAME_FORM = new Set('里游');

/**
 * Phrase-level corrections: the individual cases where OpenCC's **word**-level dictionary cannot decide, while the
 * context is unambiguous.
 *
 * Example: the two-character word "tian hou" is a real word in Traditional Chinese (the goddess Tin Hau / Mazu),
 * so OpenCC will not turn "3 tian hou" (3 days later) into its Traditional form — it is not wrong, our own baseline
 * copy is ambiguous. Our usage is always "N days later", so it is corrected explicitly here.
 *
 * Note: this **adds** a correction rather than papering over a missed character — after the fix the generated output
 * contains no suspicious character any more, and the per-character review still keeps an eye on anything that newly appears.
 */
const PHRASE_FIXES = [[/天后/g, '天後']];

function applyPhraseFixes(s) {
  let out = s;
  for (const [re, to] of PHRASE_FIXES) out = out.replace(re, to);
  return out;
}

/** Structural check: the conversion must not touch ASCII, digits, placeholders or punctuation — if it does, the converter is at fault */
const STRICT_STRUCTURAL = /[\x00-\x7F]/g;

function main() {
  const check = process.argv.includes('--check');
  const zh = readZhDict();
  const keys = Object.keys(zh);
  const problems = [];
  const suspects = new Map();
  const dicts = {};

  for (const v of VARIANTS) {
    const conv = OpenCC.Converter({ from: 'cn', to: v.to });
    const out = {};
    let changed = 0;
    for (const k of keys) {
      const val = zh[k];
      if (typeof val !== 'string') {
        out[k] = val;
        continue;
      }
      const t = applyPhraseFixes(conv(val));
      if (t !== val) changed++;

      // (1) The structure must not be broken: ASCII / digits / placeholders have to survive verbatim
      const a = val.match(STRICT_STRUCTURAL)?.join('') ?? '';
      const b = t.match(STRICT_STRUCTURAL)?.join('') ?? '';
      if (a !== b) {
        problems.push(`${v.code} broke non-Chinese characters: ${k}\n  source: ${val}\n  converted: ${t}`);
      }

      // (2) Suspicious characters (possibly a Simplified character that was missed) — collect them for manual review
      for (const ch of t) {
        if (/[\u3400-\u9fff]/.test(ch) && conv(ch) !== ch) {
          if (!REVIEWED_SAME_FORM.has(ch)) suspects.set(ch, `${k} = ${t}`);
        }
      }
      out[k] = t;
    }
    dicts[v.code] = out;
    const pct = Math.round((changed / keys.length) * 100);
    process.stdout.write(`  ${v.code.padEnd(8)} ${v.label.padEnd(18)} ${changed}/${keys.length} keys differ (${pct}%)\n`);
    // Sanity gate: when the dictionary failed to load, the difference rate comes out abnormally low
    if (pct < 40) problems.push(`${v.code} differs by only ${pct}% — the OpenCC dictionary may not have loaded`);
  }

  if (suspects.size) {
    process.stdout.write(`\n${suspects.size} character(s) awaiting review (single-character conversion changes them, but they may be legitimate same-form Traditional characters):\n`);
    for (const [ch, where] of suspects) process.stdout.write(`  ${ch}  ← ${where}\n`);
    problems.push(
      `${suspects.size} character(s) need manual review: ${[...suspects.keys()].join(' ')} (add them to REVIEWED_SAME_FORM once confirmed)`,
    );
  }

  if (problems.length) {
    process.stderr.write('\nconversion self-check failed:\n');
    for (const p of problems.slice(0, 10)) process.stderr.write('  - ' + p + '\n');
    if (problems.length > 10) process.stderr.write(`  …and ${problems.length - 10} more\n`);
    process.exit(1);
  }

  const header = [
    '// 本文件由 tools/i18n-hant.mjs 生成，请勿手改 / GENERATED — do not edit by hand.',
    '// 数据来源：OpenCC 词典（构建期转换），因此不存在「漏字导致简繁混排」的问题。',
    '// 重新生成：node tools/i18n-hant.mjs',
    `// 生成时间：${new Date().toISOString()}`,
    '',
  ].join('\n');
  const body =
    header +
    'export const GENERATED = ' +
    JSON.stringify(dicts, null, 2) +
    ';\n\nexport default GENERATED;\n';

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // The timestamp would make every comparison unequal: ignore it while comparing
  const strip = (s) => s.replace(/^\/\/ 生成时间：.*$/m, '');
  if (strip(prev) === strip(body)) {
    process.stdout.write('\nup to date: ' + path.relative(ROOT, OUT) + '\n');
    return;
  }
  if (check) {
    process.stderr.write('\ngenerated.js is stale — run: node tools/i18n-hant.mjs\n');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
  process.stdout.write(`\nwritten: ${path.relative(ROOT, OUT)} (${kb} KB, ${VARIANTS.length} variants × ${keys.length} keys)\n`);
}

main();
