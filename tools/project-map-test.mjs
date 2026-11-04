// project-map-test.mjs — does docs/PROJECT-MAP.md still describe this tree?
//
// The map is a navigational document: it says where things are and who owns what. That makes it a claim
// about the tree, and a claim that nothing checks decays into a comfortable lie - it is read precisely by
// the person who cannot yet tell whether it is still true.
//
// The design point worth stating: **the expectations are parsed out of the map, not hard-coded here.** A
// test that carried its own copy of "50 modules" would fail the moment the tree changed even if the map had
// been updated correctly, and a copy nobody remembers to edit is how the check itself expires. So this file
// reads what the map asserts and compares it with what the tree measures. Only the *shape* of each sentence
// is fixed here; the numbers live in one place, in the document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAP = path.join(ROOT, 'docs', 'PROJECT-MAP.md');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

// Count what the *repository* contains, not what this checkout happens to hold. The difference is real and
// it bit this suite on its first CI run: `web/src` has 56 files on a developer machine and 38 in a fresh
// checkout, because `web/src/locales/.cache/` is a gitignored translation cache. A map describes the
// repository, so the numbers have to come from the repository.
const committed = (prefix) =>
  execFileSync('git', ['ls-files', prefix], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
/** files committed under a prefix, at any depth */
const committedUnder = (prefix) => committed(prefix).length;
/** committed files directly under a prefix, optionally by extension */
const committedTop = (prefix, ext) =>
  committed(prefix).filter((p) => {
    const rest = p.slice(prefix.length + 1);
    return !rest.includes('/') && (!ext || p.endsWith(ext));
  }).length;
const map = fs.readFileSync(MAP, 'utf8');
// Markdown wraps prose at ~100 columns, so a claim can straddle two lines. Every pattern below matches
// against lat, which is the map with its whitespace collapsed - otherwise a rewrapped paragraph would
// silently stop matching and the test would fail for a formatting reason rather than a factual one.
const flat = map.replace(/\s+/g, ' ');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const listing = (d, filter) => {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true })
    .filter((e) => (filter === 'dir' ? e.isDirectory() : e.isFile()))
    .map((e) => e.name);
};

/** Pull a number out of the map by the sentence that states it, and fail loudly when that sentence is gone. */
const claim = (re, what) => {
  const m = re.exec(flat);
  if (!m) throw new Error(`the map no longer states ${what}, so this check has nothing to compare against`);
  return Number(m[1]);
};

// ── the numbers the map states in its opening paragraph
t('the opening sentence still states every count it used to', () => {
  const m = /`server\/src` holds \*\*(\d+) top-level modules and (\d+) route modules\*\*/.exec(flat);
  assert.ok(m, 'the opening count sentence is gone from the map');
  assert.equal(Number(m[1]), committedTop('server/src', '.js'), 'top-level module count differs from the repository');
  assert.equal(Number(m[2]), committedTop('server/src/routes', '.js'), 'route module count differs from the repository');
});

t('the web file count matches', () => {
  const want = claim(/`web\/src` holds (\d+) files/, 'the web/src file count');
  const got = committedUnder('web/src');
  assert.equal(got, want, `the map says ${want} files under web/src, the repository has ${got}`);
});

t('the tools script count matches', () => {
  const want = claim(/`tools` holds (\d+) scripts/, 'the tools script count');
  const scripts = committed('tools').filter((p) => !p.slice('tools'.length + 1).includes('/') && /\.(mjs|cjs|js)$/.test(p)).length;
  assert.equal(scripts, want, `the map says ${want} scripts in tools, the repository has ${scripts}`);
  const lib = claim(/plus (\d+) in `tools\/lib`/, 'the tools/lib count');
  assert.equal(committedUnder('tools/lib'), lib, 'the tools/lib count differs');
});

t('the document count matches', () => {
  const want = claim(/`docs` holds (\d+) files|holds (\d+)\s+documents/, 'the docs count') ?? null;
  const docs = committed('docs').filter((p) => p.endsWith('.md')).length;
  if (want === null) {
    // the map may not spell the docs count out; that is not a failure, only an absent claim
    process.stdout.write('         (the map does not state a document count, so nothing to compare)\n');
  } else {
    assert.equal(docs, want, `the map says ${want} documents, the tree has ${docs}`);
  }
});

t('server.js line counts match both conventions the map names', () => {
  const src = read('server/src/server.js');
  const lines = src.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const nonBlank = lines.filter((l) => l.trim() !== '').length;
  const m = /`server\.js` is\s*(\d+) lines,\s*(\d+) of them non-blank/.exec(flat);
  assert.ok(m, 'the map no longer states both line counts for server.js');
  assert.equal(lines.length, Number(m[1]), `the map says ${m[1]} total lines, the file has ${lines.length}`);
  assert.equal(nonBlank, Number(m[2]), `the map says ${m[2]} non-blank lines, the file has ${nonBlank}`);
});

t('the factory still registers no /api route of its own, as the map states', () => {
  assert.match(flat, /registers \*\*no `\/api\/\*` route of its own\*\*/, 'the map no longer makes that claim');
  const n = read('server/src/server.js').split(/\r?\n/).filter((l) => /app\.(get|post|put|patch|delete)\(\s*['"`]\/api\//.test(l)).length;
  assert.equal(n, 0, `server.js registers ${n} /api route(s) of its own, so the route layer is no longer complete`);
});

// ── the worker layer: counts and the capability matrix
t('the worker counts match the registry', () => {
  const reg = JSON.parse(read('workers/registry.json'));
  const m = /\*\*(\d+) implementations across (\d+) languages\*\*/.exec(flat);
  assert.ok(m, 'the map no longer states the worker counts');
  assert.equal(Number(m[1]), reg.workers.length, 'the implementation count differs from registry.json');
  assert.equal(Number(m[2]), new Set(reg.workers.map((w) => w.language)).size, 'the language count differs from registry.json');
});

t('every capability count in the map table matches the registry', () => {
  const reg = JSON.parse(read('workers/registry.json'));
  const counts = new Map();
  for (const w of reg.workers) for (const c of w.capabilities) counts.set(c, (counts.get(c) ?? 0) + 1);
  // the table rows look like: | `text.normalize` / `text.extract` / `text.fingerprint` | cpp, csharp, ... (9) |
  const rows = [...map.matchAll(/^\| ([^|]*`[a-z.]+\.[a-z]+`[^|]*) \| ([^|]*) \|$/gm)];
  assert.ok(rows.length >= 4, `the map's capability table has ${rows.length} rows, too few to be the matrix`);
  for (const [, caps, impls] of rows) {
    const names = [...caps.matchAll(/`([a-z]+\.[a-z]+)`/g)].map((x) => x[1]);
    const listed = impls.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !/^\(\d+\)$/.test(s));
    for (const name of names) {
      assert.equal(
        counts.get(name) ?? 0,
        listed.length,
        `the map lists ${listed.length} implementation(s) for ${name}, registry.json declares ${counts.get(name) ?? 0}`,
      );
    }
  }
});

// ── every module the map names must exist, and every module that exists must be named
t('every module under server/src is named somewhere in the map', () => {
  const named = new Set([...map.matchAll(/`([a-z][a-z0-9-]*)\.js`/g)].map((m) => m[1]));
  const missing = listing('server/src').filter((n) => n.endsWith('.js')).map((n) => n.replace(/\.js$/, '')).filter((m) => !named.has(m));
  assert.deepEqual(missing, [], `these modules exist but the map never mentions them: ${missing.join(', ')}`);
});

t('control: a module the map does not name would be reported (the check above is not vacuous)', () => {
  const named = new Set([...map.matchAll(/`([a-z][a-z0-9-]*)\.js`/g)].map((m) => m[1]));
  assert.ok(!named.has('definitely-not-a-module'), 'the name extractor is matching things it should not');
  // and prove the shape it looks for is the shape the file names actually use
  assert.ok(named.has('server'), 'the extractor failed to find a module that is certainly named');
});

// ── the paths the map points at
t('every path the map points at exists', () => {
  const paths = [
    ...new Set([...map.matchAll(/`((?:docs|launcher|workers|tools)\/[A-Za-z0-9._\/-]+)`/g)].map((m) => m[1])),
  ];
  const missing = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(missing, [], `the map points at paths that do not exist: ${missing.join(', ')}`);
});

// The route index is the map's sibling and carries the same risk: it was written while the split was half
// done, so it said "moved so far" and listed nine groups long after there were forty-five. A document that
// describes a migration is exactly the document nobody re-reads once the migration finishes.
t('the route index agrees with the route modules it indexes', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SERVER-ROUTES.md'), 'utf8').replace(/\s+/g, ' ');
  const m = /All (\d+) groups live in/.exec(doc);
  assert.ok(m, 'SERVER-ROUTES.md no longer states how many groups there are, so this check has nothing to compare');
  const actual = committedTop('server/src/routes', '.js');
  assert.equal(Number(m[1]), actual, `SERVER-ROUTES.md says ${m[1]} groups, the tree has ${actual}`);
  assert.match(doc, /registers \*\*no `\/api\/\*` route of its own\*\*/, 'SERVER-ROUTES.md no longer states the property that makes the split complete');
});

process.stdout.write(`\nproject map: ${pass} ok, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
