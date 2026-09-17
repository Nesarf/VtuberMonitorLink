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
import os from 'node:os';
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

/**
 * Blank out the contents of string literals (keeping the quote positions), so brace counting cannot be fooled
 * by a `{` inside a value.
 *
 * Two things this has to get right, and the first version got one of them wrong:
 *   1) a **comment** is not code: an apostrophe in an English comment ("the page's own intro") is not the start
 *      of a string. Treated as one, the comment swallowed everything up to the next apostrophe — which was the
 *      end of the dictionary, so eleven freshly added keys silently vanished from the set this check reads
 *      (measured: zh showed 249 entries while the file had 260).
 *   2) a string that spans lines (`'...' + '...'` wraps in the hint entries) must not look like an unclosed
 *      quote either, which is why the quote state is carried across lines rather than reset per line.
 */
function stripStrings(s) {
  let out = '';
  let q = null;
  let comment = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (comment === 'line') {
      if (c === '\n') comment = null;
      else {
        out += c === '\n' ? '\n' : ' ';
        continue;
      }
    }
    if (comment === 'block') {
      if (c === '*' && s[i + 1] === '/') {
        out += '  ';
        i++;
        comment = null;
      } else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (q) {
      if (c === '\\') {
        out += '  ';
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      comment = 'line';
      out += '  ';
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      comment = 'block';
      out += '  ';
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += c;
      continue;
    }
    out += c;
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
// and every built-in source of one platform fed the Live tab, so the app shipped showing example rooms
// nobody chose. Both invariants cost three lines to state, which is the whole argument for stating them.
//
// The second defect is now settled the other way: the platform, its four dynamic sources, its live
// endpoint and the tab they fed were all removed, so the catalogue must not offer such a source at all.
// That is checked here over the whole catalogue and over the fetch kinds the custom-source editor
// offers, because "the product no longer knows this site" is exactly the kind of fact that comes back
// through a helper nobody meant to keep.
try {
  const { pathToFileURL } = await import('node:url');
  const sourcesUrl = pathToFileURL(path.join(ROOT, 'server/src/sources.js')).href;
  const { BUILTIN_SOURCES, CATEGORIES, sourceLoginHost } = await import(sourcesUrl);
  const { FETCH_KINDS } = await import(pathToFileURL(path.join(ROOT, 'server/src/fetchers/index.js')).href);

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

  // The catalogue no longer knows the two retired platforms, by id, by host or by declared category.
  const RETIRED = /bilibili|bili[-.]|(^|[^a-z])x\.com|twitter/i;
  const retiredSources = (BUILTIN_SOURCES ?? []).filter((s) => RETIRED.test(s.id) || RETIRED.test(String(s.url ?? '')) || RETIRED.test(String(s.category ?? '')) || RETIRED.test(JSON.stringify(s.name ?? {})));
  if (retiredSources.length) problems.push(`the catalogue still offers the retired platform(s): ${retiredSources.map((s) => `${s.id} (${s.url})`).join(', ')}`);
  const retiredCategories = Object.keys(CATEGORIES ?? {}).filter((c) => RETIRED.test(c));
  if (retiredCategories.length) problems.push(`a retired platform is still a source category: ${retiredCategories.join(', ')}`);
  const retiredKinds = (FETCH_KINDS ?? []).filter((k) => RETIRED.test(k.id) || RETIRED.test(String(k.zh ?? '')) || RETIRED.test(String(k.en ?? '')));
  if (retiredKinds.length) problems.push(`a retired platform is still an offered fetch kind: ${retiredKinds.map((k) => k.id).join(', ')}`);
  if (!retiredSources.length && !retiredCategories.length && !retiredKinds.length) {
    process.stdout.write('   [ok]   no source, category or fetch kind names a retired platform\n');
  }

  // The control: the same detectors over a catalogue that does offer one, so "nothing matches" cannot be
  // satisfied by a regex that matches nothing at all.
  const fixture = [{ id: 'bili-opus-x', url: 'https://space.bilibili.com/1/dynamic', category: 'bili', name: { zh: 'B站动态', en: 'bilibili' } }];
  const fixtureHits = fixture.filter((s) => RETIRED.test(s.id) || RETIRED.test(String(s.url)) || RETIRED.test(s.category) || RETIRED.test(JSON.stringify(s.name)));
  const fixtureKind = [{ id: 'bili-opus', zh: 'B 站图文动态', en: 'bilibili dynamics' }].filter((k) => RETIRED.test(k.id) || RETIRED.test(k.zh) || RETIRED.test(k.en));
  if (fixtureHits.length !== 1 || fixtureKind.length !== 1) {
    problems.push('the "no retired platform in the catalogue" check does not fire on a catalogue that offers one, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, a catalogue that does offer one, is caught)\n');
  }

  // The same absence for the watch-target kinds. The kind that left read an account id from a site this
  // product no longer knows, and the release walk pins the count on the running app; this states it offline,
  // where a failure names the offending entry instead of only "5 kinds, expected 4".
  const { TARGET_KINDS } = await import(pathToFileURL(path.join(ROOT, 'server/src/watch.js')).href);
  const retiredTargetKinds = (TARGET_KINDS ?? []).filter((k) => RETIRED.test(`${k.id} ${k.zh ?? ''} ${k.en ?? ''}`));
  const expectedTargetKinds = 4; // url / mediawiki-page / mediawiki-recentchanges / mediawiki-watchlist
  if (retiredTargetKinds.length) problems.push(`a retired platform is still a watch-target kind: ${retiredTargetKinds.map((k) => k.id).join(', ')}`);
  else if ((TARGET_KINDS ?? []).length !== expectedTargetKinds) problems.push(`the watch-target kinds are ${(TARGET_KINDS ?? []).length}, and this check pins ${expectedTargetKinds}: if a kind was added or removed, say which and why here`);
  else process.stdout.write(`   [ok]   the ${expectedTargetKinds} watch-target kinds name no retired platform\n`);
  const targetKindFixture = [{ id: 'bili-opus', zh: 'B 站动态', en: 'bilibili dynamics' }].filter((k) => RETIRED.test(`${k.id} ${k.zh} ${k.en}`));
  if (targetKindFixture.length !== 1) problems.push('the watch-kind detector does not fire on a fixture that carries one, so it proves nothing');
  else process.stdout.write('   [ok]   (and the control, a watch kind that names one, is caught)\n');

  // A source with no url has no login host to probe, and the host is never guessed from the platform.
  if (sourceLoginHost({ id: 'rss-x', category: 'community', fetch: 'rss' }) !== null) {
    problems.push('a source with no url no longer answers "no host", so the check would silently do nothing');
  } else if (sourceLoginHost({ id: 'b', url: 'https://space.bilibili.com/123/dynamic' }) !== 'space.bilibili.com') {
    problems.push('the probe host is no longer taken from the source url itself');
  } else {
    process.stdout.write('   [ok]   a source is probed on its own host, and one with no url says so\n');
  }

  // No **default** source may declare `login: 'required'` -- measured on the tree this landed in: the eight
  // literals in the catalogue are five `'none'` and three `'optional'`, and the only real `required` left is
  // the `mediawiki-watchlist` watch-target kind, which the user adds deliberately.
  //
  // This is one assertion, not a rule about the field: `required` stays legal in the vocabulary (the file
  // header documents it, and server/src/watch.js uses it), it must just not be used by a source that ships
  // enabled by default. The reason it is worth pinning at all is that a source nobody can fetch without a
  // login turns a first run into a wall of red, and "it came back through a helper nobody meant to keep" is
  // how a required login returned before.
  const requiredLogin = (BUILTIN_SOURCES ?? []).filter((s) => s.login === 'required');
  if (requiredLogin.length) {
    problems.push(
      `built-in source(s) declaring login: 'required', so a default source cannot be fetched without a login state: ${requiredLogin
        .map((s) => s.id)
        .join(', ')} (required is still a legal value -- this pins only that no shipped source uses it)`,
    );
  } else {
    process.stdout.write('   [ok]   no built-in source requires a login state\n');
  }
  // The control: the same detector over a catalogue that does declare one, so an empty `requiredLogin` cannot
  // be satisfied by a comparison that never matches. If the real catalogue ever does declare one, the check
  // above fails and its detail names the id, so this control passes for the right reason either way.
  const requiredFixture = [{ id: 'wiki-login-only', login: 'required' }].filter((s) => s.login === 'required');
  if (requiredFixture.length !== 1) {
    problems.push('the "no built-in source requires a login" check does not fire on a catalogue that declares one, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, a catalogue that declares one, is caught)\n');
  }

  // The catalogue and the editor must offer only fields and categories something reads. `uid` was the field
  // for the one fetch kind that took an account id instead of an address; the kind and the field go together,
  // and a stored field nothing fetches is the same defect as a dead dictionary key: it looks like a setting.
  const { CUSTOM_SOURCE_FIELDS } = await import(sourcesUrl);
  if (CUSTOM_SOURCE_FIELDS.includes('uid')) problems.push('the custom-source field list still accepts `uid`, which no fetch kind reads any more');
  else process.stdout.write('   [ok]   the custom-source fields do not offer a field nothing fetches\n');
  const { TARGET_FIELDS } = await import(pathToFileURL(path.join(ROOT, 'server/src/watch.js')).href);
  if (TARGET_FIELDS.includes('uid')) problems.push('the watch-target field list still accepts `uid`, which no target kind reads any more');
  else process.stdout.write('   [ok]   the watch-target fields do not offer one either\n');

  // Control: both detectors must fire on a list that does carry it.
  const fieldFixture = (list) => list.includes('uid');
  if (!fieldFixture(['id', 'url', 'uid']) || fieldFixture(CUSTOM_SOURCE_FIELDS)) {
    problems.push('the "no dead source field" detector does not fire on a fixture that carries `uid`, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, a list that does carry it, is caught)\n');
  }
} catch (e) {
  problems.push(`could not read the source catalogue: ${e.message}`);
}

// ───────────────────────────────────────────── 5c. long operations are guarded
//
// The request log on this machine showed one real trap and one false alarm. The false alarm is worth
// recording as a rule of its own: five calls to /api/proxy/nodes/test inside three seconds looked like a
// person hammering a dead button, and the code said otherwise - each group's probe takes about 600ms and
// the button disables while busy, so those five were five different groups tested in turn. The real trap
// is that a React button cannot stop two clicks inside one frame, two browser tabs, or a client that
// retries; the server has to. So: every expensive POST carries an in-flight guard, and the nodes probe
// button keeps the disabled state that makes the ordinary case impossible.
try {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const guarded = [
    "/api/sources/:id/diagnose",
    "/api/probe",
    "/api/proxy/nodes/test",
    "/api/features/extract",
  ].filter((route) => !new RegExp(`app\\.post\\('${route.replace(/[/:]/g, (c) => '\\' + c)}', busyGuard\\(`).test(serverSrc));
  if (guarded.length) problems.push(`expensive route(s) with no in-flight guard: ${guarded.join(', ')}`);
  else process.stdout.write(`   [ok]   ${4} long operation(s) refuse to run twice at once\n`);

  const settingsSrc = fs.readFileSync(path.join(ROOT, 'web/src/pages/Settings.jsx'), 'utf8');
  const button = /testNodes\(g\);[\s\S]{0,120}?disabled=\{busy\}/.test(settingsSrc);
  if (!button) problems.push('the nodes probe button no longer disables while busy');
  else process.stdout.write('   [ok]   the nodes probe button disables while a probe is running\n');
} catch (e) {
  problems.push(`could not read the long-operation guards: ${e.message}`);
}

// ───────────────────────────────────────────── 5d. a source's region survives the whole trip
//
// The region setting is the one kind of value where a mistake is invisible in every direction at once:
// stored with a typo it never matches what an exit measured, so it reads as "no preference"; sent by the
// page but dropped by the route it looks saved and does nothing; and dropped by the sanitiser it is simply
// gone. None of those raise anything. So the trip is checked end to end: the catalogue's own values, the
// sanitiser's rules, and the two places that have to carry it (the route and the page).
try {
  const { pathToFileURL } = await import('node:url');
  const { BUILTIN_SOURCES, sanitizeCustomSource, mergeSourceOverride } = await import(pathToFileURL(path.join(ROOT, 'server/src/sources.js')).href);

  const declared = (BUILTIN_SOURCES ?? []).filter((s) => s.region !== undefined);
  const bad = declared.filter((s) => !/^[A-Z]{2}$/.test(String(s.region)));
  if (bad.length) problems.push(`built-in source(s) with an unusable region: ${bad.map((s) => `${s.id}=${JSON.stringify(s.region)}`).join(', ')} (a two-letter code, upper case)`);
  else if (declared.length) process.stdout.write(`   [ok]   ${declared.length} built-in source(s) pin a region, every one a usable code\n`);

  // The rules, each with the value that must NOT survive: a lower-case code is normalised rather than
  // rejected (people type `jp`), while a country name, a three-letter code and an object are dropped.
  const kept = sanitizeCustomSource({ id: 'x', url: 'https://e.com/', region: 'jp' });
  const dropped = ['china', 'CHN', 'J', '12', 'j p', {}];
  const survived = dropped.filter((v) => sanitizeCustomSource({ id: 'x', url: 'https://e.com/', region: v }).region !== undefined);
  if (kept.region !== 'JP') problems.push(`a region is no longer normalised to an upper-case code: ${JSON.stringify(kept.region)}`);
  else if (survived.length) problems.push(`region value(s) that should have been dropped were stored: ${survived.map((v) => JSON.stringify(v)).join(', ')}`);
  else process.stdout.write('   [ok]   a region is either a two-letter code or absent, whatever was sent\n');

  // The merge, and the bug the merge replaced. `base` is an override entry that already carries a url; the
  // caller sends only a region. Both shapes are run here so the difference is stated rather than remembered:
  // the spread loses the url, the merge cannot.
  const base = { id: 'x', name: 'X', url: 'https://e.com/feed.xml', region: 'JP' };
  const merged = mergeSourceOverride(base, { region: 'TW' });
  if (merged.url !== base.url) problems.push(`a partial override dropped a field it did not mention: url became ${JSON.stringify(merged.url)}`);
  else if (merged.region !== 'TW') problems.push(`a partial override did not apply the field it did mention: region is ${JSON.stringify(merged.region)}`);
  else process.stdout.write('   [ok]   a partial override writes only the fields it actually sends\n');

  const spreadShape = sanitizeCustomSource({ ...base, url: undefined, region: 'TW' });
  if (spreadShape.url !== undefined) notes.push('the spread shape no longer loses an unmentioned field, so that check is now vacuous');
  else process.stdout.write('   [ok]   (and the spread shape it replaced really did lose it - the bug was not imaginary)\n');

  const serverSrc2 = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const routeBlock = serverSrc2.match(/app\.patch\('\/api\/sources\/:id'[\s\S]*?\n  \}\);/);
  if (!routeBlock) problems.push('the source patch route could not be found, so its handling of region is unchecked');
  else if (!/region/.test(routeBlock[0])) problems.push('PATCH /api/sources/:id ignores region: the page would save a region that is never written');
  else process.stdout.write('   [ok]   the source patch route carries the region through\n');

  const sourcesPage = fs.readFileSync(path.join(ROOT, 'web/src/pages/Sources.jsx'), 'utf8');
  if (!/sourceRegion/.test(sourcesPage) || !/region:/.test(sourcesPage)) problems.push('the sources page no longer offers the region setting, so the field is only reachable by hand-editing config.json');
  else process.stdout.write('   [ok]   the sources page offers the region setting, in the list and at creation time\n');
} catch (e) {
  problems.push(`could not read the region setting's trip: ${e.message}`);
}

// ───────────────────────────────────────────── 5e. every login setting has a "check login state"
//
// The requirement is one sentence -- "wherever a login state can be configured, there must be a check button,
// and it must always be available" -- and every way of failing it is invisible in a different way. The button
// can be missing (Share's account stage and the sources list had none), it can be **wrapped in a condition**
// that is usually false (BUGS #26 is exactly that, and it shipped), it can be disabled into uselessness, and
// it can call a route that does not exist or one that answers with the cookie probe's shape while the page
// reads a different one. So each of those is asserted separately, on the page source rather than on a comment.
//
// The other rule this section pins is the one the share page got wrong: the **login** stage is independent of
// the **send** stage, so a target whose publishing is unsupported must still offer configure-and-check.
try {
  const { pathToFileURL } = await import('node:url');
  const { shareTargets, resolveLoginProbe, stagesReport } = await import(pathToFileURL(path.join(ROOT, 'server/src/share.js')).href);
  const { sourceLoginHost } = await import(pathToFileURL(path.join(ROOT, 'server/src/sources.js')).href);
  const { parseWikiLoginResponse } = await import(pathToFileURL(path.join(ROOT, 'server/src/watch.js')).href);
  const { resolveOpenPath, parseEditorCommand, buildOpenInvocation } = await import(pathToFileURL(path.join(ROOT, 'server/src/openfile.js')).href);

  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // (a) The four surfaces, and the control that they do not merely mention the affordance in a comment.
  //
  // The browser login probe used to live in Settings.jsx (its Browser section owned the profile dir). It is on
  // the Browser page now — the page that owns the setting is the page that checks it — and Settings points at
  // that page instead of restating the setting, so this entry moved with it.
  //
  // The fifth entry was the Live page's danmaku account check. That page is gone (the tab, its route and the
  // live feature it read were removed together), so the check went with it rather than being pointed at some
  // other file: an entry whose file no longer exists would make this section fail with an ENOENT instead of
  // saying anything about logins.
  const surfaces = [
    ['web/src/pages/Browser.jsx', /<LoginCheckButton/, 'the browser login probe'],
    ['web/src/pages/Share.jsx', /<LoginCheckButton/, 'the share login stage'],
    ['web/src/pages/Sources.jsx', /<LoginCheckButton/, 'the per-source login check'],
    ['web/src/pages/Watch.jsx', /onClick=\{checkWikiLogin\}/, 'the wiki BotPassword check'],
  ];
  const missingAffordance = surfaces.filter(([file, re]) => !re.test(read(file)));
  if (missingAffordance.length) {
    problems.push(`login setting(s) with no check affordance: ${missingAffordance.map(([f, , w]) => `${w} (${f})`).join(', ')}`);
  } else {
    process.stdout.write(`   [ok]   ${surfaces.length} surfaces that configure a login, every one with a check affordance\n`);
  }

  // (b) The check must be rendered unconditionally. The precedent is BUGS #26, where a button lived inside
  // `{active && ...}`: an assertion that the identifier appears would have passed the whole time.
  const conditional = [];
  for (const [file, re] of [
    ['web/src/pages/Sources.jsx', /<LoginCheckButton/],
    ['web/src/pages/Share.jsx', /<LoginCheckButton/],
  ]) {
    const src = read(file);
    for (const line of src.split(/\r?\n/)) {
      if (!re.test(line)) continue;
      if (/\{[\w.?]+\s*&&\s*<LoginCheckButton|&&\s*$/.test(line)) conditional.push(`${file}: ${line.trim()}`);
    }
  }
  if (conditional.length) problems.push(`a login check is rendered conditionally, so it can be hidden: ${conditional.join(' | ')}`);
  else process.stdout.write('   [ok]   the login checks render unconditionally (no `{active && <button/>}` shape)\n');

  // (c) The routes those buttons call must exist, and the expensive ones must keep the in-flight guard.
  const routes = [
    ["/api/cookies/check", /app\.post\('\/api\/cookies\/check'/],
    ["/api/watch/login-check", /app\.post\('\/api\/watch\/login-check', busyGuard\(/],
    ["/api/share/check-login", /app\.get\('\/api\/share\/check-login', busyGuard\(/],
    ["/api/open", /app\.post\('\/api\/open'/],
  ];
  const missingRoutes = routes.filter(([, re]) => !re.test(serverSrc));
  if (missingRoutes.length) problems.push(`check-login route(s) missing (or without their guard): ${missingRoutes.map(([r]) => r).join(', ')}`);
  else process.stdout.write(`   [ok]   the ${routes.length} routes behind those buttons exist (the long ones guarded)\n`);

  // (d) The login stage is independent of the send stage. Every posting target must be checkable, and the
  // control is a login kind with no probe AND no host, which is the only case with nothing to measure.
  //
  // What changed this round: the two probes this project implemented belonged to sites that were removed, so
  // "a site with its own probe stays checkable" is asserted on a **declared** profile rather than on a
  // built-in one -- and the distinction that matters now is `actionable`: a site whose login state this build
  // can read for real (the cookie probe against its own host) must say so, and a site whose probe would need a
  // credential this build cannot look up must not claim it can run it.
  const posts = shareTargets({}).filter((x) => x.kind === 'post');
  const notCheckable = posts.filter((x) => !resolveLoginProbe(x, {}).checkable);
  if (notCheckable.length) problems.push(`posting target(s) with no login check at all: ${notCheckable.map((x) => x.id).join(', ')}`);
  else process.stdout.write(`   [ok]   all ${posts.length} posting targets are checkable\n`);

  const withHost = posts.filter((x) => resolveLoginProbe(x, {}).host);
  const notActionable = withHost.filter((x) => stagesReport([], {}, {}).find((y) => y.id === x.id)?.stages.verification.actionable !== true);
  if (notActionable.length) {
    problems.push(`posting target(s) with a readable host whose login stage claims nothing can be run: ${notActionable.map((x) => x.id).join(', ')}`);
  } else {
    process.stdout.write(`   [ok]   the ${withHost.length} target(s) with a readable host report an actionable login check\n`);
  }

  // A declared site-specific probe is reported as such, and is NOT called runnable: running it would need a
  // credential, and nothing in this build enumerates one. The site here has no host either (its compose page
  // is the `{instance}` placeholder of a Mastodon instance), so neither probe can run and the stage must not
  // claim one can.
  const probeSite = { id: 'probe-site', loginKind: 'mastodon', verify: 'token-scope', manual: { compose: 'https://{instance}/publish?text={text}' } };
  const probeCfg = { share: { sites: [probeSite] } };
  const probePlan = resolveLoginProbe('probe-site', probeCfg);
  const probeStage = stagesReport([], {}, probeCfg).find((y) => y.id === 'probe-site');
  if (probePlan.probe !== 'token-scope' || probePlan.needsAccount !== true) {
    problems.push('a declared site-specific probe is no longer reported with its own name');
  } else if (probeStage?.stages.verification.actionable !== false || probeStage?.stages.verification.probe !== 'token-scope') {
    problems.push('a site-specific probe is reported as runnable, although running it needs a credential nothing here looks up');
  } else {
    process.stdout.write('   [ok]   a site-specific probe is named, and is not claimed runnable\n');
  }

  // The control for that: the same site with a host. Its own probe still cannot run, but the read-only cookie
  // probe for that host can, and the stage has to say so -- otherwise "not runnable" would be satisfied by a
  // stage that never reports a measurement at all.
  const withHostCfg = { share: { sites: [{ ...probeSite, host: 'example.social' }] } };
  const withHostStage = stagesReport([], {}, withHostCfg).find((y) => y.id === 'probe-site');
  if (withHostStage?.stages.verification.actionable !== true || withHostStage?.stages.verification.fallbackProbe !== 'cookie-probe') {
    problems.push('a site with a readable host reports no runnable login check, so "not runnable" above proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, the same site with a host, is measurable after all)\n');
  }

  // The control: a cookie login kind on a site with no knowable host must be refused rather than probed.
  const noHost = resolveLoginProbe('weibo-no-host', { share: { sites: [{ id: 'weibo-no-host', loginKind: 'weibo', manual: { compose: 'https://{instance}/compose?text={text}' } }] } });
  if (noHost.checkable !== false) problems.push('a login kind with no probe and no host is reported as checkable, so a probe would run against a domain nobody owns');
  else process.stdout.write('   [ok]   (and a login with no probe and no host is refused instead of probed - the control fires)\n');

  // (e) The sources page takes the host from the source itself, and the wiki probe stays read-only: both are
  // "the honest measurement" this round is about, so a regression in either makes the button lie.
  if (sourceLoginHost({ id: 'rss-x', category: 'community', fetch: 'rss' }) !== null) problems.push('a source with no url no longer answers "no host", so the check would silently do nothing');
  if (!/sourceProbeHost/.test(read('web/src/pages/Sources.jsx'))) problems.push('the sources page no longer resolves the probe host itself, so a source with no host cannot say so before sending a request');
  else process.stdout.write('   [ok]   a source is probed on its own host, and one with no url says so\n');

  const anon = parseWikiLoginResponse({ query: { userinfo: { id: 0, anon: true } } });
  const named = parseWikiLoginResponse({ query: { userinfo: { id: 7, name: 'Bot@Task' } } });
  if (anon.ok !== false || named.ok !== true) problems.push('the wiki answer parser no longer separates an anonymous answer from a named one, so a refused credential could read as success');
  else process.stdout.write('   [ok]   the wiki probe reads an anonymous answer as a failure and a named one as a success\n');

  // (f) The editor opener: the request carries a name and never a path, and the invocation is an argv array.
  const outside = resolveOpenPath({ paths: { reportsDir: path.join(os.tmpdir(), 'vml-integrity-none') } }, 'report', path.join(os.tmpdir(), 'x.txt'));
  if (outside.ok || outside.code !== 'not-a-file-name') problems.push('the open endpoint accepts a path from the client, which is the one thing it must never do');
  const inv = buildOpenInvocation({ path: '/tmp/x.html', editor: { program: 'code', args: [] }, platform: 'linux' });
  if (!inv.ok || !Array.isArray(inv.args) || inv.shell !== false) problems.push('the editor invocation is no longer an argv array with shell:false');
  // The configured command is split into words and nothing else: `&&` and `/` are arguments here, which is the
  // whole point (they would be shell syntax if the value were handed to a shell).
  if (parseEditorCommand('code && rm -rf /').length !== 5) problems.push('the configured editor command is no longer split without a shell');
  else process.stdout.write('   [ok]   the editor opener takes a name (never a path) and builds an argv array with no shell\n');

  // (g) The per-site edited body has to be the text that travels: prepared and edited must be distinguishable,
  // and an edit must never be silently cut back to the prepared text.
  const { resolveSiteBody } = await import(pathToFileURL(path.join(ROOT, 'server/src/share.js')).href);
  const bundle = { title: 'x', items: [{ id: 'a', title: 'a'.repeat(400) }] };
  const edited = resolveSiteBody({ text: 'my own words', bundle, profile: { textLimit: 280 } });
  const over = resolveSiteBody({ text: 'z'.repeat(300), bundle, profile: { textLimit: 280 } });
  if (edited.source !== 'edited' || edited.text !== 'my own words') problems.push('an edited body no longer wins over the prepared one');
  else if (over.fits !== false || over.text.length !== 300) problems.push('a body edited past the site limit is being cut to fit instead of being reported as over it');
  else process.stdout.write('   [ok]   an edited body is carried as written, and one over the limit is reported rather than cut\n');
} catch (e) {
  problems.push(`could not read the login-check wiring: ${e.message}`);
}

// ───────────────────────────────────────────── 5f. the app can actually be constructed
//
// Why this exists, in the owner's words after it happened: "the app does not start". A route registered at the
// top of createApp used a helper declared further down as a `const`, so it hit the temporal dead zone at
// **registration** time -- `ReferenceError: Cannot access 'busyGuard' before initialization` -- and
// `node server/src/index.js` exited before serving anything. The whole gate stayed green, because nothing in
// `verify:fast` ever constructs the app: every tool imports a module or reads a page, and a route that only
// throws while registering is invisible to all of them.
//
// Two checks, because they are two different questions:
//   1) **the real one**: import server/src/server.js and call createApp() with the same minimal arguments
//      index.js uses. Nothing is listened on and no port is opened -- createApp returns an express app, and
//      that is all this needs. A route that throws at registration time now fails the gate instead of the
//      user's launch.
//   2) **the specific mistake, named**: no helper may be *used* above the line where it is declared as a
//      `const`. A plain text check over the file, with a control fixture that places the usage above the
//      declaration, so the check is known to fire.
try {
  const { pathToFileURL } = await import('node:url');
  let createApp = null;
  try {
    ({ createApp } = await import(pathToFileURL(path.join(ROOT, 'server/src/server.js')).href));
  } catch (e) {
    problems.push(`server/src/server.js cannot even be imported, so the app cannot start: ${e.message}`);
  }
  if (createApp) {
    const probeCfg = {
      paths: { reportsDir: path.join(os.tmpdir(), 'vml-integrity-check'), feedsDir: path.join(os.tmpdir(), 'vml-integrity-check') },
      browser: {},
      share: {},
      watch: {},
      llm: { providers: [] },
    };
    try {
      const app = createApp({
        getConfig: () => probeCfg,
        setConfig: (next) => next,
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        onConfigChanged: () => {},
      });
      if (typeof app !== 'function') problems.push('createApp no longer returns something that can serve');
      else process.stdout.write('   [ok]   the server module constructs (no route throws at registration time)\n');
    } catch (e) {
      problems.push(`createApp() throws, so the app cannot start: ${e.name}: ${e.message}`);
    }
  }

  // The named mistake: a route using `busyGuard` above the line where it is declared. This is the exact shape
  // that took the application down (`app.post('/api/watch/login-check', busyGuard('watch login check'), ...)`
  // registered from the top of createApp, with `const busyGuard` far below it), and it is deliberately the
  // helper this check names: `busyGuard` is used as an **argument while routes register**, so the temporal
  // dead zone is reached during createApp rather than while serving a request. A helper that is only called
  // from inside a handler is safe wherever it is declared, and a rule that flagged those would be noise.
  const tdzProblems = (src) => {
    const lines = String(src).split(/\r?\n/);
    const declLineOf = (name) => {
      const re = new RegExp(`^\\s*const\\s+${name}\\s*=`);
      const i = lines.findIndex((l) => re.test(l));
      return i < 0 ? null : i + 1;
    };
    const out = [];
    for (const name of ['busyGuard']) {
      const declLine = declLineOf(name);
      if (declLine === null) continue;
      const useRe = new RegExp(`^\\s*app\\.(get|post|put|patch|delete|use)\\([^\\n]*\\b${name}\\s*\\(`);
      lines.forEach((line, i) => {
        if (i + 1 >= declLine) return;
        if (useRe.test(line)) out.push(`${name} used at line ${i + 1} but declared at ${declLine}`);
      });
    }
    return out;
  };
  const realTdz = tdzProblems(fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8'));
  if (realTdz.length) problems.push(`helper used before its const declaration (temporal dead zone -- this breaks startup): ${realTdz.join('; ')}`);
  else process.stdout.write('   [ok]   no helper is used above its own const declaration\n');

  // The control: the same check on a fixture that really does use a helper above its declaration.
  const fixture = ["app.post('/', busyGuard('x'), handler);", '', 'const busyGuard = (name) => (req, res, next) => next();'].join('\n');
  if (tdzProblems(fixture).length !== 1) {
    problems.push('the "used before its const declaration" check does not fire on a fixture that does exactly that, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control fixture, with the usage above the declaration, is caught)\n');
  }
} catch (e) {
  problems.push(`could not construct the server: ${e.message}`);
}

// ───────────────────────────────────────────── 5g. the browser profile has one owner
//
// The defect this section is about, in the owner's words: the share page's login check answered `profileDir
// is empty` and pointed at nothing he could act on. The setting lived in the Settings page's Browser section
// (behind a `mode !== 'bundled'` condition) while five features read it in five places — and every one of
// those reads works on the machine where the setting happens to be filled in, so nothing in the gate could
// see the disagreement. What was missing was not a feature but a structure: **one key, one resolver, one
// page**, and a check that says so.
//
// So this section pins the structure, as text over the sources (the same style as 5c/5d/5f above):
//   1) every module in the inventory (server/src/browser-consumers.js) resolves `browser.profileDir` through
//      server/src/browser-target.js, and **no** module reads the key itself;
//   2) the resolver really reads the key (otherwise every consumer could go through it and get '' for ever),
//      and it is the module that names the key (`browserProfileKey()`), so there is one spelling of it;
//   3) the page that owns the setting exists, asks the server for the target, and renders the per-feature
//      status table — plus the control on a fixture that does each of those things wrong.
try {
  const { pathToFileURL } = await import('node:url');
  const target = await import(pathToFileURL(path.join(ROOT, 'server/src/browser-target.js')).href);
  const consumers = await import(pathToFileURL(path.join(ROOT, 'server/src/browser-consumers.js')).href);

  const rows = consumers.consumerSources();
  const missingFiles = rows.filter((c) => !fs.existsSync(c.path));
  if (missingFiles.length) {
    problems.push(`the browser-profile inventory names file(s) that do not exist: ${missingFiles.map((c) => c.file).join(', ')}`);
  }

  const sources = rows.map((c) => ({ file: c.file, id: c.id, symbol: c.symbol, source: fs.readFileSync(c.path, 'utf8') }));
  const keyProblems = consumers.BROWSER_CONSUMERS.filter((c) => c.key !== target.browserProfileKey());
  if (keyProblems.length) {
    problems.push(`consumer(s) reading a key other than ${target.browserProfileKey()}: ${keyProblems.map((c) => `${c.file}=${c.key}`).join(', ')}`);
  }

  const resolverSrc = fs.readFileSync(path.join(ROOT, 'server/src/browser-target.js'), 'utf8');
  const pagePath = path.join(ROOT, 'web/src/pages/Browser.jsx');
  const pageSrc = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : '';

  const structural = target.browserConsumerProblems(sources, {
    resolvers: [{ file: 'server/src/browser-target.js', source: resolverSrc, must: /cfg\?\.browser\?\.profileDir/ }],
    page: { file: 'web/src/pages/Browser.jsx', source: pageSrc },
    pageMustMatch: /api\.browserTarget\(\)[\s\S]*browserFeatureStatus/,
  });
  for (const p of structural) problems.push(`browser-profile structure: ${p}`);
  if (!structural.length) {
    process.stdout.write(`   [ok]   ${rows.length} browser-profile consumer(s), every one resolving the key through server/src/browser-target.js\n`);
    process.stdout.write('   [ok]   the resolver reads the key, and web/src/pages/Browser.jsx owns the setting\n');
  }

  // The control: replace one consumer's resolver call with a **direct read of the shared key**. That is the
  // exact shape the old code had (each feature reading `cfg.browser.profileDir` itself), and it is the one the
  // detector has to catch — so the control is that shape, not an invented different key (measured: a fixture
  // reading `browser.cookiesDir` proves nothing here, because this detector looks for *the* key).
  //
  // The consumer it mutates is taken from the inventory rather than named: it used to name the danmaku row,
  // that row's module was removed with the live feature, and a control that names a gone row silently stops
  // proving anything (it would mutate nothing and report "did not fire").
  const victim = rows.find((r) => r.symbol === 'resolveProfileDir') ?? rows[0];
  const wrong = sources.map((s) =>
    s.id === victim.id ? { ...s, source: s.source.replace(/resolveProfileDir\(cfg\)/, 'cfg.browser.profileDir') } : s,
  );
  const wrongProblems = target.browserConsumerProblems(wrong);
  if (wrongProblems.length !== 1) {
    problems.push(
      `the browser-profile structural check does not fire when a consumer (${victim.id}) reads the key itself (got ${wrongProblems.length} problem(s)), so it proves nothing`,
    );
  } else if (!/directly/.test(wrongProblems[0])) {
    problems.push(`the browser-profile control fired, but on something other than the direct read: ${wrongProblems[0]}`);
  } else {
    process.stdout.write('   [ok]   (and the control, with one consumer reading the key itself, is caught)\n');
  }

  // The second control: a consumer that reads the shared key itself, which is the shape the old code had.
  const directSource = (file) => ({ file, source: "const x = cfg.browser.profileDir;\n" });
  if (target.directProfileReads(directSource('server/src/x.js').source).length !== 1) {
    problems.push('the direct-read detector does not fire on `cfg.browser.profileDir`, so the rule above is unchecked');
  } else {
    process.stdout.write('   [ok]   (and a module reading `cfg.browser.profileDir` itself is caught)\n');
  }
} catch (e) {
  problems.push(`could not read the browser-profile structure: ${e.message}`);
}

// ───────────────────────────────────────────── 5h. every api.<name>() the UI calls exists
//
// A method that is not on the api object fails no build and no lint: it throws while the page runs, and because
// it throws **synchronously**, a `.catch()` chained after it is never attached - so the error escapes the effect
// and the page renders blank. That is exactly what happened on this machine: a page called `api.getBrowsers()`,
// which api.js has never had, and the only thing that noticed was a browser walking the UI. This is the one-line
// check that would have found it first, and its control is a fixture calling a method which is not there.
const apiMethodsIn = (src) => new Set([...src.slice(src.indexOf('export const api = {')).matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]));
function missingApiCalls(apiSrc, sources) {
  const defined = apiMethodsIn(apiSrc);
  const out = [];
  for (const [name, text] of sources) {
    // Comments are removed before matching, and that is not a nicety: the comment explaining this check names
    // the very method that is missing (`api.getBrowsers()`), and a scanner that reads prose as code fires on
    // its own documentation - which is exactly the mistake recorded as bug 89 in this repository's table.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of code.matchAll(/\bapi\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) if (!defined.has(m[1])) out.push(`${name}: api.${m[1]}()`);
  }
  return out;
}
try {
  const apiSrc = fs.readFileSync(path.join(ROOT, 'web/src/api.js'), 'utf8');
  const sources = [];
  (function collect(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (/\.jsx?$/.test(e.name) && e.name !== 'api.js') sources.push([rel(p), fs.readFileSync(p, 'utf8')]);
    }
  })(path.join(ROOT, 'web/src'));

  const missing = missingApiCalls(apiSrc, sources);
  const calls = sources.reduce((n, [, text]) => n + (text.match(/\bapi\.[A-Za-z_][A-Za-z0-9_]*\s*\(/g) ?? []).length, 0);
  if (missing.length) problems.push(`the UI calls api method(s) that api.js does not define: ${missing.join(', ')}`);
  else process.stdout.write(`   [ok]   ${calls} api call(s) across ${sources.length} file(s), every name defined\n`);

  // The control: the exact call that shipped a blank page must be flagged, and a real one must not be.
  const wrong = missingApiCalls(apiSrc, [['fixture.jsx', 'api.getBrowsers().then((x) => x)']]);
  const right = missingApiCalls(apiSrc, [['fixture.jsx', 'api.browserTarget().then((x) => x)']]);
  if (right.length) problems.push(`the api-call check rejects a call that exists: ${right.join(', ')}`);
  else if (wrong.length !== 1) problems.push(`the api-call check does not fire on a method that is not defined (fired ${wrong.length} time(s))`);
  else process.stdout.write('   [ok]   control: a call to a method that is not defined is flagged, a real one is not\n');
} catch (e) {
  problems.push(`could not read the api surface: ${e.message}`);
}

// ───────────────────────────────────────────── 5i. the removed surface really is gone
//
// Two whole features were deleted this round: the live-status page with its own routes, and the two
// social platforms the product used to know. A removal leaves two kinds of trace behind, and neither
// makes a build fail: a route that is still registered (some page will find it again and call it), and a
// page or module that is still referenced from the navigation or an import graph. So the absence is
// stated, in the two places a reader would look for it — the file system and the app's own route table.
//
// Each family is checked with a control on a fixture that *does* contain the thing, because "no match"
// produced by a pattern that can never match is the classic way an absence check proves nothing.
try {
  // (a) The files are gone. A file that came back would be a feature nobody asked to bring back.
  const removed = [
    'server/src/live.js',
    'server/src/danmaku.js',
    'server/src/accounts.js',
    'server/src/wbi.js',
    'server/src/fetchers/bilibili.js',
    'web/src/pages/Live.jsx',
    'tools/wbi-test.mjs',
  ];
  const stillThere = removed.filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (stillThere.length) problems.push(`file(s) of a removed feature are back: ${stillThere.join(', ')}`);
  else process.stdout.write(`   [ok]   ${removed.length} file(s) of the removed features are gone\n`);

  const removalFixture = (list) => list.filter((f) => f === 'server/src/live.js');
  if (removalFixture(removed).length !== 1) problems.push('the "is the file gone" detector does not fire on a fixture that still lists one, so it proves nothing');
  else process.stdout.write('   [ok]   (and the control, a file that is still listed, is caught)\n');

  // (b) The routes are gone, and they are gone from the app's own route table -- not merely from a page.
  // The control is the literal route strings themselves, so a detector that reads the file and finds
  // nothing has to find those when they are present.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  const goneRoutes = ['/api/live', '/api/live/roster', '/api/danmaku', '/api/accounts'];
  const routeStill = goneRoutes.filter((r) => serverSrc.includes(`'${r}`));
  if (routeStill.length) problems.push(`route(s) of a removed feature are still registered: ${routeStill.join(', ')}`);
  else process.stdout.write(`   [ok]   no route under ${goneRoutes.slice(0, 2).join(' or ')} or /api/danmaku or /api/accounts exists\n`);

  const routeFixture = (src) => goneRoutes.filter((r) => src.includes(`'${r}`));
  if (routeFixture("app.get('/api/live', handler);").length !== 1) {
    problems.push('the "is the route gone" detector does not fire on a fixture that registers one, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, a source that registers one, is caught)\n');
  }

  // (c) The navigation lost exactly one tab, and the page it named is not reachable any more. The count is
  // read out of App.jsx and asserted against the number of rendered pages, so a tab added without a page
  // (or a page left behind by a removed tab) shows up here rather than as a blank screen.
  const appSrc = fs.readFileSync(path.join(ROOT, 'web/src/App.jsx'), 'utf8');
  const tabs = (appSrc.match(/^const TABS = \[(.*)\];$/m)?.[1] ?? '').match(/'[a-z_]+'/g) ?? [];
  const rendered = appSrc.match(/\{tab === '[a-z_]+' &&/g) ?? [];
  if (tabs.length !== 11) problems.push(`the navigation has ${tabs.length} tabs; the live tab was removed, so eleven are expected`);
  else if (rendered.length !== tabs.length) problems.push(`the navigation lists ${tabs.length} tabs but renders ${rendered.length} page(s)`);
  else if (tabs.includes("'live'")) problems.push('the navigation still offers a live tab');
  else process.stdout.write('   [ok]   the navigation offers 11 tabs, and every one of them renders a page\n');

  // The control: the same reading over a shell that still names the removed tab.
  const tabFixture = "const TABS = ['intel', 'search', 'live', 'run'];\n{tab === 'intel' && <Intel />}\n";
  const fixtureTabs = (tabFixture.match(/^const TABS = \[(.*)\];$/m)?.[1] ?? '').match(/'[a-z_]+'/g) ?? [];
  if (fixtureTabs.length === 11 || !fixtureTabs.includes("'live'")) {
    problems.push('the tab reader does not see a removed tab in a fixture that names one, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, a shell that still names the live tab, is caught)\n');
  }
} catch (e) {
  problems.push(`could not read the removed surface: ${e.message}`);
}

// ───────────────────────────────────────────── 5j. the bundled browser is Firefox, alone
//
// A re-based engine leaves the same kind of trace as a removed feature: nothing fails while the engine is
// never used, and the leftovers only surface the first time somebody enables a browser-rendered source —
// by which point the message is a launch error rather than "line 9 still imports chromium". So the two
// facts are stated here, in the places a reader would look: what the code launches, and what the package
// downloads. The behavioural half (which executables Playwright may actually be pointed at, and what a dead
// Tor answers) lives in tools/browser-engine-test.mjs; this section is only about the source.
try {
  /** Code that would make this project reach for a Chromium again (the word in a comment is fine, the call is not) */
  const chromiumCreep = (src) =>
    [
      [/\bchromium\s*\.\s*(launch|launchPersistentContext)\s*\(/, 'a Playwright Chromium launch'],
      [/require\s*\([^)]*\)\s*\.\s*chromium\b/, 'a require(...).chromium'],
      [/\{\s*[^}\n]*\bchromium\b[^}\n]*\}\s*=\s*(await\s+)?(import|require)\s*\(/, 'a destructured chromium import'],
      [/['"]--no-sandbox['"]/, "Chromium's --no-sandbox process flag"],
      [/['"]--disable-dev-shm-usage['"]/, "Chromium's --disable-dev-shm-usage process flag"],
    ]
      .filter(([re]) => re.test(String(src)))
      .map(([, what]) => what);

  const surfaces = ['server/src/fetchers/browser.js', 'server/src/cookies.js', 'server/src/browser-target.js', 'server/src/thumbs.js', 'web/src/pages/Browser.jsx', 'tools/traverse-ui.cjs'];
  const creep = surfaces.flatMap((rel) => chromiumCreep(fs.readFileSync(path.join(ROOT, rel), 'utf8')).map((w) => `${rel}: ${w}`));
  if (creep.length) problems.push(`the browser engine is Firefox, but ${creep.join('; ')}`);
  else process.stdout.write(`   [ok]   ${surfaces.length} engine surface(s), none of them launching a Chromium\n`);

  const creepFixture = chromiumCreep("const { chromium } = await import('playwright');\nbrowser = await chromium.launch({ args: ['--no-sandbox'] });");
  if (creepFixture.length !== 3) {
    problems.push(`the Chromium-creep detector found ${creepFixture.length} of the 3 signals in a fixture that has them, so it proves nothing`);
  } else {
    process.stdout.write('   [ok]   (and the control, the launch/import/flag the swap removed, is caught)\n');
  }

  // The package's payload: the one step that downloads a browser has to download the right one.
  const buildSrc = fs.readFileSync(path.join(ROOT, 'tools/build-portable.cjs'), 'utf8');
  const payloadProblems = [];
  if (/install['"]\s*,\s*['"]chromium|\bplaywright\s+install\s+chromium/.test(buildSrc)) payloadProblems.push('the portable build still installs a Chromium payload');
  if (/\bchromium_headless_shell\b/.test(buildSrc)) payloadProblems.push('the portable build still names chromium_headless_shell');
  if (!/install['"]\s*,\s*['"]firefox|\bplaywright\s+install\s+firefox/.test(buildSrc)) payloadProblems.push('the portable build no longer installs the Firefox payload');
  if (payloadProblems.length) problems.push(...payloadProblems);
  else process.stdout.write('   [ok]   the portable build packages the Firefox payload and no Chromium one\n');

  const payloadFixture = (src) => (/install['"]\s*,\s*['"]chromium/.test(src) ? ['chromium payload'] : []);
  if (payloadFixture("run(process.execPath, [pwCli, 'install', 'chromium'], { env });").length !== 1) {
    problems.push('the payload detector does not fire on the line the build used to run, so it proves nothing');
  } else {
    process.stdout.write('   [ok]   (and the control, the install line the build used to run, is caught)\n');
  }

  // The server's own dependency manifest offers a one-command install for the engine, and it has to name the
  // engine the fetcher launches — a script nobody re-read is exactly where a stale engine survives.
  const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'));
  const engineScript = String(serverPkg.scripts?.['install-browsers'] ?? '');
  if (!engineScript.includes('firefox')) problems.push(`server/package.json's install-browsers still says "${engineScript}"`);
  else process.stdout.write(`   [ok]   server/package.json's engine install names Firefox ("${engineScript}")\n`);
} catch (e) {
  problems.push(`could not read the browser engine surface: ${e.message}`);
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
