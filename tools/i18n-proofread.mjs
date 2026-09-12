// i18n-proofread.mjs — 全语言逐条校对 / proofread every locale, every used key
//
// 为什么需要它：翻译管线与覆盖度只能回答「有没有值」「是不是还留着中文」。
// 真正会让界面出问题的错是**结构性的**：占位符被吃掉（{target} 不见了 → 提示变成残句）、
// Markdown 的 ** 只剩一个（整段渲染成粗体）、换行被吞（两条提示粘成一行）、
// 全角标点混进欧洲语言、按钮文案被截成半句。
// 这些错**不会报错、不会白屏**，只是安静地变难看 —— 所以必须逐条比对源串。
//
// 判据分两档：
//   hard   结构性破坏（占位符/加粗/换行/首尾空格）→ 直接判失败，棘轮卡住
//   suspect 可疑但可能是对的（与英文逐字相同、长度离谱、全角标点、重复译文…）→ 记账，不许变多
//
//   node tools/i18n-proofread.mjs                 全语言 + 与基线比对
//   node tools/i18n-proofread.mjs --locale ko-KR  只看一个语言
//   node tools/i18n-proofread.mjs --max 20        每个检查最多列几条
//   node tools/i18n-proofread.mjs --update        把当前 suspect 计数写成新基线
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCALES, byCode } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';
import { convertDict, toBritish } from '../web/src/locales/spelling.js';
import { readDicts, usedKeys } from './lib/i18n-source.mjs';
import { usableChain } from './lib/locale-chain.mjs';
import { looksUntranslated, hasStraySentinel } from './i18n-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'web/src/locales/proofread.json');

const args = { locale: '', max: 6, update: false, quiet: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--locale') args.locale = String(process.argv[++i] ?? '');
  else if (a === '--max') args.max = Number(process.argv[++i]) || 6;
  else if (a === '--update') args.update = true;
  else if (a === '--quiet') args.quiet = true;
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const { zh, en } = readDicts();
const USED = [...usedKeys()];
const MACHINE = readJson(path.join(ROOT, 'web/src/locales/machine.json'), {});
const GLOSSARY = readJson(path.join(ROOT, 'web/src/locales/glossary.json'), {});
const GENERATED = (await import(pathToFileURL(path.join(ROOT, 'web/src/locales/generated.js')).href)).GENERATED ?? {};

// 与 i18n.jsx 的 dict memo **逐字对应**的合并（分级正向合并 → 英文兜底）。
// 顺序一旦不一致，校对对象就和界面看到的不是同一份东西 —— 那这份报告就没有意义了。
// 特别是每级结尾的 `OVERLAY[c] ?? derived[c] ?? STRINGS[c] ?? {}`：
// 这里是 **{}**，不是英文词条。写成英文词条的话，凡是自己没有人工层的地区
// （例如 fr-CA）都会被整份英文盖掉 —— 我第一版就是这么写的，于是它「发现」了
// 一个 560 条英文的假问题（真实界面是法语）。校对自己的假阳性同样会骗人。
const EN_DICT = Object.fromEntries(en);
const derived = { ...GENERATED, 'en-GB': convertDict(EN_DICT, toBritish), 'en-AU': convertDict(EN_DICT, toBritish), 'en-CA': convertDict(EN_DICT, toBritish) };
const ZH_DICT = Object.fromEntries(zh);

/** 某一级自己的底本（只有 zh / en 有整本，其余地区没有就只有空对象） */
const baseDictFor = (c) => (c === 'zh' || c === 'zh-Hans' ? ZH_DICT : c === 'en' || c === 'en-US' ? EN_DICT : {});

function mergedDict(code) {
  let out = {};
  for (const c of usableChain(code)) {
    const level = {
      ...(MACHINE[c] ?? {}),
      ...(HAND_COMMON[c] ?? {}),
      ...(HAND[c] ?? derived[c] ?? baseDictFor(c)),
    };
    out = { ...out, ...level };
  }
  return { ...EN_DICT, ...out };
}

/** 这个语言**自己**提供的值（回落英文的不算），用于区分「漏译」与「英文兜底」 */
function ownDict(code) {
  const own = {};
  if (code.split('-')[0] === 'en') return { ...EN_DICT }; // 英文自己就是基准语言，整份都算「自己的」
  for (const c of usableChain(code)) {
    for (const layer of [MACHINE[c], HAND_COMMON[c], HAND[c], derived[c]]) {
      if (layer) Object.assign(own, layer);
    }
    Object.assign(own, baseDictFor(c));
  }
  return own;
}

// ───────────────────────────────────────────── 结构指纹

/**
 * 必须**逐字不变**的令牌：动一个界面就坏了（{target} 不见 → 提示变残句）。
 * 注意日期/时间格式**不在**这里 —— 那些是给使用者看的说明，
 * 「MM-DD」翻成「MM-JJ」「MM-TT」其实是**对的**（法国人就是这么写日期的），
 * 把它算成结构破坏会制造一堆假警报（第一版就是这么误报的）。
 */
const LITERAL_RES = [
  /\{[A-Za-z_][\w.]*\}/g, // {target} / {n}
  /\$\{[^}]+\}/g, // ${x}
  /%[sdif]\b/g, // %s
  /%[A-Z_]+%/g, // %TEMP%
  /⟦\d+⟧/g,
  /<\/?[a-z][a-z0-9]*>/g, // <video>
];

/** 日期/时间格式令牌：按**类别**比（全大写形态：MM-DD / YYYY-MM-DD / MM-JJ / ДД-ММ） */
const FORMAT_RE = /\b[A-ZА-Я]{2,4}(?:-[A-ZА-Я]{2,4}){1,2}\b/g;

export function literalTokens(text) {
  const out = [];
  for (const re of LITERAL_RES) for (const m of String(text).matchAll(re)) out.push(m[0]);
  return out.sort();
}

export function formatTokens(text) {
  return [...String(text).matchAll(FORMAT_RE)].map((m) => m[0]);
}

const countOf = (text, needle) => String(text).split(needle).length - 1;
/** 全角标点：中文/日文/韩文里是正常书写，欧洲与阿拉伯语言里混进来才是问题 */
const cjkPunct = /[（）【】「」『』，。；：？！、]/;

// ───────────────────────────────────────────── 逐语言校对

const HARD = [];
const SUSPECT = [];
const lengthSamples = [];
const addHard = (code, key, why, val, src) => HARD.push({ code, key, why, val, src });

const rows = [];
for (const loc of LOCALES) {
  if (args.locale && loc.code !== args.locale) continue;
  const dict = mergedDict(loc.code);
  const own = ownDict(loc.code);
  const lang = String(loc.code).split('-')[0];
  const ownHan = [];
  const ownSuspect = [];

  for (const key of USED) {
    const src = zh.get(key);
    if (!src) continue; // 没有源串的键没法比对（也不该有）
    const val = dict[key];
    if (val === undefined) {
      addHard(loc.code, key, '没有值（连英文兜底都没有）', '', src);
      continue;
    }
    const inOwn = Object.prototype.hasOwnProperty.call(own, key);

    // ── hard：结构性破坏（对**显示出来的值**检查，不管是人工还是机翻）
    const tSrc = literalTokens(src).join(' ');
    const tVal = literalTokens(val).join(' ');
    if (tSrc !== tVal) addHard(loc.code, key, `占位符不一致：源「${literalTokens(src).join('') || '无'}」→ 译文「${literalTokens(val).join('') || '无'}」`, val, src);
    if (hasStraySentinel(val)) addHard(loc.code, key, '残留哨兵（模型凭空造的 ⟦n⟧，还原之后本不该存在）', val, src);
    const boldSrc = countOf(src, '**');
    const boldVal = countOf(val, '**');
    if (boldSrc !== boldVal) addHard(loc.code, key, `加粗标记不配对：源 ${boldSrc} 个 ** / 译文 ${boldVal} 个`, val, src);
    const nlSrc = countOf(src, '\n');
    const nlVal = countOf(val, '\n');
    if (nlSrc !== nlVal) addHard(loc.code, key, `换行数不同：源 ${nlSrc} / 译文 ${nlVal}`, val, src);
    if (src.trim() !== src || String(val).trim() !== String(val)) {
      const srcPad = src.length - src.trim().length;
      const valPad = String(val).length - String(val).trim().length;
      if (srcPad !== valPad) addHard(loc.code, key, `首尾空格不同：源 ${srcPad} / 译文 ${valPad}`, val, src);
    }
    // 日期格式令牌：**整类消失**才算结构问题（数量差异是可疑项，见下）
    const fmtSrc = formatTokens(src);
    const fmtVal = formatTokens(val);
    if (fmtSrc.length && fmtVal.length === 0) addHard(loc.code, key, `日期格式说明整段丢失：源「${[...new Set(fmtSrc)].join(', ')}」`, val, src);
    if (fmtSrc.length && fmtVal.length && fmtVal.length !== fmtSrc.length) {
      ownSuspect.push({ key, why: `日期格式出现次数不同（源 ${[...new Set(fmtSrc)].join(',')} / 译文 ${[...new Set(fmtVal)].join(',')}）`, val, src, kind: 'datefmt' });
    }

    // ── suspect：可疑但可能正确
    // 「原文即英文」的键（LLM / API Key / 产品名）本来就不需要翻译，不算漏译
    const langNeutral = src === en.get(key);
    if (!inOwn && !langNeutral) {
      ownSuspect.push({ key, why: '这条是英文兜底（这个语言自己没写）', val, src, kind: 'fallback' });
      continue;
    }
    if (lang !== 'en' && !langNeutral && src.length >= 12 && en.get(key) === val && src !== en.get(key)) {
      // 短标签正好和英文一样很正常（Total / No / Proxy 这类同源词），
      // 一整句还是英文才值得看一眼
      ownSuspect.push({ key, why: '长句译文与英文逐字相同（源串并不是英文）', val, src, kind: 'same-as-en' });
    }
    if (lang !== 'zh' && lang !== 'ja' && lang !== 'ko') {
      // 源串里本来就当**数据**出现的全角标点（例如「顿号/逗号分隔」里的那个顿号，
      // 它是使用者真要敲的字符）不算「混入」—— 只有源串里没有、译文里自己冒出来的才算。
      const srcPunct = new Set(String(src).match(/[（）【】「」『』，。；：？！、]/g) ?? []);
      const strayPunct = [...new Set(String(val).match(/[（）【】「」『』，。；：？！、]/g) ?? [])].filter((c) => !srcPunct.has(c));
      if (strayPunct.length) ownSuspect.push({ key, why: `混入了全角标点「${strayPunct.join('')}」`, val, src, kind: 'cjk-punct' });
    }
    if (lang !== 'zh' && lang !== 'ja' && src.length >= 5 && String(en.get(key) ?? '').length >= 8) {
      // 长度异常放到**跨语言**那一步再判：单个语言和英文比没意义 ——
      // 韩语「알림 창 안」对上英文「Within reminder window」也才 0.29，
      // 那不是错，是语言本来就紧凑。见下面 lengthOutliers()。
      lengthSamples.push({ code: loc.code, key, val: String(val) });
    }
    if (src.trimEnd().endsWith('…') !== String(val).trimEnd().endsWith('…')) {
      ownSuspect.push({ key, why: '省略号有无不一致', val, src, kind: 'ellipsis' });
    }
    // 术语表里给了这个语言的约定叫法，译文却还留着**中文原词** → 覆盖值没生效。
    // 只查中文术语：拉丁术语（bilibili / VTuber）本来就可能以原形出现，
    // 而且「B 站」这类别名也映射到同一个值，拿它做判据必然误报（踩过）。
    for (const [term, spec] of Object.entries(GLOSSARY)) {
      if (term.startsWith('_')) continue;
      if (!/[\u4e00-\u9fff]/.test(term)) continue;
      const target = spec?.[loc.code];
      if (!target || target === term) continue;
      if (String(src).includes(term) && String(val).includes(term)) {
        ownSuspect.push({ key, why: `术语「${term}」应当写成「${target}」，译文里仍是原词`, val, src, kind: 'glossary' });
        break;
      }
    }
    if (lang !== 'zh' && lang !== 'ja' && looksUntranslated(val, loc.code, GLOSSARY)) {
      addHard(loc.code, key, '译文里还留着汉字原文', val, src);
    }
    ownHan.push(key);
  }

  // ── suspect：同一语言里两条不同的源串译成了**同一句长文案**（多为复制粘贴手误）。
  // 只挑长句：短标签撞车是正常的（calAdded 与 calAlready 在日语里都是「カレンダーに追加済み」）。
  const byValue = new Map();
  for (const key of USED) {
    const val = own[key];
    if (typeof val !== 'string' || val.length < 25) continue;
    const src = zh.get(key);
    if (!src) continue;
    if (!byValue.has(val)) byValue.set(val, []);
    byValue.get(val).push(key);
  }
  let dupCount = 0;
  for (const [val, keys] of byValue) {
    if (keys.length < 2) continue;
    const srcs = new Set(keys.map((k) => zh.get(k)));
    if (srcs.size < 2) continue; // 源串本来就一样，译文一样是对的
    dupCount += keys.length;
    if (ownSuspect.length < 400) ownSuspect.push({ key: keys.join(' / '), why: '不同的源串译成了同一个值（查一下是不是复制手误）', val, src: [...srcs].join(' | '), kind: 'duplicate' });
  }

  rows.push({ code: loc.code, name: loc.name, hard: HARD.filter((h) => h.code === loc.code).length, suspect: ownSuspect.length, dupCount, covered: ownHan.length });
  for (const s of ownSuspect) SUSPECT.push({ code: loc.code, ...s });
}

// 跨语言长度离群：补进可疑清单（每条都要能定位到语言，便于直接去修）
for (const x of lengthOutliers()) {
  SUSPECT.push(x);
  const row = rows.find((r) => r.code === x.code);
  if (row) row.suspect++;
}

// ───────────────────────────────────────────── 跨语言：长度离群

/**
 * 同一个键在 25 个语言里的长度**中位数**是很好的基准：
 * 各语言自己的松紧在中位数里已经体现了，真正的错（被截断、只剩一句、
 * 或者翻译时把整段丢了）才会离群。
 */
function lengthOutliers() {
  const byKey = new Map();
  for (const s of lengthSamples) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  const out = [];
  for (const [key, list] of byKey) {
    if (list.length < 6) continue; // 样本太少，中位数不可信
    const lens = list.map((x) => x.val.length).sort((a, b) => a - b);
    const mid = lens[Math.floor(lens.length / 2)];
    if (mid < 6) continue;
    for (const x of list) {
      if (x.val.length > mid * 3 || x.val.length < mid * 0.3) {
        out.push({ code: x.code, key, val: x.val, src: zh.get(key) ?? '', why: `长度离群：其他语言中位数 ${mid}，这里是 ${x.val.length}`, kind: 'length' });
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────── 报告

const byKind = (kind) => SUSPECT.filter((s) => s.kind === kind);
const hardByWhy = new Map();
for (const h of HARD) {
  const k = h.why.replace(/：.*$/, '');
  if (!hardByWhy.has(k)) hardByWhy.set(k, []);
  hardByWhy.get(k).push(h);
}

/** 同一个键在哪些语言都出问题 —— 「一个键坏了 25 遍」和「25 个键各坏一遍」是两件事 */
function hardByKey() {
  const m = new Map();
  for (const h of HARD) {
    if (!m.has(h.key)) m.set(h.key, { key: h.key, why: h.why, codes: [] });
    m.get(h.key).codes.push(h.code);
  }
  return [...m.values()].sort((a, b) => b.codes.length - a.codes.length);
}

process.stdout.write(`\n校对范围：${USED.length} 个界面词条 × ${rows.length} 个语言\n`);
process.stdout.write(`源串取自简体词条（${zh.size} 条），显示值按 i18n.jsx 的合并顺序算出\n\n`);
for (const r of rows.sort((a, b) => b.hard - a.hard || b.suspect - a.suspect || a.code.localeCompare(b.code))) {
  const flag = r.hard ? `✗ 结构性问题 ${r.hard}` : '✓ 结构正常';
  process.stdout.write(`  ${r.code.padEnd(9)} ${flag.padEnd(16)} 可疑 ${String(r.suspect).padStart(3)}  自带词条 ${r.covered}\n`);
}

const show = (title, list, fmt) => {
  if (!list.length) return;
  process.stdout.write(`\n${title}（${list.length} 条）\n`);
  for (const x of list.slice(0, args.max)) process.stdout.write('  ' + fmt(x) + '\n');
  if (list.length > args.max) process.stdout.write(`  …还有 ${list.length - args.max} 条\n`);
};

if (!args.quiet) {
  for (const [why, list] of hardByWhy) {
    show(`✗ ${why}`, list, (x) => `${x.code} ${x.key}\n      源: ${JSON.stringify(String(x.src).slice(0, 90))}\n      值: ${JSON.stringify(String(x.val).slice(0, 90))}`);
  }
  show('✗ 同一个键在多个语言都出问题（按键汇总）', hardByKey(), (x) => `${x.key} —— ${x.codes.join(', ')}\n      ${x.why}`);
  show('可疑：这条其实是英文兜底（该语言自己没写）', byKind('fallback'), (x) => `${x.code} ${x.key}`);
  show('可疑：与英文逐字相同', byKind('same-as-en'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 60))}`);
  show('可疑：日期格式出现次数不同（可能被本地化成 JJ/TT/GG 之类，属正常；数量差才可疑）', byKind('datefmt'), (x) => `${x.code} ${x.key}\n      ${x.why}`);
  show('可疑：全角标点混进欧洲/阿拉伯语言', byKind('cjk-punct'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('可疑：短文案长度离谱', byKind('length'), (x) => `${x.code} ${x.key}\n      源: ${JSON.stringify(String(x.src).slice(0, 50))}\n      值: ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('可疑：省略号不一致', byKind('ellipsis'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 70))}`);
  show('可疑：术语表里的约定叫法没生效', byKind('glossary'), (x) => `${x.code} ${x.key}\n      ${x.why}\n      值: ${JSON.stringify(String(x.val).slice(0, 80))}`);
  show('可疑：不同源串译成同一个值', byKind('duplicate'), (x) => `${x.code} ${x.key} = ${JSON.stringify(String(x.val).slice(0, 60))}`);
}

const counts = Object.fromEntries(rows.map((r) => [r.code, r.suspect]));
const totalSuspect = SUSPECT.length;

if (args.update) {
  fs.writeFileSync(BASELINE, JSON.stringify({ generatedAt: new Date().toISOString(), used: USED.length, locales: counts }, null, 2) + '\n', 'utf8');
  process.stdout.write(`\n已写入基线 / baseline written: ${path.relative(ROOT, BASELINE)}\n`);
  process.exit(HARD.length ? 1 : 0);
}

const baseline = readJson(BASELINE, null);
let regressed = [];
if (baseline?.locales) {
  regressed = rows.filter((r) => (baseline.locales[r.code] ?? 0) < r.suspect).map((r) => `${r.code}: ${baseline.locales[r.code] ?? 0} → ${r.suspect}`);
}

process.stdout.write(`\n结构性（hard）问题：${HARD.length} 条 · 可疑：${totalSuspect} 条\n`);
if (regressed.length) {
  process.stdout.write('\n可疑条数比基线变多了（要么修，要么确认后 --update）：\n');
  for (const r of regressed) process.stdout.write('  - ' + r + '\n');
}
if (HARD.length || regressed.length) {
  process.stdout.write('\n校对未通过 / proofread failed\n');
  process.exit(1);
}
process.stdout.write('\n校对通过 ✓\n');
