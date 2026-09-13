// vml-brand.mjs — naming rule + coverage report for the project's two names.
//
// The rule (decided with the maintainer, and the reason this file exists rather than a convention
// living in someone's head):
//
//   * **`VtuberMonitorLink` / `Vtuber's Monitor Link`** — the project's name, and the names of the
//     files a user actually handles: the single-file executable, the release zip, the folder they
//     unzip, the window/console title, the report footers. Those are read by humans and must say
//     the full name.
//   * **`VML`** — every internal identifier the user never types: npm package names, environment
//     variables, localStorage keys, temp/port/cache file names, service identifiers. Internal
//     files are numerous, so they get the short brand (it also saves bytes and keystrokes).
//
// Anything in between (a log line, a comment, a doc) follows the *artifact* it talks about.
//
// Usage:
//   node tools/vml-brand.mjs            check + print coverage (exit 1 on a violation)
//   node tools/vml-brand.mjs --json     machine-readable
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LONG = 'VtuberMonitorLink';
const LONG_DISPLAY = "Vtuber's Monitor Link";

/** User-facing artifacts: these MUST carry the long name. */
const USER_FACING = [
  // NOTE for whoever edits this file: the release sanitizer's "absolute drive path" rule matches a
  // letter, a colon and then a backslash followed by two or more characters. A regex source that
  // spells a whitespace quantifier right after a colon contains exactly that shape, which aborts the
  // release build. Quantifiers following a colon are therefore written as a character class below,
  // never as the backslash-s form.
  { what: 'executable name (build default)', file: 'tools/build-portable.cjs', must: /\bname:[ \t]*'VtuberMonitorLink'/ },
  { what: 'release zip name', file: 'tools/make-release.mjs', must: /`VtuberMonitorLink-\$\{version\}-win-x64\.zip`/ },
  { what: 'package folder used by the build', file: 'tools/build-portable.cjs', must: /dist\/VtuberMonitorLink|'VtuberMonitorLink'/ },
  { what: 'page title', file: 'web/index.html', must: /<title>Vtuber's Monitor Link<\/title>/ },
  { what: 'in-app title (zh + en)', file: 'web/src/i18n.jsx', must: /appTitle: "Vtuber's Monitor Link"/ },
  { what: 'launcher banner', file: 'launcher/launch.cjs', must: /const NAME = "Vtuber's Monitor Link"/ },
  { what: 'report footer', file: 'server/src/reports.js', must: /Vtuber's Monitor Link/ },
];

/** Internal identifiers: these MUST use the short brand. */
const INTERNAL = [
  { what: 'root npm package name', file: 'package.json', must: /"name":[ \t]*"vml"/ },
  { what: 'server package name', file: 'server/package.json', must: /"name":[ \t]*"vml-server"/ },
  { what: 'web package name', file: 'web/package.json', must: /"name":[ \t]*"vml-web"/ },
  { what: 'VDB User-Agent suffix', file: 'server/src/vdb.js', must: /software:[ \t]*'VML'/ },
  { what: 'theme storage key', file: 'web/src/i18n.jsx', must: /vml-theme/ },
  { what: 'language storage key', file: 'web/src/i18n.jsx', must: /vml-lang/ },
  { what: 'temp dir env var', file: 'server/src/cookies.js', must: /VML_TEMP_DIR/ },
  { what: 'mock vision port file', file: 'tools/mock-vision.cjs', must: /vml-mock-vision-port\.txt/ },
  { what: 'vdb cache tarball assertion env', file: 'tools/vdb-test.mjs', must: /VML_VDB_TARBALL/ },
];

/** File names that must never carry the LONG name (internal artefacts). */
const NO_LONG_IN = [
  { what: 'npm package names', files: ['package.json', 'server/package.json', 'web/package.json'] },
  { what: 'local storage / env identifiers', files: ['web/src/i18n.jsx', 'server/src/cookies.js'] },
];

export function check() {
  const problems = [];
  const notes = [];

  for (const row of USER_FACING) {
    const src = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    if (!row.must.test(src)) problems.push(`user-facing artifact not on the long name: ${row.what} (${row.file})`);
  }
  for (const row of INTERNAL) {
    const src = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    if (!row.must.test(src)) problems.push(`internal identifier not VML-branded: ${row.what} (${row.file})`);
  }
  for (const row of NO_LONG_IN) {
    for (const f of row.files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // package.json's `description` legitimately names the product; the `name` field may not.
      const stripped = src.replace(/"description":[\s\S]*?"[^"]*"/g, '""');
      if (new RegExp(`"name":[ \\t]*"[^"]*${LONG}`).test(stripped)) {
        problems.push(`internal identifier still carries the long name: ${f}`);
      }
    }
  }

  // Coverage: how many of the identifiers we care about are branded the right way.
  const internalOk = INTERNAL.filter((r) => r.must.test(fs.readFileSync(path.join(ROOT, r.file), 'utf8'))).length;
  const userOk = USER_FACING.filter((r) => r.must.test(fs.readFileSync(path.join(ROOT, r.file), 'utf8'))).length;

  // Extra report (not a failure): where the long name still appears, by file.
  const longNameByFile = {};
  const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'reports', 'feeds', 'logs', 'watch', 'thumbs', 'advice', 'vdb', '.cache', 'pw-browsers', 'coverage', '.vite']);
  let scanned = 0;
  (function walk(d, rel = '') {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/\.(js|mjs|cjs|jsx|json|md|txt|html)$/.test(e.name)) {
        scanned++;
        const hits = (fs.readFileSync(path.join(d, e.name), 'utf8').match(new RegExp(LONG, 'g')) ?? []).length
          + (fs.readFileSync(path.join(d, e.name), 'utf8').match(new RegExp(LONG_DISPLAY.replace(/'/g, "\\'"), 'g')) ?? []).length;
        if (hits) longNameByFile[r] = hits;
      }
    }
  })(ROOT);

  notes.push(`scanned ${scanned} text files`);
  notes.push(`long name appears in ${Object.keys(longNameByFile).length} files (user-facing text: expected)`);
  notes.push('the two names must not swap roles: user-run artefacts stay long, internal identifiers stay short');

  return {
    problems,
    notes,
    coverage: {
      internalVmlBranded: `${internalOk}/${INTERNAL.length}`,
      userFacingLongName: `${userOk}/${USER_FACING.length}`,
    },
    longNameByFile: Object.entries(longNameByFile).sort((a, b) => b[1] - a[1]),
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const res = check();
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    process.stdout.write('\nvml-brand: naming rule\n');
    process.stdout.write(`  internal identifiers VML-branded : ${res.coverage.internalVmlBranded}\n`);
    process.stdout.write(`  user-facing artefacts on the long name : ${res.coverage.userFacingLongName}\n`);
    process.stdout.write(`  ${res.notes.join('\n  ')}\n`);
    if (args.includes('--list')) {
      for (const [f, n] of res.longNameByFile) process.stdout.write(`    ${String(n).padStart(3)}  ${f}\n`);
    }
    if (res.problems.length) {
      process.stdout.write('\n  PROBLEMS:\n');
      for (const p of res.problems) process.stdout.write(`    - ${p}\n`);
      process.exit(1);
    }
    process.stdout.write('  naming is consistent ✓\n');
  }
}
