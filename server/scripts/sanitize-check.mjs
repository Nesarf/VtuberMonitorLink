// scripts/sanitize-check.mjs — pre-publish self-check: look for hard-coded paths and personal data leftovers.
// usage:  node server/scripts/sanitize-check.mjs   (or npm run sanitize-check)
//
// Design principle: nothing "specific to this machine" should ever enter the repository —
//   personal directories, user names, cookies, API keys, a particular proxy port, a particular machine path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite', 'obj', 'bin', '__pycache__']);
const TEXT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt']);
// The runtime data directories are not tracked, but if one is committed by mistake it must be reported
const RUNTIME_PATHS = ['config.json', 'reports', 'feeds', 'logs'];

const RULES = [
  { id: 'home-path', desc: 'personal home paths / 个人主目录路径', re: /[A-Z]:\\Users\\[^\\/"'\s]+/i },
  { id: 'specific-drive', desc: 'hard-coded absolute drive path / 写死的盘符绝对路径', re: /(?<![A-Za-z])[A-Z]:\\[^\\/"'\s]{3,}/ },
  // The same path as it exists inside a JSON file: escaping doubles every backslash, so the rule above
  // needs a single backslash followed by a non-backslash and walks straight past the escaped form. That
  // is not a corner case - every machine path in a .json is written that way - and it was found by
  // pointing the release copy's scanner at a directory whose only content was the machine-local worker
  // overlay and getting "clean" back. The exemptions are the same ones the rule above carries (standard
  // OS locations, escape sequences) plus the placeholder path the docs tell people to fill in, which
  // exists across the locale files only in its escaped form.
  {
    id: 'escaped-drive',
    desc: 'hard-coded drive path with escaped backslashes, as in JSON / 被转义的写死盘符路径',
    re: /(?<![A-Za-z\\])[A-Z]:\\\\(?!(Windows|Program Files|ProgramData|Users|temp|Temp|System32|YourCache)\b)(?!(?:n|t|r|b|f|v|0|u|x)(?![A-Za-z0-9_.-]{2,}))[^\\/"'\s]{2,}/,
  },
  { id: 'api-key', desc: 'possible API key / 疑似 API Key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'cookie-blob', desc: 'possible cookie blob / 疑似 cookie 内容', re: /(cf_clearance|SID=|sessionid=|__Secure-|auth_token)\s*[:=]/i },
];

// Machine-local files: gitignored on purpose, named in the release exclusions (tools/make-release.mjs),
// and full of the paths of this one computer. Their content is not a leak because it goes nowhere, but
// their presence is worth saying out loud - so they are reported as a notice rather than scanned.
const MACHINE_LOCAL_FILES = new Set(['registry.local.json']);

// Private names / account names are deliberately NOT hard-coded in this file: the file would
// itself become the leak. They are read from outside instead — $SANITIZE_NAMES, or a
// `.sanitize-names` file in the repo root (one per line, `#` starts a comment; gitignored).
// Private names are deliberately NOT hard-coded here: this file would itself
// become the leak. They come from $SANITIZE_NAMES or a gitignored .sanitize-names.
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPrivateNames() {
  const names = [];
  const env = process.env.SANITIZE_NAMES;
  if (env) names.push(...env.split(','));
  try {
    const file = path.join(ROOT, '.sanitize-names');
    if (fs.existsSync(file)) names.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
  } catch {
    /* ignore */
  }
  return [...new Set(names.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('#')))];
}

const PRIVATE_NAMES = loadPrivateNames();
if (PRIVATE_NAMES.length) {
  RULES.push({
    id: 'private-name',
    desc: `private name leftover / 私人名字/账号残留 (${PRIVATE_NAMES.length} configured)`,
    re: new RegExp(PRIVATE_NAMES.map(escapeRe).join('|'), 'i'),
  });
}

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

/** Skip lines that are clearly docs examples or placeholders */
function isExampleLine(line) {
  return /example|示例|placeholder|例如|之类|<[A-Za-z_-]+>|…|\.\.\./i.test(line);
}

/**
 * A line may also exempt itself with `sanitize-allow`, for the cases a pattern cannot tell apart from a
 * leak: a synthetic drive path in a test fixture is not this machine's, and the alternative is a rule
 * loose enough to miss the real ones. The marker is a comment, so it stays visible at the call site.
 */
const isAllowedLine = (line) => isExampleLine(line) || line.includes('sanitize-allow');

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
      if (m) findings.push({ file: rel, line: i + 1, rule: rule.id, desc: rule.desc, match: m[0].slice(0, 60) });
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
