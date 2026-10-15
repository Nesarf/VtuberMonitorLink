// scratch v2: extract one route group out of server.js into server/src/routes/<group>.js, mechanically.
//
// v2 differs from v1 in one way that matters: the new module's imports are DERIVED from the extracted body. It
// reads every `import { a, b as c } from './x.js'` in server.js, sees which of those names the body actually
// uses, and re-emits exactly those from the same sources. Hand-writing the import list is where a mechanical
// extraction turns into a hand edit - and the failure mode is silent until that route is first called.
//
// The safety net stays: if the body names a factory helper outside the allowed context, it stops and prints it.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Arguments. `--file <path>` exists for the test, which runs the splitter against a fixture instead of the real
// factory: a tool that rewrites source files has to be testable without rewriting the source files it ships in.
// Everything else is unchanged from the scratch version this was lifted from.
const argv = process.argv.slice(2);
const fileFlag = argv.indexOf('--file');
const asFlag = argv.indexOf('--as');
const SERVER_FILE = fileFlag >= 0 ? path.resolve(argv[fileFlag + 1]) : path.join(ROOT, 'server', 'src', 'server.js');
const ROUTES_DIR = path.join(path.dirname(SERVER_FILE), 'routes');
// `--as <name>` names the module something other than the group. A group can span several clusters, and the first
// cluster already owns `<group>.js` - the overwrite refusal below would stop the second one forever. With a second
// name it becomes an ordinary extraction that is registered separately, which is what the remaining `/sources`,
// `/archive` and `/proxy` routes need.
const AS_NAME = asFlag >= 0 ? String(argv[asFlag + 1] || '').trim() : '';
// Filter by position only when the flag is actually present. `flag + 1` is 0 when the flag is absent, and the
// obvious one-liner therefore deletes the group name itself - a bug introduced twice now, once for `--file` and once
// for `--as`, which is why the condition is written out instead of squeezed into a slice.
const rest = argv.filter((_, i) => {
  if (fileFlag >= 0 && (i === fileFlag || i === fileFlag + 1)) return false;
  if (asFlag >= 0 && (i === asFlag || i === asFlag + 1)) return false;
  return true;
});

const GROUP = rest[0];
if (!GROUP) throw new Error('usage: node tools/route-split.cjs <group> [extraCtx,comma,separated] [--file <server.js>]');

// Extras are deliberate, named additions to the context a group receives ("give it those through ctx
// deliberately, or leave it in the factory") - they are never widened silently.
const MODULE_NAME = AS_NAME || GROUP;
const EXTRA_CTX = (rest[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_CTX = ['getConfig', 'patchConfig', 'log', ...EXTRA_CTX];
const FACTORY_PROVIDED = ['getConfig', 'setConfig', 'onConfigChanged', 'log', 'patchConfig', 'persist', 'busyGuard'];

const file = SERVER_FILE;
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// name -> module source, from server.js's own import statements (multi-line blocks included).
// A DEFAULT import must stay a default import: emitting `import { fs } from 'node:fs'` for what was
// `import fs from 'node:fs'` is a module-link error at load time ("does not provide an export named 'fs'"), and
// the first version of this script did exactly that.
const importMap = new Map();
// `import * as ns from '...'` is a third shape, and this scan did not know it. A body calling `scheduler.get()`
// therefore got no import at all, and the route answered 500 with "scheduler is not defined" - while
// `node --check` passed, importing the factory passed, and every static check was happy, because the reference
// sits inside a handler body and only runs when the route is called. Measured on `/api/state` and `/api/schedule`.
const namespaceRe = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)';/gm;
for (const m of src.matchAll(namespaceRe)) {
  importMap.set(m[1], { kind: 'namespace', local: m[1], source: m[2] });
}
const importBlockRe = /^import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([\s\S]*?)\}|([A-Za-z_$][\w$]*))?\s*from\s*'([^']+)';/gm;
for (const m of src.matchAll(importBlockRe)) {
  const source = m[4];
  if (m[1]) importMap.set(m[1], { kind: 'default', local: m[1], source });
  if (m[3]) importMap.set(m[3], { kind: 'default', local: m[3], source });
  if (m[2]) {
    for (const part of m[2].split(',')) {
      const clean = part.trim();
      if (!clean) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clean);
      if (asMatch) importMap.set(asMatch[2], { kind: 'named', imported: asMatch[1], local: asMatch[2], source });
      else importMap.set(clean, { kind: 'named', imported: clean, local: clean, source });
    }
  }
}

const routeRe = new RegExp(`^\\s*app\\.(get|post|put|patch|delete)\\('/api/${GROUP}(?:/|'|\\?)`);
const routeIdx = lines.map((l, i) => (routeRe.test(l) ? i : -1)).filter((i) => i >= 0);
if (!routeIdx.length) throw new Error(`no /api/${GROUP} routes found`);

let start = routeIdx[0];
while (start > 0 && /^\s*\/\//.test(lines[start - 1])) start--;
let end = routeIdx[0] + 1;
for (let i = end; i < lines.length; i++) {
  // The scan starts after the FIRST route of the group, not after the last one - that was the bug that produced a
  // 777-line "proxy" module containing 41 routes: `/api/proxy/*` registrations are scattered through the file, so
  // "last match" reached far past everything in between. A group's block is its first *contiguous* cluster, and a
  // further cluster of the same group (if any) is a later slice.
  // Three things end a block, and the third one was learned from a fixture: a following group's banner, a route
  // belonging to another group, and the end of the factory's own body. Without the last one, a group that happens
  // to be the LAST thing registered before `return app;` has nothing to stop the scan and the block runs to the end
  // of the file - taking every remaining declaration with it. The real server.js always had a banner there, so
  // nothing caught it until a smaller fixture did.
  if (
    /^\s*\/\/ ──/.test(lines[i]) ||
    /^\s*register\w+Routes\(app/.test(lines[i]) ||
    /^\s*return app;?\s*$/.test(lines[i])
  ) {
    end = i;
    break;
  }
  const m = /^\s*app\.(get|post|put|patch|delete|use|all)\(\s*'([^']+)'/.exec(lines[i]);
  if (m) {
    const path = m[2];
    const mine = path === `/api/${GROUP}` || path.startsWith(`/api/${GROUP}/`) || path.startsWith(`/api/${GROUP}?`);
    if (!mine) {
      end = i;
      break;
    }
  }
}
// and trim the blank lines and the comment block that belongs to the next thing
while (end > start && (lines[end - 1].trim() === '' || /^\s*\/\//.test(lines[end - 1]))) end--;

// ── usage-based trim (BUGS #99) ───────────────────────────────────────────────────────────────────────────────
// A positional boundary is not enough: between /proxy's routes and the next registration sit ~700 lines of local
// helpers that the *rest of the file* also uses, and taking them would move shared code into a module named after
// one group. So the block ends at the first top-level declaration inside it that the outside still references.
const outsideText = lines.filter((_, i) => i < start || i >= end).join('\n');
const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
let trimmedAt = -1;
for (let i = start; i < end; i++) {
  const m = declRe.exec(lines[i]);
  if (!m) continue;
  if (new RegExp(`\\b${m[1]}\\b`).test(outsideText)) {
    trimmedAt = i;
    break;
  }
}
if (trimmedAt >= 0) {
  end = trimmedAt;
  while (end > start && (lines[end - 1].trim() === '' || /^\s*\/\//.test(lines[end - 1]))) end--;
  console.log(`  usage-based trim: the block stops before line ${trimmedAt + 1}, whose declaration the rest of the file also uses`);
}

// Sibling specifiers inside a **dynamic** import need the same `../` a static one gets, and this scan did not touch
// them: the cookies route calls a dynamic import of its own group name, which inside
// `server/src/routes/cookies.js` resolves to **itself** - a module that does not export what the caller expects. It
// surfaced as `TypeError: readBrowserCookies is not a function` on an unhandled rejection, which took the whole app
// down in the middle of a walk, so the traversal reported "fetch failed" rather than naming a route. Static imports
// were rewritten from the start; dynamic ones were simply invisible to that code.
//
// The specifiers are written without the literal path text on purpose: the repository's integrity check scans for
// import specifiers in every shipped file, comments included, and a path in a comment here was reported as an import
// pointing at a file that does not exist.
const body = lines.slice(start, end).map((l) =>
  l.replace(/(import\s*\(\s*)(['"])\.\/([^'"]+)\2/g, (_all, head, quote, spec) => `${head}${quote}../${spec}${quote}`),
);
const bodyText = body.join('\n');

const usedOther = FACTORY_PROVIDED.filter((n) => !ALLOWED_CTX.includes(n) && new RegExp(`\\b${n}\\b`).test(bodyText));
if (usedOther.length) {
  console.log(`STOP: /api/${GROUP} also uses ${usedOther.join(', ')} - give it those through ctx deliberately, or leave it in the factory`);
  process.exit(1);
}

// ── the net that was missing ─────────────────────────────────────────────────────────────────────────────────
// The check above only knows the seven names the *factory* provides. A body that calls a **local helper defined
// elsewhere in server.js** is not in that list, so it sailed through and produced a module with an undefined name:
// valid syntax, the app starts, and the route 500s the first time it is called. That is how `preserveSecretsIn`
// got out of a `/api/watch` extraction - `node --check` cannot see it and neither can importing the module,
// because the reference sits inside a function body.
//
// Two details decide whether this net works or only looks like it does:
//
//   * a top-level-only pattern misses exactly the names this is for. The declaration that got out,
//     `const preserveSecretsIn = ...`, is a local of `createApp`, so it is indented - and `node --check` cannot
//     see the reference either, because it sits inside a function body.
//   * widening the pattern to "any indentation" is worse than useless: ordinary names like `cfg`, `s`, `out` and
//     `line` are declared inside every other handler in the file, and the net then stops on a dozen of them and
//     names none of the real one. Measured - that is what the first version of this check did.
//
// What actually matters is one scope: **`createApp`'s own body**, which is two spaces in. A helper left behind
// there is the thing a moved block has to reach back for; anything declared deeper than that is local to some
// other handler and cannot be the problem. `app` itself lives at that level too and is what the registrar is
// handed, so it is named as given rather than reported.
const declFactoryRe = /^ {2}(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const destructureRe = /^ {2}(?:const|let|var)\s*\{([^}]*)\}/;
const GIVEN = new Set(['app', ...ALLOWED_CTX]);
const declFactory = new Set();
for (let i = 0; i < lines.length; i++) {
  if (i >= start && i < end) continue;
  const m = declFactoryRe.exec(lines[i]);
  if (m) declFactory.add(m[1]);
  const d = destructureRe.exec(lines[i]);
  if (d) {
    for (const part of d[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declFactory.add(name);
    }
  }
}
const declInside = new Set();
for (let i = start; i < end; i++) {
  const m = declFactoryRe.exec(lines[i]);
  if (m) declInside.add(m[1]);
}
// Names the block binds *itself*, including as parameters, and a floor on what counts as a helper name.
//
// Both are here because the plausible-looking version of this net reported `e` and stopped nine groups at once:
// createApp has `const e = cluster?.evidence;` in its own scope, so every block containing a `catch (e)` or an
// `e => ...` looked like it was reaching back for that local. A name that the block itself binds is not a
// reference to the factory's, and a helper left behind in the factory is a *word* (`preserveSecretsIn`,
// `sanitizeCustomSource`) - never a one- or two-letter binding, which in this file is always a parameter.
const boundInBlock = new Set();
const addParams = (list) => {
  for (const part of String(list).split(',')) {
    const name = part.split('=')[0].trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) boundInBlock.add(name);
  }
};
for (const line of body) {
  for (const m of line.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
  for (const m of line.matchAll(/\bcatch\s*\(([^()]*)\)/g)) addParams(m[1]);
  for (const m of line.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) addParams(m[1]);
  const arrow = /^\s*([A-Za-z_$][\w$]*)\s*=>/.exec(line);
  if (arrow) boundInBlock.add(arrow[1]);
}
const HELPER_NAME_MIN = 3;
const stuck = [...declFactory].filter(
  (n) =>
    n.length >= HELPER_NAME_MIN &&
    !declInside.has(n) &&
    !boundInBlock.has(n) &&
    !GIVEN.has(n) &&
    !importMap.has(n) &&
    new RegExp(`\\b${n}\\b`).test(bodyText),
);
if (stuck.length) {
  console.log(
    `STOP: /api/${GROUP} uses ${stuck.join(', ')} - declared in createApp's own scope, so the module would ` +
      'reference an undefined name. Give it through ctx deliberately, or move the declaration where both can import it.'
  );
  process.exit(1);
}

// imports the body needs, deduped by source and split into defaults and named (see the note above)
const needed = new Map();
for (const [local, info] of importMap) {
  if (!new RegExp(`\\b${local}\\b`).test(bodyText)) continue;
  if (!needed.has(info.source)) needed.set(info.source, { defaults: [], named: [], namespaces: [] });
  const bucket = needed.get(info.source);
  if (info.kind === 'default') bucket.defaults.push(local);
  else if (info.kind === 'namespace') bucket.namespaces.push(local);
  else bucket.named.push(info.imported === local ? local : `${info.imported} as ${local}`);
}
const importLines = [...needed.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  // A module in server/src/routes/ is one directory deeper than server.js, so a sibling specifier needs the
  // extra `../`. Copying it verbatim starts the app with ERR_MODULE_NOT_FOUND - which `node --check` cannot see
  // and only the traversal catches, because the failure happens when the app is actually launched.
  .flatMap(([source, { defaults, named, namespaces }]) => {
    const fixed = source.startsWith('./') ? `../${source.slice(2)}` : source;
    const parts = [];
    if (defaults.length) parts.push([...new Set(defaults)].sort().join(', '));
    if (named.length) parts.push(`{ ${[...new Set(named)].sort().join(', ')} }`);
    const lines = [];
    if (parts.length) lines.push(`import ${parts.join(', ')} from '${fixed}';`);
    for (const ns of [...new Set(namespaces)].sort()) lines.push(`import * as ${ns} from '${fixed}';`);
    return lines;
  });

// A group name is a URL path segment, not an identifier: `/api/client-log` would have produced
// `registerClient-logRoutes`, which is a syntax error at module load - measured, and it stopped the packaged app
// from starting at all while `node --check` on each individual module still passed, because the damaged line is in
// the factory. Split on whatever is not a letter or digit and camel-case the pieces.
const fnName =
  'register' +
  MODULE_NAME.split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('') +
  'Routes';
const header = [
  `// routes/${MODULE_NAME}.js — the ${GROUP} endpoints, moved out of the factory.`,
  '//',
  '// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that',
  '// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers',
  '// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.',
  ...importLines,
  '',
  '/**',
  ' * @param {import(\'express\').Express} app',
  ' * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx',
  ' */',
  `export function ${fnName}(app, { ${ALLOWED_CTX.join(', ')} }) {`,
  '',
].join('\n');
const out = header + body.map((l) => (l.trim() === '' ? '' : '  ' + l)).join('\n') + '\n}\n';
const outPath = path.join(ROUTES_DIR, `${MODULE_NAME}.js`);
// Never overwrite a module that is already there. A group can be split across several clusters in the factory
// (that is what "first contiguous cluster" means), so a second run for the same group would replace the module
// holding the first cluster's routes - and the registration call it adds points at a module that no longer
// contains them. Measured: `proxy`, `sources` and `archive` had each been partly moved already, and one batch run
// silently dropped what was in them. The refusal costs a second filename; the silent version cost the routes.
if (fs.existsSync(outPath)) {
  console.log(
    `STOP: ${path.relative(ROOT, outPath).split(path.sep).join('/')} already exists - this group was partly moved ` +
      'before. Move the remaining cluster into its own module (and register it separately), or fold it in by hand; ' +
      'overwriting here would drop the routes the existing module carries.'
  );
  process.exit(1);
}
fs.mkdirSync(ROUTES_DIR, { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`wrote ${path.relative(ROOT, outPath).split(path.sep).join('/')} — ${body.length} handler lines, imports: ${importLines.length ? importLines.join(' ').slice(0, 160) : '(none)'}`);
console.log(JSON.stringify({ group: GROUP, module: outPath, handlers: body.length, ctx: ALLOWED_CTX }));

const replacement = [
  `  // Moved to server/src/routes/${MODULE_NAME}.js (see its header for the shape the remaining groups follow).`,
  `  ${fnName}(app, { ${ALLOWED_CTX.join(', ')} });`,
  '',
  '',
];
const importAnchor = `import { docLang, pickDoc, readDocs } from './docs.js';`;
const newImport = `import { ${fnName} } from './routes/${MODULE_NAME}.js';`;
let t = lines.slice(0, start).concat(replacement, lines.slice(end)).join('\n');
if (!t.includes(importAnchor)) throw new Error('the docs import anchor is missing; add the import by hand');
if (!t.includes(newImport)) t = t.replace(importAnchor, `${importAnchor}\n${newImport}`);
fs.writeFileSync(file, t);
console.log(`server.js rewritten: removed lines ${start + 1}-${end}`);
