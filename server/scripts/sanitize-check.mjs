// scripts/sanitize-check.mjs — 发布前自检：扫出硬编码路径与个人隐私残留
// Pre-publish self-check: look for hard-coded paths and personal data leftovers.
// 用法 / usage:  node server/scripts/sanitize-check.mjs   （或 npm run sanitize-check）
//
// 设计原则：任何「本机专属」的东西都不该进入仓库 ——
//   个人目录、用户名、cookie、API Key、特定代理端口、特定机型路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite']);
const TEXT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt']);
// 运行期数据目录本身不入库，但若被误提交也要报出来
const RUNTIME_PATHS = ['config.json', 'reports', 'feeds', 'logs'];

const RULES = [
  { id: 'home-path', desc: '个人主目录路径 / personal home paths', re: /[A-Z]:\\Users\\[^\\/"'\s]+/i },
  { id: 'specific-drive', desc: '写死的盘符绝对路径 / hard-coded absolute drive path', re: /(?<![A-Za-z])[A-Z]:\\[^\\/"'\s]{3,}/ },
  { id: 'api-key', desc: '疑似 API Key / possible API key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'cookie-blob', desc: '疑似 cookie 内容 / possible cookie blob', re: /(cf_clearance|SID=|sessionid=|__Secure-|auth_token)\s*[:=]/i },
];

// 私人名字/账号名**不写在本文件里**（否则本文件自己就成了泄漏源）。
// 改为从外部读取：环境变量 SANITIZE_NAMES，或仓库根目录的 .sanitize-names
// （每行一个、# 开头为注释，该文件已在 .gitignore 中）。
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
    desc: `私人名字/账号残留 / private name leftover (${PRIVATE_NAMES.length} configured)`,
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

/** 明显是文档示例/占位符的行，跳过 / skip lines that are clearly docs examples or placeholders */
function isExampleLine(line) {
  return /example|示例|placeholder|例如|之类|<[A-Za-z_-]+>|…|\.\.\./i.test(line);
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  // 检查器自身的规则定义必然包含这些关键字，跳过自扫
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

// 运行期数据：存在是正常的（就是运行产物），只作提示，不计为失败
for (const rp of RUNTIME_PATHS) {
  const p = path.join(ROOT, rp);
  if (fs.existsSync(p)) {
    const isDir = fs.statSync(p).isDirectory();
    notices.push(`运行期数据存在（确认未被提交即可）：${rp}${isDir ? '/' : ''}`);
  }
}

console.log(`扫描 ${files.length} 个文本文件 / scanned ${files.length} text files\n`);
if (notices.length) {
  for (const n of notices) console.log(`ℹ️  ${n}`);
  console.log('');
}
if (findings.length === 0) {
  console.log('✅ 未发现硬编码路径或隐私残留 / no hard-coded paths or personal data found');
  process.exit(0);
}
for (const f of findings) {
  console.log(`⚠️  [${f.rule}] ${f.file}${f.line ? ':' + f.line : ''}  → ${f.match}\n     ${f.desc}`);
}
console.log(`\n共 ${findings.length} 条，请人工确认后清理 / ${findings.length} finding(s) — review and clean before publishing`);
process.exit(1);
