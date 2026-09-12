// format-i18n.mjs — 修「两个键粘在同一行」/ glue-two-keys-on-one-line
//
// 背景：我在用编辑工具往 i18n.jsx 里插词条时，有几次 old_string 以换行结尾、
// 而替换内容没有，于是新键和后面原有的键被拼到了同一行：
//     llmFeat_probe: '站点测速 …',    tab_live: '直播',
// 语法上完全合法、界面也正常（键都在），但：
//   · 按行首匹配的检查/脚本会漏掉第二个键（完整性检查就是这么发现它的）
//   · diff 与 review 变得很难看
//
//   node tools/format-i18n.mjs        只检查（有问题则退出码 1）
//   node tools/format-i18n.mjs --fix  就地修好
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['web/src/i18n.jsx', 'web/src/locales/overlays.js', 'web/src/locales/index.js'];

// 一行里出现：字符串结尾 + 逗号 + ≥2 空格 + 一个「标识符:」→ 说明第二个键被粘上来了
const GLUED = /^(\s*)(.*?['"]),\s{2,}([A-Za-z_][A-Za-z0-9_]*\s*:.*)$/;

const fix = process.argv.includes('--fix');
let total = 0;
const lines = [];

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const parts = src.split(/\r?\n/);
  let hits = 0;
  const out = [];
  for (const line of parts) {
    // 注释行不动（注释里出现这种形状是正常的说明文字）
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
      out.push(line);
      continue;
    }
    const m = GLUED.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    hits++;
    lines.push(`${rel}: ${line.trim().slice(0, 100)}`);
    // 拆成两行，缩进沿用原行
    out.push(`${m[1]}${m[2]},`);
    out.push(`${m[1]}${m[3]}`);
  }
  if (hits && fix) fs.writeFileSync(abs, out.join('\n'), 'utf8');
  if (hits) total += hits;
  process.stdout.write(`  ${rel.padEnd(30)} ${hits} 处粘连${hits && fix ? '（已修）' : ''}\n`);
}

if (!total) {
  process.stdout.write('\n  没有粘连的键。\n');
  process.exit(0);
}
for (const l of lines) process.stdout.write('    ' + l + '\n');
if (!fix) {
  process.stdout.write(`\n${total} 处键被粘在同一行 —— 跑 node tools/format-i18n.mjs --fix 修好。\n`);
  process.exit(1);
}
process.stdout.write(`\n已修 ${total} 处。\n`);
