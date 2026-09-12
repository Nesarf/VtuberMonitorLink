// hint-md-test.mjs — 回归守卫：**带 markdown 记号的文案必须在会渲染 markdown 的地方出现**
//
// 由来（BUGS #52，以及 #61 的复发）：提示语里写 `**粗体**`、而渲染处是纯文本 `{t('key')}`，
// 用户看到的就是字面上的两个星号。不报错、不白屏、巡检也照过 —— 典型的「有值但不好看」。
// #52 当时把出问题的六处改成了 <Inline>；#61 我又在新写的 `vdbHint` 里踩了同一个坑，
// 是校对工具拿占位符/记号平权（zh 有 `**`、en 没有）当**硬失败**抓出来的。
//
// 所以这里把它变成一条可自动跑的规则，而不是靠记性：
//   1. 从 i18n 源码里取出**值本身带 markdown 记号**（`**` / 反引号 / `[文字](链接)`）的键；
//   2. 找出界面里所有 `t('那个键')` 的调用点；
//   3. 每个调用点所在行必须同时出现 `<Inline`（或该文件里存在 `<Inline text={t('该键')}` 这种写法），
//      否则判失败。
//
// 这是**离线**断言：只读 web/src 的源码文本，不起服务、不联网。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readDicts } from './lib/i18n-source.mjs';

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    process.stdout.write(`  [ok]   ${name}${detail ? ' — ' + detail : ''}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}\n`);
  }
}

// ── 收集界面源码 ─────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (['.js', '.jsx'].includes(path.extname(e.name))) {
      files.push(path.join(dir, e.name));
    }
  }
})(path.join(ROOT, 'web/src'));

const MARKDOWN = /\*\*|`|\[[^\]\n]+\]\([^)\n]*\)/;

const { zh, en } = readDicts();
const marked = [...zh.entries()].filter(([, v]) => v && MARKDOWN.test(v));
check(
  '取到「值里带 markdown 记号」的键（数量不为 0 才算真的扫到了）',
  marked.length > 0,
  `${marked.length} 个：${marked.map(([k]) => k).join(', ')}`,
);

// 记号必须成对：一个孤零零的 `**` 一定是写错了
for (const [key, value] of marked) {
  const stars = (value.match(/\*\*/g) ?? []).length;
  if (stars % 2 !== 0) check(`${key} 的 ** 是成对的`, false, `${stars} 个`);
}

// ── 每个调用点都要在 Inline 里 ────────────────────────────────────
let sites = 0;
const offenders = [];
for (const [key, value] of marked) {
  const needle = new RegExp(`\\bt\\(\\s*'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*\\)`);
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!needle.test(line)) return;
      sites++;
      if (line.includes('Inline')) return; // 同行就有 <Inline text={t('key')} />
      offenders.push(`${rel}:${i + 1} ${key} → ${line.trim().slice(0, 70)}`);
    });
  }
}
check('真的扫到了调用点（否则这条断言等于没跑）', sites > 0, `${sites} 处`);
check(
  '带 markdown 记号的文案全部在 <Inline> 里渲染',
  offenders.length === 0,
  offenders.length ? `裸露 ${offenders.length} 处：\n         ` + offenders.join('\n         ') : `${sites} 处都在 Inline 里`,
);

// ── 反向：渲染成纯文本的地方不该出现记号（把 #61 那种情况正面挡住）─────
const plainSites = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/.exec(line);
    if (!m || line.includes('Inline')) return;
    const value = zh.get(m[1]);
    if (value && MARKDOWN.test(value)) plainSites.push(`${rel}:${i + 1} ${m[1]}`);
  });
}
check(
  '渲染成纯文本的 t() 调用点里没有带记号的文案',
  plainSites.length === 0,
  plainSites.length ? plainSites.join(', ') : '干净',
);

// ── 相邻一致性：en 记号和 zh 记号要一致（校对工具按占位符判，这里按 markdown 判）──
const mismatched = [];
for (const [key, value] of marked) {
  const e = en.get(key);
  if (e === undefined) continue; // 缺译由覆盖度工具管
  const zHas = MARKDOWN.test(value);
  const eHas = MARKDOWN.test(e);
  if (zHas !== eHas) mismatched.push(key);
}
check(
  'zh 与 en 的 markdown 记号一致（#61 就是这里不平权）',
  mismatched.length === 0,
  mismatched.length ? mismatched.join(', ') : '一致',
);

process.stdout.write(`\n${pass}/${pass + failures.length} checks passed\n`);
if (failures.length) {
  process.stdout.write(`失败 / failed:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
