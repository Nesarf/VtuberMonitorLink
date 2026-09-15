// scripts/sanitize-check.mjs — pre-publish self-check: look for hard-coded paths and personal data leftovers.
// usage:  node server/scripts/sanitize-check.mjs   (or npm run sanitize-check)
//
// Design principle: nothing "specific to this machine" should ever enter the repository —
//   personal directories, user names, cookies, API keys, a particular proxy port, a particular machine path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MACHINE_LOCAL_FILES, RUNTIME_PATHS, TEXT_EXT, isAllowedLine, loadPrivateNames, mask, rulesFor } from './sanitize-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite', 'obj', 'bin', '__pycache__']);

// The rules, the extensions worth reading and the runtime paths all come from sanitize-rules.mjs, because the
// history scanner reads them too: a trace this scanner knows and that one does not is a trace that survives
// every check the project runs. Nothing here carries its own copy of them.
const RULES = rulesFor(ROOT);
const PRIVATE_NAMES = loadPrivateNames(ROOT);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p, out);
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);

/**
 * Everything git ignores is announced and **not scanned**.
 *
 * Why this is a rule rather than a convenience: the release copy carries what git tracks, so the content of a
 * gitignored file cannot reach anyone - yet the scan reported it as a finding, and no one running the check can
 * act on it. `config.json` holds a live API key by definition and `vdb/` holds a roster fetched from the
 * network; both are ignored, both were reported, and the check therefore could never be clean on a working
 * machine. A gate that can never be clean is a gate people learn to skim, which is exactly how a real leak
 * rides along. The presence is still said out loud - "there is machine-local data here" is worth knowing before
 * publishing - it is only the *content* that stops being a finding.
 */
function ignoredByGit(paths) {
  if (!paths.length) return new Set();
  try {
    // `-z` on both sides, and that is not decoration: without it git quotes any path containing a backslash and
    // prints it C-style (`"E:\\...\\vdb\\index.json"`), which on Windows is every path - so a set built from that
    // output matches nothing and the skip silently does not happen. NUL-separated output is unquoted and
    // unambiguous; measured by running the command by hand and looking at what it actually printed.
    const out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: ROOT,
      input: paths.join('\0') + '\0',
      encoding: 'utf8',
    });
    return new Set(out.split('\0').filter(Boolean).map((p) => path.resolve(ROOT, p)));
  } catch {
    // `git check-ignore` exits non-zero when nothing matched, and when there is no repository at all. Neither is
    // a reason to stop checking: without an answer, nothing is treated as ignored.
    return new Set();
  }
}
const IGNORED = ignoredByGit(files);

const findings = [];
const notices = [];
const SELF = 'sanitize-check.mjs';

// `isAllowedLine` comes from sanitize-rules.mjs: the history scanner applies the same exemptions, and two copies
// of "what counts as an example" would drift apart exactly the way the rules themselves would.

for (const file of files) {
  const rel = path.relative(ROOT, file);
  // The checker's own rule definitions necessarily contain these keywords, so skip self-scanning
  if (path.basename(file) === SELF) continue;
  if (IGNORED.has(path.resolve(file)) || MACHINE_LOCAL_FILES.has(path.basename(file))) {
    notices.push(`machine-local file present (gitignored, excluded from the release copy): ${rel}`);
    continue;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (isAllowedLine(line)) return;
      const m = rule.re.exec(line);
      if (m) findings.push({ file: rel, line: i + 1, rule: rule.id, desc: rule.desc, match: mask(m[0]) });
    });
  }
}

// Runtime data: its presence is normal (it is just runtime output), so it is reported as a notice, not a failure
for (const rp of RUNTIME_PATHS) {
  const p = path.join(ROOT, rp);
  if (fs.existsSync(p)) {
    const isDir = fs.statSync(p).isDirectory();
    notices.push(`runtime data present (just confirm it is not committed): ${rp}${isDir ? '/' : ''}`);
  }
}

console.log(`scanned ${files.length} text files\n`);
if (notices.length) {
  for (const n of notices) console.log(`ℹ️  ${n}`);
  console.log('');
}
if (findings.length === 0) {
  console.log('✅ no hard-coded paths or personal data found');
  process.exit(0);
}
for (const f of findings) {
  console.log(`⚠️  [${f.rule}] ${f.file}${f.line ? ':' + f.line : ''}  → ${f.match}\n     ${f.desc}`);
}
console.log(`\n${findings.length} finding(s) — review and clean before publishing`);
process.exit(1);
