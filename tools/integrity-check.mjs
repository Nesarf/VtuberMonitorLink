// integrity-check.mjs — 工程完整性自检 / project integrity check
//
// 为什么需要一个「完整性」检查，而不是只跑语法检查：
//   · `node --check` 只验证语法，**看不见不存在的标识符、看不见写错的 import 路径**
//     （这个项目真的踩过：`saveConfig` 根本不存在，语法检查全绿，一打接口就 500）
//   · 重构时最容易发生的是「文件改名了但别处还在 import 老路径」——运行时才炸
//   · 界面里 `t('xxx')` 写错一个字母，不会报错，只会把 `xxx` 原样显示给使用者
//
// 所以这里做四件事：
//   1) 解析所有源码的相对 import，逐个确认文件真的存在（含 .js/.jsx/index 解析）
//   2) 校验 package.json 里每个 script 引用的文件存在
//   3) 校验界面用到的每个 i18n key 都在词条里（中英键集合还要互相对齐）
//   4) 校验关键产物存在且非空（词条生成物、web 构建产物）
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

// ───────────────────────────────────────────── 1. 文件与 import 图

const CODE_EXT = ['.js', '.jsx', '.mjs', '.cjs'];
const files = [];
for (const d of ['server/src', 'server/scripts', 'web/src', 'tools', 'launcher', 'web']) {
  files.push(...walk(path.join(ROOT, d)).filter((f) => CODE_EXT.includes(path.extname(f))));
}
const fileSet = new Set(files.map((f) => path.resolve(f)));

process.stdout.write(`\n1. 源码文件\n   ${files.length} 个源文件\n`);

let emptyFiles = 0;
for (const f of files) {
  const st = fs.statSync(f);
  if (st.size === 0) {
    emptyFiles++;
    problems.push(`空文件（很可能是被截断/写坏）: ${rel(f)}`);
  }
}
if (!emptyFiles) process.stdout.write('   [ok]   没有 0 字节的源文件\n');

/** Node 的模块解析顺序：原样 → .js/.jsx/.mjs/.cjs → 目录下的 index.* */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return { external: true };
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const ext of CODE_EXT) candidates.push(base + ext);
  for (const ext of CODE_EXT) candidates.push(path.join(base, 'index' + ext));
  // web 里 import './x.js' 但实际是 x.jsx 的情况
  for (const ext of CODE_EXT) candidates.push(base.replace(/\.jsx?$/, '') + ext);
  for (const c of candidates) {
    // 用文件系统判断，而不是「在源码文件集合里」—— 后者只装了 .js/.jsx，
    // 于是真实存在的 .json / .css import 会被误报成「指向不存在的文件」（踩过）
    try {
      if (fs.statSync(c).isFile()) return { file: path.resolve(c) };
    } catch {
      /* 继续试下一个候选 */
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
process.stdout.write(`\n2. import 图\n   ${checked} 条 import，其中相对引用全部解析\n`);
if (missing) {
  for (const b of badImports.slice(0, 20)) problems.push(`import 指向不存在的文件: ${b}`);
  if (badImports.length > 20) problems.push(`……还有 ${badImports.length - 20} 条`);
} else {
  process.stdout.write('   [ok]   每条相对 import 都指向真实文件\n');
}

// ───────────────────────────────────────────── 2. package.json 的 script

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
process.stdout.write('\n3. package.json\n');
if (!pkg.name || !pkg.version) problems.push('package.json 缺少 name/version');
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/(?:node|node_modules\/\.bin\/\S+)?\s*((?:tools|server|launcher|web)[\\/][^\s"']+)/g)) {
    const target = m[1].replace(/\\/g, '/');
    if (!fs.existsSync(path.join(ROOT, target))) {
      problems.push(`script "${name}" 引用了不存在的文件: ${target}`);
    }
  }
}
process.stdout.write(`   [ok]   ${Object.keys(pkg.scripts ?? {}).length} 个 script 的引用都存在\n`);
if (pkg.type !== 'module') notes.push('package.json 的 type 不是 module（服务端用的是 ESM）');

// ───────────────────────────────────────────── 3. i18n key 一致性

process.stdout.write('\n4. i18n 词条\n');
const i18nPath = path.join(ROOT, 'web/src/i18n.jsx');
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
/**
 * 取出某一本字典的文本范围。
 * 注意不能「从 en 开始取到文件末尾」—— en 之后还有 I18nProvider 的返回对象，
 * 那样会把 weekdays / fmtDate / en-GB 这类运行期字段也当成词条键（踩过）。
 * 用「2 空格缩进的收尾 `},`」作为边界：嵌套对象的括号缩进更深，不会误判。
 */
function blockFor(which) {
  const startIdx = i18nSrc.indexOf(`  ${which}: {`);
  if (startIdx < 0) return '';
  const after = i18nSrc.slice(startIdx);
  const end = /\n  \},\n/.exec(after);
  return after.slice(0, end ? end.index : after.length);
}

/** 把字符串字面量的内容抹掉（保留引号位置），这样数花括号才不会被值里的 `{` 骗到 */
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
 * 只取字典**自身一层**的键。
 * 缩进判断不行 —— 词条拆行后会有 6 空格的键，而嵌套对象的键也是 6 空格。
 * 所以先抹掉字符串内容（值的正文里会出现 `{ title, body }` 这种），再按花括号深度走：
 * 深度为 1 的行才是这本字典的键。
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
process.stdout.write(`   zh ${zhKeys.size} 条 / en ${enKeys.size} 条\n`);
for (const k of zhKeys) if (!enKeys.has(k)) problems.push(`en 缺少词条: ${k}`);
for (const k of enKeys) if (!zhKeys.has(k)) problems.push(`zh 缺少词条: ${k}`);

// 界面里用到的 key 必须存在（写错一个字母不会报错，只会把 key 原样显示出来）
const used = new Map();
for (const f of files.filter((x) => x.includes(`${path.sep}web${path.sep}`))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) {
    if (!used.has(m[1])) used.set(m[1], rel(f));
  }
}
const unknown = [...used.entries()].filter(([k]) => !zhKeys.has(k));
process.stdout.write(`   界面用到 ${used.size} 个 key\n`);
if (unknown.length) {
  for (const [k, f] of unknown.slice(0, 25)) problems.push(`界面用到不存在的词条: ${k}（${f}）`);
  if (unknown.length > 25) problems.push(`……还有 ${unknown.length - 25} 个`);
} else {
  process.stdout.write('   [ok]   界面用到的每个 key 都有词条\n');
}

// ───────────────────────────────────────────── 4. 关键产物

process.stdout.write('\n5. 关键产物\n');
const genPath = path.join(ROOT, 'web/src/locales/generated.js');
if (!fs.existsSync(genPath)) problems.push('缺少 web/src/locales/generated.js（跑 node tools/i18n-hant.mjs）');
else {
  const sz = fs.statSync(genPath).size;
  if (sz < 20000) problems.push(`generated.js 只有 ${sz} 字节，疑似生成不完整`);
  else process.stdout.write(`   [ok]   繁体词条 ${(sz / 1024).toFixed(1)} KB\n`);
}
const bundle = path.join(ROOT, 'web/dist/index.html');
if (fs.existsSync(bundle)) process.stdout.write('   [ok]   web 构建产物存在（web/dist/index.html）\n');
else notes.push('web/dist 还没构建（发布前需要 npm run build）');

for (const f of ['README.md', 'LICENSE', 'docs/DESIGN.md', 'docs/PRIVACY.md', 'docs/RELEASE.md', 'launcher/launch.cjs']) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`缺少关键文件: ${f}`);
}
process.stdout.write(`   [ok]   关键文件齐全\n`);

// ───────────────────────────────────────────── 6. bug 表编号
//
// 我三次把「新增一行」写成「替换掉相邻那行」，导致 bug 表悄悄丢记录。
// 人会犯的错不该靠自觉避免 —— 让检查来抓。
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
    if (seen.has(n)) problems.push(`BUGS.md 编号重复: #${n}（第 ${seen.get(n)} 行与第 ${line} 行）`);
    seen.set(n, line);
  }
  const plain = [...new Set(nums.filter((x) => /^\d+$/.test(x.n)).map((x) => Number(x.n)))].sort((a, b) => a - b);
  // 把缺号折叠成区间：注入一个 #99 时不该列出 66 个孤立数字，而应报「20..98 缺失」
  const gaps = [];
  for (let i = 1; i < plain.length; i++) {
    if (plain[i] - plain[i - 1] > 1) gaps.push([plain[i - 1] + 1, plain[i] - 1]);
  }
  if (gaps.length) {
    const shown = gaps
      .slice(0, 5)
      .map(([a, b]) => (a === b ? '#' + a : `#${a}..#${b}`))
      .join(', ');
    problems.push(`BUGS.md 编号缺号: ${shown}${gaps.length > 5 ? ` 等 ${gaps.length} 段` : ''}（是不是把新增行写成了替换？）`);
  }
  if (!nums.length) notes.push('docs/BUGS.md 里没有解析到条目（表结构变了？）');
  else process.stdout.write(`   [ok]   bug 表 ${nums.length} 条，编号唯一且连续\n`);
}

// ───────────────────────────────────────────── 结果

process.stdout.write('\n6. 结果\n');
for (const n of notes) process.stdout.write('   note: ' + n + '\n');
if (problems.length) {
  for (const p of problems) process.stdout.write('   PROBLEM: ' + p + '\n');
  process.stdout.write(`\n${problems.length} 处问题。\n\n`);
  process.exit(1);
}
process.stdout.write('   文件完整性正常。\n\n');
