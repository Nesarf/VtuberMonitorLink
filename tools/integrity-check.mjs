// integrity-check.mjs — project integrity check / project integrity check
//
// Why an "integrity" check is needed instead of just running a syntax check:
//   · `node --check` only validates syntax; it **cannot see a nonexistent identifier, nor a misspelled import path**
//     (this project really hit it: `saveConfig` did not exist at all, syntax checks were all green, and the first API call returned 500)
//   · The most common thing during a refactor is "a file was renamed but something still imports the old path" -- it only blows up at runtime
//   · A single wrong letter in a UI `t('xxx')` raises no error, it just shows `xxx` to the user verbatim
//
// So this does four things:
//   1) parse every relative import in the sources and confirm one by one that the file really exists (including .js/.jsx/index resolution)
//   2) verify that the file referenced by every script in package.json exists
//   3) verify that every i18n key used by the UI is in the dictionaries (and that the zh/en key sets are aligned with each other)
//   4) verify that the key artifacts exist and are non-empty (the generated dictionaries, the web build output)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'logs', 'reports', 'feeds', 'watch', 'thumbs', 'advice', 'pw-browsers']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

// ───────────────────────────────────────────── 1. files and the import graph

const CODE_EXT = ['.js', '.jsx', '.mjs', '.cjs'];
const files = [];
for (const d of ['server/src', 'server/scripts', 'web/src', 'tools', 'launcher', 'web']) {
  files.push(...walk(path.join(ROOT, d)).filter((f) => CODE_EXT.includes(path.extname(f))));
}
const fileSet = new Set(files.map((f) => path.resolve(f)));

process.stdout.write(`\n1. source files\n   ${files.length} source files\n`);

let emptyFiles = 0;
for (const f of files) {
  const st = fs.statSync(f);
  if (st.size === 0) {
    emptyFiles++;
    problems.push(`empty file (most likely truncated/written badly): ${rel(f)}`);
  }
}
if (!emptyFiles) process.stdout.write('   [ok]   no 0-byte source files\n');

/** Node's module resolution order: as-is -> .js/.jsx/.mjs/.cjs -> index.* inside the directory */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return { external: true };
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const ext of CODE_EXT) candidates.push(base + ext);
  for (const ext of CODE_EXT) candidates.push(path.join(base, 'index' + ext));
  // the case in web where './x.js' is imported but it is actually x.jsx
  for (const ext of CODE_EXT) candidates.push(base.replace(/\.jsx?$/, '') + ext);
  for (const c of candidates) {
    // Judge with the filesystem, not "is it in the set of source files" -- the latter only holds .js/.jsx,
    // so a genuinely existing .json / .css import gets reported as "pointing to a nonexistent file" (learned the hard way)
    try {
      if (fs.statSync(c).isFile()) return { file: path.resolve(c) };
    } catch {
      /* try the next candidate */
    }
  }
  return { missing: base };
}

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
let checked = 0;
let missing = 0;
const badImports = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    checked++;
    const r = resolveImport(f, spec);
    if (r.missing) {
      missing++;
      badImports.push(`${rel(f)} → ${spec}`);
    }
  }
}
process.stdout.write(`\n2. import graph\n   ${checked} imports, all relative references resolved\n`);
if (missing) {
  for (const b of badImports.slice(0, 20)) problems.push(`import points to a nonexistent file: ${b}`);
  if (badImports.length > 20) problems.push(`...and ${badImports.length - 20} more`);
} else {
  process.stdout.write('   [ok]   every relative import points to a real file\n');
}

// ───────────────────────────────────────────── 2. package.json scripts

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
process.stdout.write('\n3. package.json\n');
if (!pkg.name || !pkg.version) problems.push('package.json is missing name/version');
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/(?:node|node_modules\/\.bin\/\S+)?\s*((?:tools|server|launcher|web)[\\/][^\s"']+)/g)) {
    const target = m[1].replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, target))) {
      problems.push(`script "${name}" references a nonexistent file: ${target}`);
    }
  }
}
process.stdout.write(`   [ok]   the references of all ${Object.keys(pkg.scripts ?? {}).length} scripts exist\n`);
if (pkg.type !== 'module') notes.push('package.json type is not module (the server side uses ESM)');

// ───────────────────────────────────────────── 3. i18n key consistency

process.stdout.write('\n4. i18n dictionaries\n');
const i18nPath = path.join(ROOT, 'web/src/i18n.jsx');
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
/**
 * Take the text range of one dictionary.
 * Note you cannot "start at en and take everything to the end of the file" -- after en there is still the return
 * object of I18nProvider, and that would treat runtime fields like weekdays / fmtDate / en-GB as dictionary keys
 * (learned the hard way).
 * Use the closing `},` at 2-space indent as the boundary: a nested object's brace is indented deeper, so it is never misjudged.
 */
function blockFor(which) {
  const startIdx = i18nSrc.indexOf(`  ${which}: {`);
  if (startIdx < 0) return '';
  const after = i18nSrc.slice(startIdx);
  const end = /\n  \},\n/.exec(after);
  return after.slice(0, end ? end.index : after.length);
}

/** Blank out the contents of string literals (keeping the quote positions), so brace counting cannot be fooled by a `{` inside a value */
function stripStrings(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
    } else out += c;
  }
  return out;
}

/**
 * Take only the keys at the dictionary's **own level**.
 * Indentation cannot decide it -- after an entry is wrapped there are keys at 6 spaces, and a nested object's keys are also at 6 spaces.
 * So blank out the string contents first (a value body can contain things like `{ title, body }`), then walk by brace depth:
 * only lines at depth 1 are keys of this dictionary.
 */
function topLevelKeys(block) {
  const keys = new Set();
  let depth = 0;
  for (const raw of stripStrings(block).split(/\r?\n/)) {
    const isKey = depth === 1 && /^\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:/.exec(raw);
    if (isKey) keys.add(isKey[1] ?? isKey[2]);
    for (const ch of raw) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return keys;
}

function dictKeys(which) {
  return topLevelKeys(blockFor(which));
}
const zhKeys = dictKeys('zh');
const enKeys = dictKeys('en');
process.stdout.write(`   zh ${zhKeys.size} entries / en ${enKeys.size} entries\n`);
for (const k of zhKeys) if (!enKeys.has(k)) problems.push(`en is missing the entry: ${k}`);
for (const k of enKeys) if (!zhKeys.has(k)) problems.push(`zh is missing the entry: ${k}`);

// Keys used in the UI must exist (a wrong letter raises no error, it just displays the key verbatim)
const used = new Map();
for (const f of files.filter((x) => x.includes(`${path.sep}web${path.sep}`))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) {
    if (!used.has(m[1])) used.set(m[1], rel(f));
  }
}
const unknown = [...used.entries()].filter(([k]) => !zhKeys.has(k));
process.stdout.write(`   the UI uses ${used.size} keys\n`);
if (unknown.length) {
  for (const [k, f] of unknown.slice(0, 25)) problems.push(`the UI uses a nonexistent entry: ${k} (${f})`);
  if (unknown.length > 25) problems.push(`...and ${unknown.length - 25} more`);
} else {
  process.stdout.write('   [ok]   every key used by the UI has an entry\n');
}

// ───────────────────────────────────────────── 4. key artifacts

process.stdout.write('\n5. key artifacts\n');
const genPath = path.join(ROOT, 'web/src/locales/generated.js');
if (!fs.existsSync(genPath)) problems.push('missing web/src/locales/generated.js (run node tools/i18n-hant.mjs)');
else {
  const sz = fs.statSync(genPath).size;
  if (sz < 20000) problems.push(`generated.js is only ${sz} bytes, probably an incomplete generation`);
  else process.stdout.write(`   [ok]   traditional-Chinese entries ${(sz / 1024).toFixed(1)} KB\n`);
}
const bundle = path.join(ROOT, 'web/dist/index.html');
if (fs.existsSync(bundle)) process.stdout.write('   [ok]   the web build output exists (web/dist/index.html)\n');
else notes.push('web/dist is not built yet (npm run build is needed before release)');

for (const f of ['README.md', 'LICENSE', 'docs/DESIGN.md', 'docs/PRIVACY.md', 'docs/RELEASE.md', 'launcher/launch.cjs']) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`missing key file: ${f}`);
}
process.stdout.write(`   [ok]   all key files present\n`);

// ───────────────────────────────────────────── 5b. the source catalogue
//
// Two real defects lived in this catalogue and neither had a check, so both had to be found by hand:
// the one built-in source without a url could not be probed at all (the probe skips a source with no
// address, so asking for that one alone answered "nothing to probe" and the UI called it untestable),
// and every built-in bilibili source fed the Live tab, so the app shipped showing example rooms nobody
// chose. Both invariants cost three lines to state, which is the whole argument for stating them.
try {
  const { pathToFileURL } = await import('node:url');
  const sourcesUrl = pathToFileURL(path.join(ROOT, 'server/src/sources.js')).href;
  const liveUrl = pathToFileURL(path.join(ROOT, 'server/src/live.js')).href;
  const { BUILTIN_SOURCES } = await import(sourcesUrl);
  const { liveUids } = await import(liveUrl);

  const noUrl = (BUILTIN_SOURCES ?? []).filter((s) => !s.url);
  const unparsable = (BUILTIN_SOURCES ?? []).filter((s) => {
    try {
      void new URL(s.url);
      return false;
    } catch {
      return true;
    }
  });
  if (noUrl.length) problems.push(`built-in source(s) with no url, so the probe cannot measure them: ${noUrl.map((s) => s.id).join(', ')}`);
  if (unparsable.length) problems.push(`built-in source(s) whose url does not parse: ${unparsable.map((s) => s.id).join(', ')}`);
  if (!noUrl.length && !unparsable.length) process.stdout.write(`   [ok]   ${BUILTIN_SOURCES.length} built-in sources, every one with a usable address\n`);

  const biliInLive = (BUILTIN_SOURCES ?? []).filter((s) => s.category === 'bili' && s.liveCheck !== false);
  if (biliInLive.length) problems.push(`built-in bilibili source(s) would decide the Live tab: ${biliInLive.map((s) => s.id).join(', ')} (each needs liveCheck: false)`);

  // And the mechanism itself: the flag must actually be honoured, and live.uids must still be read.
  const fromDefaults = liveUids({ live: { uids: [] } }, BUILTIN_SOURCES);
  if (fromDefaults.length) problems.push(`the Live tab would start with rooms from built-in sources: ${fromDefaults.map((u) => u.uid).join(', ')}`);
  const explicit = liveUids({ live: { uids: ['12345'] } }, BUILTIN_SOURCES);
  if (!explicit.some((u) => u.uid === '12345')) problems.push('a uid in live.uids is no longer honoured');
  if (!fromDefaults.length && explicit.some((u) => u.uid === '12345')) process.stdout.write('   [ok]   the Live tab starts empty, and a uid the user chose still counts\n');
} catch (e) {
  problems.push(`could not read the source catalogue: ${e.message}`);
}

// ───────────────────────────────────────────── 6. bug table numbering
//
// Three times I wrote "add a line" as "replace the adjacent line", which silently lost a record from the bug table.
// Mistakes a human makes should not be avoided by being careful -- let the check catch them.
const bugsPath = path.join(ROOT, 'docs', 'BUGS.md');
if (fs.existsSync(bugsPath)) {
  const nums = [];
  const lines = fs.readFileSync(bugsPath, 'utf8').split(/\r?\n/);
  lines.forEach((l, i) => {
    const m = /^\|\s*(\d+[a-z]?)\s*\|/.exec(l);
    if (m) nums.push({ n: m[1], line: i + 1 });
  });
  const seen = new Map();
  for (const { n, line } of nums) {
    if (seen.has(n)) problems.push(`BUGS.md duplicate number: #${n} (line ${seen.get(n)} and line ${line})`);
    seen.set(n, line);
  }
  const plain = [...new Set(nums.filter((x) => /^\d+$/.test(x.n)).map((x) => Number(x.n)))].sort((a, b) => a - b);
  // Collapse missing numbers into ranges: injecting a #99 should not list 66 isolated numbers, it should report "20..98 missing"
  const gaps = [];
  for (let i = 1; i < plain.length; i++) {
    if (plain[i] - plain[i - 1] > 1) gaps.push([plain[i - 1] + 1, plain[i] - 1]);
  }
  if (gaps.length) {
    const shown = gaps
      .slice(0, 5)
      .map(([a, b]) => (a === b ? '#' + a : `#${a}..#${b}`))
      .join(', ');
    problems.push(`BUGS.md missing numbers: ${shown}${gaps.length > 5 ? ` and ${gaps.length} such ranges` : ''} (did an added line get written as a replacement?)`);
  }
  if (!nums.length) notes.push('no entries parsed out of docs/BUGS.md (did the table structure change?)');
  else process.stdout.write(`   [ok]   bug table has ${nums.length} entries, numbering unique and contiguous\n`);
}

// ───────────────────────────────────────────── result

process.stdout.write('\n6. result\n');
for (const n of notes) process.stdout.write('   note: ' + n + '\n');
if (problems.length) {
  for (const p of problems) process.stdout.write('   PROBLEM: ' + p + '\n');
  process.stdout.write(`\n${problems.length} problems.\n\n`);
  process.exit(1);
}
process.stdout.write('   file integrity is fine.\n\n');
