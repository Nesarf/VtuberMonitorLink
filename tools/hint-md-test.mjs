// hint-md-test.mjs — regression guard: **copy carrying markdown markers must appear where markdown is rendered**
//
// Origin (BUGS #52, and its recurrence as #61): a hint was written with `**bold**` while the render site was the plain-text
// `{t('key')}`, so what the user saw was two literal asterisks. Nothing errors, nothing goes blank, and the inspection run
// still passes — the classic "the value is there but it looks wrong".
// For #52 the six offending sites were switched to <Inline>; in #61 I stepped into the same hole again with a freshly written
// `vdbHint`, and the proofreading tool caught it by treating placeholder/marker parity (zh has `**`, en does not) as a **hard failure**.
//
// So this turns that into a rule that can be run automatically instead of relying on memory:
//   1. pull the keys whose **value itself carries markdown markers** (`**` / backticks / `[text](link)`) out of the i18n source;
//   2. find every `t('that key')` call site in the UI;
//   3. the line of each call site must also contain `<Inline` (or the file must contain a form like `<Inline text={t('that key')}`),
//      otherwise it fails.
//
// This is an **offline** assertion: it only reads the source text under web/src; no server, no network.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readDicts } from './lib/i18n-source.mjs';

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    process.stdout.write(`  [ok]   ${name}${detail ? ' — ' + detail : ''}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}\n`);
  }
}

// ── collect the UI source ─────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (['.js', '.jsx'].includes(path.extname(e.name))) {
      files.push(path.join(dir, e.name));
    }
  }
})(path.join(ROOT, 'web/src'));

const MARKDOWN = /\*\*|`|\[[^\]\n]+\]\([^)\n]*\)/;

const { zh, en } = readDicts();
const marked = [...zh.entries()].filter(([, v]) => v && MARKDOWN.test(v));
check(
  'keys whose value carries markdown markers were found (only a non-zero count means the scan really ran)',
  marked.length > 0,
  `${marked.length} keys: ${marked.map(([k]) => k).join(', ')}`,
);

// Markers must come in pairs: a lone `**` is definitely a typo
for (const [key, value] of marked) {
  const stars = (value.match(/\*\*/g) ?? []).length;
  if (stars % 2 !== 0) check(`the ** markers in ${key} are paired up`, false, `${stars} of them`);
}

// ── every call site has to sit inside Inline ──────────────────────────────
let sites = 0;
const offenders = [];
for (const [key, value] of marked) {
  const needle = new RegExp(`\\bt\\(\\s*'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*\\)`);
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!needle.test(line)) return;
      sites++;
      if (line.includes('Inline')) return; // the same line already has <Inline text={t('key')} />
      offenders.push(`${rel}:${i + 1} ${key} → ${line.trim().slice(0, 70)}`);
    });
  }
}
check('call sites were really found (otherwise this assertion never runs)', sites > 0, `${sites} site(s)`);
check(
  'all copy carrying markdown markers is rendered inside <Inline>',
  offenders.length === 0,
  offenders.length ? `bare in ${offenders.length} place(s):\n         ` + offenders.join('\n         ') : `all ${sites} are inside Inline`,
);

// ── the reverse direction: markers must not appear where the text renders as plain text (blocks the #61 shape head-on) ─────
const plainSites = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/.exec(line);
    if (!m || line.includes('Inline')) return;
    const value = zh.get(m[1]);
    if (value && MARKDOWN.test(value)) plainSites.push(`${rel}:${i + 1} ${m[1]}`);
  });
}
check(
  'no marked-up copy among the t() call sites that render as plain text',
  plainSites.length === 0,
  plainSites.length ? plainSites.join(', ') : 'clean',
);

// ── neighbor consistency: en markers must match zh markers (the proofreading tool judges by placeholders, this judges by markdown) ──
const mismatched = [];
for (const [key, value] of marked) {
  const e = en.get(key);
  if (e === undefined) continue; // a missing translation is the coverage tool's business
  const zHas = MARKDOWN.test(value);
  const eHas = MARKDOWN.test(e);
  if (zHas !== eHas) mismatched.push(key);
}
check(
  'zh and en markdown markers match (this is exactly where #61 was unbalanced)',
  mismatched.length === 0,
  mismatched.length ? mismatched.join(', ') : 'consistent',
);

process.stdout.write(`\n${pass}/${pass + failures.length} checks passed\n`);
if (failures.length) {
  process.stdout.write(`failed:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
