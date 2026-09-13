// workers/j/build.mjs — generate the J table module that `vmltext.ijs` needs,
// assemble the worker, and check that a J interpreter is reachable.
//
// J cannot parse JSON, so the two shared tables in workers/spec/ are compiled
// into J literals here, at build time, from the JSON files themselves. That is
// the same contract every other worker follows: nobody consults their own
// runtime's case tables. docs/WORKERS.md section 2 is the rule, and this file
// is where it is satisfied for J.
//
// The last stdout line is the generated table path, as section 6 of the
// contract expects of every build script.
//
// No machine path appears in this file: it looks for the interpreter on PATH
// and then at the location named by the environment variable VML_J, which the
// README documents. On a machine where jconsole is not on PATH (this one), the
// launcher belongs in the gitignored workers/registry.local.json — that is what
// the overlay is for, and a published file must not carry a local absolute path.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SPEC = path.join(ROOT, 'workers', 'spec');
const TABLES = path.join(HERE, 'tables.generated.ijs');
const WORKER = path.join(HERE, 'vmltext.ijs');

function fail(message) {
  process.stderr.write(`workers/j/build.mjs: ${message}\n`);
  process.exit(1);
}

function relative(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** Is `cmd` an executable on PATH (or an existing path)? Same rule as tools/workers.mjs. */
function resolveCommand(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) {
    return fs.existsSync(path.resolve(ROOT, cmd)) || fs.existsSync(cmd) ? cmd : null;
  }
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Is this really a J interpreter?
 *
 * The name `jconsole` is ALSO the name of the Java console tool, and on this
 * machine the JDK's jconsole is what PATH finds first: it is a GUI monitoring
 * tool, it accepts a file argument, and it does not run scripts at all. Asking
 * the candidate for its J version is the only reliable check, and it has to
 * happen before the harness is pointed at it.
 */
function isJConsole(cmd) {
  if (!cmd) return false;
  const res = spawnSync(cmd, ['-js', 'echo 9!:14' + "''"], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const out = `${res.stdout ?? ''}`.trim();
  return /^j[0-9]/.test(out);
}

function loadTable(file) {
  const filePath = path.join(SPEC, file);
  if (!fs.existsSync(filePath)) fail(`missing input table ${filePath}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    fail(`${filePath} is not valid JSON: ${e.message}`);
  }
  const entries = Object.entries(raw.map ?? {}).map(([k, v]) => [Number(k), v]);
  if (!entries.length) fail(`${filePath} has an empty "map"`);
  entries.sort((a, b) => a[0] - b[0]);
  return entries;
}

/**
 * A J numeric vector, on ONE line.
 *
 * This is not cosmetic. J has no line continuation inside a numeric literal:
 * a vector written as
 *
 *   1 2 3
 *   4 5 6
 *
 * is two sentences, and only the first is assigned — the rest become separate
 * statements. The generated table then contains the first 24 entries and J is
 * perfectly happy about it. Every vector here is emitted as a single line so
 * that what is generated is what gets defined. (It was not, and the fold table
 * silently had 24 of its 294 entries.)
 */
function numVector(values) {
  if (!values.length) return '(0 $ 0)';
  return values.join(' ');
}

/**
 * A fold-style table: each entry is a string of zero, one or two characters.
 * FOLD_VAL stays FLAT and FOLD_ROW says how many values each key owns, so a row
 * can be taken without rank games.
 */
function flattenFold(entries, file) {
  const keys = [];
  const values = [];
  const rows = [];
  for (const [cp, v] of entries) {
    const cps = [...v];
    if (cps.length > 2) {
      fail(`${file} maps U+${cp.toString(16).toUpperCase()} to ${JSON.stringify(v)}; the contract allows at most two code points`);
    }
    keys.push(cp);
    rows.push(cps.length);
    for (const c of cps) values.push(c.codePointAt(0));
  }
  return { keys, values, rows };
}

/**
 * The UTF-8 encoder as a table: one row per code point text.normalize can emit.
 *
 * That set is NOT the same as the two tables' keys: a Han character that step 1
 * and step 2 leave alone is emitted even though neither table mentions it, and
 * ASCII is emitted constantly. So the table holds every code point the mapping
 * step can produce (the "leave it alone" case included) plus every value either
 * table can produce, plus ASCII. Building it from the table VALUES alone — the
 * first attempt — produced an empty string for every CJK character, because the
 * encoder could not find the code point it was asked to encode.
 *
 * Columns: (code point ; byte count ; byte1 ; byte2 ; byte3 ; byte4 ; code point)
 */
function encodingTable(entries) {
  const set = new Set();
  for (let c = 0; c < 128; c += 1) set.add(c);
  for (const [cp] of entries) set.add(cp);
  for (const [, v] of entries) {
    for (const c of String(v)) set.add(c.codePointAt(0));
  }
  const cps = [...set].sort((a, b) => a - b);
  const cols = [[], [], [], []];
  const counts = [];
  for (const cp of cps) {
    const bytes = [...Buffer.from(String.fromCodePoint(cp), 'utf8')];
    counts.push(bytes.length);
    for (let i = 0; i < 4; i += 1) cols[i].push(bytes[i] ?? 0);
  }
  return { cps, cols, counts };
}

const lower = loadTable('latin-lower.json');
const fold = loadTable('latin-fold.json');

// The lower table's values are code points (numbers in the JSON); the fold
// table's are strings of zero, one or two characters. Both become code point
// vectors so the J side never decodes a string.
const lowerVals = lower.map(([cp, v]) => {
  if (typeof v === 'number') return v;
  const cps = [...String(v)];
  if (cps.length !== 1) {
    fail(`latin-lower.json maps U+${cp.toString(16).toUpperCase()} to ${JSON.stringify(v)}; the contract says one code point to one code point`);
  }
  return cps[0].codePointAt(0);
});
const foldFlat = flattenFold(fold, 'latin-fold.json');
const enc = encodingTable(lower);

const foldOffsets = [];
let acc = 0;
for (const n of foldFlat.rows) {
  foldOffsets.push(acc);
  acc += n;
}

const generated = `NB. tables.generated.ijs — GENERATED by workers/j/build.mjs; do not edit.
NB.
NB. Source tables: workers/spec/latin-lower.json, workers/spec/latin-fold.json
NB.
NB. Why compiled into J rather than read at run time: J cannot parse JSON, no
NB. addons are allowed, and docs/WORKERS.md section 2 requires every
NB. implementation to apply the SHARED tables instead of its runtime's own case
NB. handling. A lookup is a binary search over the ascending key vector plus a
NB. select from the value vector (fnd in the normalize part) — not a scan, so the
NB. cost does not grow with the table.
NB.
NB. Every vector is on ONE line on purpose: J has no line continuation inside a
NB. numeric literal, so a vector split over several lines is several sentences
NB. and only the first is assigned. See numVector in build.mjs.
NB.
NB. ${lower.length} lowercase entries, ${foldFlat.keys.length} fold entries.
NB.
NB. LOWER_TAB/LOWER_VAL: the case table as (ascending keys ; values).
NB. FOLD_TAB/FOLD_VAL/FOLD_ROW/FOLD_OFF: the fold table, FLAT, where key i owns
NB. FOLD_ROW[i] values starting at FOLD_OFF[i].
NB. ENC: the UTF-8 encoder as (code point ; byte count ; byte1..byte4 ; code
NB. point) — the four bytes are separate columns rather than one packed value,
NB. because unpacking a packed value depends on which end the packing put first
NB. and getting that wrong yields an empty string instead of an error.

LOWER_TAB =: ${numVector(lower.map(([cp]) => cp))}
LOWER_VAL =: ${numVector(lowerVals)}

FOLD_TAB =: ${numVector(foldFlat.keys)}
FOLD_VAL =: ${numVector(foldFlat.values)}
FOLD_ROW =: ${numVector(foldFlat.rows)}
FOLD_OFF =: ${numVector(foldOffsets)}

ENC =: ${numVector(enc.cps)} ,. ${numVector(enc.counts)} ,. ${numVector(enc.cols[0])} ,. ${numVector(enc.cols[1])} ,. ${numVector(enc.cols[2])} ,. ${numVector(enc.cols[3])} ,. ${numVector(enc.cps)}
`;

fs.writeFileSync(TABLES, generated, 'utf8');

// The worker is one file: jconsole runs a script path given on the command line,
// so the parts are concatenated in order rather than sourced. That also means
// there is no relative-path resolution at run time.
const PARTS = [
  ['src/core.ijs', 'byte and code point helpers, UTF-8 by hand'],
  ['src/json.ijs', 'the JSON encoder and decoder'],
  ['src/normalize.ijs', 'text.normalize'],
  ['src/extract.ijs', 'text.extract'],
  ['src/fingerprint.ijs', 'text.fingerprint'],
  ['src/protocol.ijs', 'the JSON-Lines protocol loop'],
  ['src/selfcheck.ijs', '--selfcheck'],
];

const header = `NB. =====================================================================
NB. vmltext.ijs — text.normalize / text.extract / text.fingerprint in J.
NB.
NB. A worker for the multilingual text layer described by docs/WORKERS.md.
NB. GENERATED by workers/j/build.mjs — do not edit; edit workers/j/src/.
NB.
NB. Build:  node workers/j/build.mjs
NB. Run:    <jconsole> workers/j/vmltext.ijs --capability text.normalize
NB.         <jconsole> workers/j/vmltext.ijs --selfcheck
NB.
NB. Assembled from these parts, in this order:
${PARTS.map(([f, what], i) => `NB.   ${i + 1}. ${f.padEnd(22)} ${what}`).join('\n')}
NB. =====================================================================
`;

const pieces = [header];
for (const [file] of PARTS) {
  const filePath = path.join(HERE, file);
  if (!fs.existsSync(filePath)) fail(`missing source part ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  pieces.push(`\nNB. ---- ${file} ${'-'.repeat(Math.max(0, 58 - file.length))}\n`);
  pieces.push(text.endsWith('\n') ? text : `${text}\n`);
}
pieces.splice(
  1,
  0,
  '\nNB. ---- tables.generated.ijs (generated above) --------------------------\n',
  fs.readFileSync(TABLES, 'utf8'),
);
pieces.push('\nNB. ---- entry point ---------------------------------------------------\nPMAIN 0\n');

fs.writeFileSync(WORKER, pieces.join(''), 'utf8');

// Is there a J interpreter to run this? Checked, not assumed — but checked
// WITHOUT naming a location on this machine. Four places, in order:
//   1. `jconsole` on PATH;
//   2. $VML_J;
//   3. the `j-text` launch command in workers/registry.local.json — the
//      gitignored machine-local overlay, which is where a launcher belongs;
//   4. workers/j/_jconsole.local — a gitignored one-line file with the path,
//      for a machine where J is installed portably. The leading underscore is
//      the repository's convention for worker scratch files
//      (workers/*/_* is in .gitignore), so this cannot be committed by accident.
const OVERLAY = path.join(ROOT, 'workers', 'registry.local.json');
let fromOverlay = null;
if (fs.existsSync(OVERLAY)) {
  try {
    const local = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
    const entry = (local.workers ?? []).find((w) => w.id === 'j-text');
    const cmd = entry?.launch?.[0];
    if (cmd) fromOverlay = resolveCommand(cmd);
  } catch {
    /* an unreadable overlay is not this script's problem */
  }
}
const POINTER = path.join(HERE, '_jconsole.local');
const fromPointer = fs.existsSync(POINTER)
  ? resolveCommand(fs.readFileSync(POINTER, 'utf8').trim())
  : null;
const onPath = resolveCommand('jconsole');
const fromEnv = process.env.VML_J ? resolveCommand(process.env.VML_J) : null;
const candidates = [
  ['$VML_J', fromEnv],
  ['PATH', onPath],
  ['registry.local.json', fromOverlay],
  ['_jconsole.local', fromPointer],
];
let interpreter = null;
let source = '';
for (const [label, cmd] of candidates) {
  if (cmd && isJConsole(cmd)) {
    interpreter = cmd;
    source = label;
    break;
  }
}
if (!interpreter) {
  const tried = candidates
    .filter(([, cmd]) => cmd)
    .map(([label, cmd]) => `${label}: ${cmd}`)
    .join('; ');
  fail(
    `no J interpreter found. Looked for \`jconsole\` on PATH, then set VML_J, then at the \`j-text\` ` +
      `launch command in workers/registry.local.json, then at workers/j/_jconsole.local` +
      `${tried ? ` (tried ${tried})` : ''}. ` +
      'Install J 9.x and put its bin directory on PATH, or set VML_J, or write the path into the ' +
      'gitignored workers/j/_jconsole.local, or add a j-text entry to the overlay (its shape is in ' +
      'workers/registry.local.example.json). Note that the JDK ships a different program called ' +
      'jconsole, which does not run J scripts. The tables and the worker were still generated.',
  );
}

process.stdout.write(`workers/j: generated ${relative(TABLES)}\n`);
process.stdout.write(`workers/j: assembled ${relative(WORKER)}\n`);
process.stdout.write(`workers/j: interpreter ${interpreter} (found via ${source})\n`);
process.stdout.write(`${relative(TABLES)}\n`);
