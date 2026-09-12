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
import { usableChain } from './lib/locale-chain.mjs';
import { readDicts } from './lib/i18n-source.mjs';
import { looksUntranslated, humanKeys } from './i18n-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'web/src/i18n.jsx');
const BASELINE = path.join(ROOT, 'web/src/locales/coverage.json');

/**
 * 词条解析统一走 tools/lib/i18n-source.mjs（唯一实现）。
 * 这里原先自己写了一份 stripStrings/blockFor/topLevelKeys/zhValueLengths ——
 * 于是「管线认得的词条」和「覆盖度统计的词条」可以不一样，正是漏译藏身的地方。
 */
const dicts = readDicts(fs.readFileSync(I18N, 'utf8'));
const zhKeys = new Set(dicts.zh.keys());
const enKeys = new Set(dicts.en.keys());

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

/**
 * 「本来就不用翻」的键：简中原文与英文**逐字相同**（品牌名与缩写，如 LLM / API Key）。
 * 它们在每种语言里都显示同一个字符串，算进分母只会制造永远补不齐的缺口
 * （每个语言都显示 563/565，看起来像漏了 2 条，其实是这 2 条不需要翻译）。
 * 判据取自源码本身，不另立一份「豁免清单」——清单会漂移，源码不会。
 */
const LANG_NEUTRAL = new Set(
  [...used].filter((k) => {
    const v = dicts.zh.get(k);
    return !!v && v === dicts.en.get(k);
  }),
);
const localizable = [...used].filter((k) => !LANG_NEUTRAL.has(k));
const langNeutral = [...LANG_NEUTRAL].sort();

/**
 * 回落链由 tools/lib/locale-chain.mjs 提供（唯一实现，翻译管线也用同一份）。
 * 这里原先自己「复刻」了一遍 i18n.jsx 的逻辑，于是和 humanKeys 漂移成了两套语义。
 */

let GENERATED = {};
try {
  GENERATED = (await import(path.join(ROOT, 'web/src/locales/generated.js'))).GENERATED ?? {};
} catch {
  GENERATED = {};
}

// 机器译文层（可选）：tools/i18n-translate.mjs 的产物。它**算作「已本地化」**——
// 对使用者来说「有日语译文」和「是人工写的」不改变界面体验；分开统计只是为了知道
// 哪些还需要人工复核（--review 就是干这个的）。
let MACHINE = {};
try {
  MACHINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/machine.json'), 'utf8'));
} catch {
  MACHINE = {};
}

// 术语表：既给「有意保留原文」当豁免依据，也交给管线的判据函数
let GLOSSARY = {};
try {
  GLOSSARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/locales/glossary.json'), 'utf8'));
} catch {
  GLOSSARY = {};
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
  // 机器译文也算「这个语言自己的」——它直接决定使用者看到什么
  for (const c of [code, ...usableChain(code)]) {
    const m = MACHINE[c];
    if (m) for (const k of Object.keys(m)) keys.add(k);
  }
  return keys;
}

const total = localizable.length;
const rows = [];
for (const loc of LOCALES) {
  const own = ownKeys(loc.code);
  const covered = localizable.filter((k) => own.has(k)).length;
  // 「有值」不等于「翻好了」：机翻漏译会留下汉字原文。日语例外（汉字是正常书写）。
  // 判据直接用管线里的那一个函数 —— 这里原先复制了一份，连「先剔长词还是短词」都不一样。
  // 被人图层压住的机器词条不算：它**不会显示**，报出来只会让人去修一条看不见的东西。
  const mach = MACHINE[loc.code] ?? (loc.code.split('-')[0] === 'en' ? {} : null);
  const shadowed = humanKeys(loc.code);
  let suspicious = 0;
  if (mach) {
    for (const [k, v] of Object.entries(mach)) {
      if (shadowed.has(k)) continue;
      if (looksUntranslated(v, loc.code, GLOSSARY)) suspicious++;
    }
  }
  rows.push({ code: loc.code, name: loc.name, covered, total, pct: total ? covered / total : 0, suspicious });
}
rows.sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code));

const bar = (p) => {
  const n = Math.round(p * 20);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};

process.stdout.write(`\n界面用到的词条: ${used.size} 个（其中 ${langNeutral.length} 条简中原文与英文逐字相同，各语言都不需要翻译：${langNeutral.join(' / ')}）\n`);
process.stdout.write(`需要本地化的词条: ${total} 个\n\n`);
for (const r of rows) {
  const warn = r.suspicious ? `   ⚠ 疑似未翻译 ${r.suspicious}` : '';
  process.stdout.write(`  ${r.code.padEnd(9)} ${bar(r.pct)} ${String(Math.round(r.pct * 100)).padStart(3)}%  ${r.covered}/${r.total}  ${r.name}${warn}\n`);
}
const suspiciousTotal = rows.reduce((n, r) => n + r.suspicious, 0);
if (suspiciousTotal) {
  process.stdout.write(`\n  ⚠ ${suspiciousTotal} 条机翻里还留着汉字原文（覆盖率只算「有值」，这份才是「翻好了」）\n`);
  process.stdout.write(`     修法：node tools/i18n-translate.mjs --engine app --bust suspicious --locales <...>\n`);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
const update = process.argv.includes('--update');

/**
 * 简体词条的「键 → 值长度」，直接用解析结果，不再自己写正则。
 * 分类要按**值**的长度，不是键名的长度 —— 按钮/字段是短值（翻译便宜、可见度最高），
 * 提示句是长值（成本高得多）。第一版按键名分，于是 516 条全被算成「短键」（其实里面
 * 有大量长句），等于没分类。
 */
const valueLen = new Map([...dicts.zh].map(([k, v]) => [k, (v ?? '').length || 400]));

/** 取简体词条的值（列缺失清单时一并显示，方便判断怎么翻） */
const zhValueOf = (key) => dicts.zh.get(key) ?? '';

// --missing <code>：列出该语言**还没本地化**的界面词条（用来挑下一批要翻译的键，
// 而不是凭印象猜哪些缺）。短值优先 —— 那是使用者一打开就看到的按钮与字段。
const missingIdx = process.argv.indexOf('--missing');
if (missingIdx >= 0) {
  const code = process.argv[missingIdx + 1];
  const loc = byCode(code);
  if (!loc) {
    process.stderr.write(`未知地区码: ${code}\n`);
    process.exit(1);
  }
  const own = ownKeys(code);
  const missing = localizable.filter((k) => !own.has(k));
  const short = missing.filter((k) => (valueLen.get(k) ?? 99) <= 12).sort();
  const mid = missing.filter((k) => (valueLen.get(k) ?? 99) > 12 && (valueLen.get(k) ?? 99) <= 40).sort();
  const long = missing.filter((k) => (valueLen.get(k) ?? 99) > 40).sort();
  process.stdout.write(
    `\n${code}（${loc.name}）缺 ${missing.length} 条：短值 ${short.length} / 中等 ${mid.length} / 长句 ${long.length}\n\n`,
  );
  const show = (title, list, n) => {
    process.stdout.write(`${title}（前 ${Math.min(n, list.length)}）:\n`);
    for (const k of list.slice(0, n)) process.stdout.write(`  ${k}  = ${(zhValueOf(k) ?? '').slice(0, 40)}\n`);
    process.stdout.write('\n');
  };
  show('短值（优先：按钮/字段/状态）', short, 120);
  show('中等（面板标题/短提示）', mid, 60);
  show('长句（提示文案，成本最高）', long, 10);
  process.exit(0);
}

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
