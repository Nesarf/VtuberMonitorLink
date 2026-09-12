// scripts/sanitize-check.mjs — pre-publish self-check: look for hard-coded paths and personal data leftovers.
// usage:  node server/scripts/sanitize-check.mjs   (or npm run sanitize-check)
//
// Design principle: nothing "specific to this machine" should ever enter the repository —
//   personal directories, user names, cookies, API keys, a particular proxy port, a particular machine path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite']);
const TEXT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt']);
// The runtime data directories are not tracked, but if one is committed by mistake it must be reported
const RUNTIME_PATHS = ['config.json', 'reports', 'feeds', 'logs'];

const RULES = [
  { id: 'home-path', desc: 'personal home paths / 个人主目录路径', re: /[A-Z]:\\Users\\[^\\/"'\s]+/i },
  { id: 'specific-drive', desc: 'hard-coded absolute drive path / 写死的盘符绝对路径', re: /(?<![A-Za-z])[A-Z]:\\[^\\/"'\s]{3,}/ },
  { id: 'api-key', desc: 'possible API key / 疑似 API Key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'cookie-blob', desc: 'possible cookie blob / 疑似 cookie 内容', re: /(cf_clearance|SID=|sessionid=|__Secure-|auth_token)\s*[:=]/i },
];

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
const findings = [];
const notices = [];
const SELF = 'sanitize-check.mjs';

/** Skip lines that are clearly docs examples or placeholders */
function isExampleLine(line) {
  return /example|示例|placeholder|例如|之类|<[A-Za-z_-]+>|…|\.\.\./i.test(line);
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  // The checker's own rule definitions necessarily contain these keywords, so skip self-scanning
  if (path.basename(file) === SELF) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (isExampleLine(line)) return;
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
