// locale-coverage.mjs — 各语言的实际覆盖度 / real per-locale coverage
//
// 为什么需要这个：说「加了 12 种语言」很容易，但**界面到底有多少是母语、多少是英文兜底**
// 才是有用的信息。缺键会静默回落到英文，使用者看到的是半英半母语的界面，
// 而没有任何地方会报错 —— 这种「看起来做完了」是最容易骗到自己的状态。
//
// 这个脚本把覆盖度算出来并**卡住下限**：
//   · 只统计「这个语言自己提供的」键，回落到英文的不算覆盖
//   · 覆盖度写进 web/src/locales/coverage.json 作为基线，以后掉下来就报错
//     （棘轮：覆盖度只能往上走，不会因为后来加功能悄悄退化）
//
//   node tools/locale-coverage.mjs            查看 + 与基线比对
//   node tools/locale-coverage.mjs --update   把当前值写成新基线
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, byCode } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'web/src/i18n.jsx');
const BASELINE = path.join(ROOT, 'web/src/locales/coverage.json');

/** 字符串字面量内容抹掉（同 integrity-check：数花括号不能被值里的 { 骗到）*/
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

function blockFor(src, which) {
  const startIdx = src.indexOf(`  ${which}: {`);
  if (startIdx < 0) return '';
  const after = src.slice(startIdx);
  const end = /\n  \},\n/.exec(after);
  return after.slice(0, end ? end.index : after.length);
}

function topLevelKeys(block) {
  const keys = new Set();
  let depth = 0;
  for (const raw of stripStrings(block).split(/\r?\n/)) {
    const m = depth === 1 && /^\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:/.exec(raw);
    if (m) keys.add(m[1] ?? m[2]);
    for (const ch of raw) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return keys;
}

const src = fs.readFileSync(I18N, 'utf8');
const zhKeys = topLevelKeys(blockFor(src, 'zh'));
const enKeys = topLevelKeys(blockFor(src, 'en'));

// 界面真正用到的 key（只统计这些才有意义：词条里的死键不算）
const CODE = ['.js', '.jsx'];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'locales'].includes(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (CODE.includes(path.extname(e.name))) files.push(path.join(dir, e.name));
  }
})(path.join(ROOT, 'web/src'));
const used = new Set();
for (const f of files) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
}
// 动态键：tab_<id> / calKind_<kind> / llmFeat_<key> 之类
const dynamicPrefixes = ['tab_', 'calKind_', 'llmFeat_', 'taskMode_', 'on_', 'freq_', 'field_', 'mode_', 'sort_'];
for (const k of enKeys) if (dynamicPrefixes.some((p) => k.startsWith(p))) used.add(k);

/** 复刻 i18n.jsx 的递归回落链 */
function resolveChain(code, seen = new Set()) {
  if (seen.has(code)) return [];
  seen.add(code);
  const loc = byCode(code);
  const parents = (loc?.chain ?? [code]).filter((c) => c !== code);
  const out = [];
  for (const p of parents) out.push(...resolveChain(p, seen));
  out.push(code);
  return out;
}

let GENERATED = {};
try {
  GENERATED = (await import(path.join(ROOT, 'web/src/locales/generated.js'))).GENERATED ?? {};
} catch {
  GENERATED = {};
}

/** 真正可用的回落链：只在**同一语言内**继承地区差异，跨语言不继承（见 i18n.jsx 注释） */
function usableChain(code) {
  const base = String(code).split('-')[0];
  return resolveChain(code).filter((c) => String(c).split('-')[0] === base);
}

/** 这个语言**自己**提供的键（不含最终回落到英文的那部分） */
function ownKeys(code) {
  const keys = new Set();
  // 英文本身与其拼写变体：不是「翻译」，而是基准语言
  // （en-GB/AU/CA 的拼写由 toBritish() 从 en 推导，整份都有，不该显示 0%）
  if (code.split('-')[0] === 'en') return enKeys;
  for (const c of usableChain(code)) {
    for (const layer of [HAND_COMMON[c], HAND[c], GENERATED[c]]) {
      if (!layer) continue;
      for (const k of Object.keys(layer)) keys.add(k);
    }
    // 简体是基准语言，它自己那本就够了；繁体由构建期从它整份生成
    if (c === 'zh' || c === 'zh-Hans') for (const k of zhKeys) keys.add(k);
  }
  return keys;
}

const total = used.size;
const rows = [];
for (const loc of LOCALES) {
  const own = ownKeys(loc.code);
  const covered = [...used].filter((k) => own.has(k)).length;
  rows.push({ code: loc.code, name: loc.name, covered, total, pct: total ? covered / total : 0 });
}
rows.sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code));

const bar = (p) => {
  const n = Math.round(p * 20);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};

process.stdout.write(`\n界面用到的词条: ${total} 个\n\n`);
for (const r of rows) {
  process.stdout.write(`  ${r.code.padEnd(9)} ${bar(r.pct)} ${String(Math.round(r.pct * 100)).padStart(3)}%  ${r.covered}/${r.total}  ${r.name}\n`);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
const update = process.argv.includes('--update');

if (update) {
  const out = { generatedAt: new Date().toISOString(), total, locales: Object.fromEntries(rows.map((r) => [r.code, r.covered])) };
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stdout.write(`\n已写入基线 / baseline written: ${path.relative(ROOT, BASELINE)}\n`);
  process.exit(0);
}

if (!baseline) {
  process.stdout.write('\n还没有基线 —— 跑 node tools/locale-coverage.mjs --update 建立。\n');
  process.exit(0);
}

// 棘轮：覆盖度不许下降（掉下来说明后来加的功能没跟上翻译）
const regressions = [];
for (const r of rows) {
  const was = baseline.locales?.[r.code];
  if (was === undefined) continue;
  if (r.covered < was) regressions.push(`${r.code}: ${was} → ${r.covered}`);
}
if (regressions.length) {
  process.stdout.write('\n覆盖度回退了 / coverage regressed:\n');
  for (const x of regressions) process.stdout.write('  - ' + x + '\n');
  process.stdout.write('\n（要么补词条，要么确认后跑 --update 更新基线）\n');
  process.exit(1);
}
process.stdout.write('\n覆盖度没有回退 ✓\n');
