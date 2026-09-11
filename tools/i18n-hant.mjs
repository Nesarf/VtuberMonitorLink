// i18n-hant.mjs — 构建期生成繁体词条 / build-time Traditional Chinese variants
//
// 为什么不用运行期查表：手写的简→繁对照表无法区分「这个字简繁同形」和
// 「我漏了这个字」，于是安静地产出「部分繁体 + 部分简体」的混排界面（真的发生过：
// 运/监 漏了 → 标签页变成「运行 / 监视」混在繁体里）。
//
// 现在改用 OpenCC 的权威词典，在**构建期**把整份简体词条转成三个地区变体：
//   zh-Hant → t    通用繁体
//   zh-HK   → hk   香港繁体
//   zh-TW   → twp  台湾正体（含用词：軟體/網路/資訊/預設/儲存…）
// 产物是静态的 web/src/locales/generated.js —— 运行期零依赖、零转换开销。
//
// 自检（幂等性）：把生成结果再用同一个转换器转一次，必须**完全不变**。
// 这一条能抓出所有「转换不彻底」的情况 —— 比人工核对几百个字可靠得多。
//
//   node tools/i18n-hant.mjs          生成/刷新
//   node tools/i18n-hant.mjs --check  只校验是否最新（CI/发布前用，过期则退出码 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web', 'src', 'i18n.jsx');
const OUT = path.join(ROOT, 'web', 'src', 'locales', 'generated.js');

const VARIANTS = [
  { code: 'zh-Hant', to: 't', label: '繁體中文（通用）' },
  { code: 'zh-HK', to: 'hk', label: '香港繁體' },
  { code: 'zh-TW', to: 'twp', label: '臺灣正體' },
];

/** 从 i18n.jsx 里取出 zh 词条（纯对象字面量，可以安全地求值） */
function readZhDict() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('  zh: {');
  const end = src.indexOf('  en: {');
  if (start < 0 || end < 0 || end < start) throw new Error('i18n.jsx 里找不到 zh/en 词条块');
  const block = src.slice(start, end).replace(/,\s*$/, '');
  const obj = new Function('return {' + block + '};')();
  if (!obj?.zh || typeof obj.zh !== 'object') throw new Error('zh 词条解析失败');
  return obj.zh;
}

/**
 * 已复核的「简繁同形/一对多」字符 —— 单字检查会误报它们，但人工确认过没问题。
 *
 * 为什么要一次性复核：字符层无法判断「里」是繁体（公里、馬里奧）还是漏转的简体 ——
 * 它两种都合法。所以让工具先把可疑字**列全**，人看一遍，复核过的进这张表形成棘轮：
 * 以后一旦出现新字符，构建就会失败，逼着再复核一次。
 */
const REVIEWED_SAME_FORM = new Set('里');

/** 结构性检查：转换不该动到 ASCII、数字、占位符、标点 —— 动了就是转换器出问题 */
const STRICT_STRUCTURAL = /[\x00-\x7F]/g;

function main() {
  const check = process.argv.includes('--check');
  const zh = readZhDict();
  const keys = Object.keys(zh);
  const problems = [];
  const suspects = new Map();
  const dicts = {};

  for (const v of VARIANTS) {
    const conv = OpenCC.Converter({ from: 'cn', to: v.to });
    const out = {};
    let changed = 0;
    for (const k of keys) {
      const val = zh[k];
      if (typeof val !== 'string') {
        out[k] = val;
        continue;
      }
      const t = conv(val);
      if (t !== val) changed++;

      // ① 结构不许被破坏：ASCII/数字/占位符必须原样保留
      const a = val.match(STRICT_STRUCTURAL)?.join('') ?? '';
      const b = t.match(STRICT_STRUCTURAL)?.join('') ?? '';
      if (a !== b) {
        problems.push(`${v.code} 破坏了非中文字符: ${k}\n  原文: ${val}\n  转换: ${t}`);
      }

      // ② 可疑字（可能是漏转的简体）—— 收集起来人工复核
      for (const ch of t) {
        if (/[\u3400-\u9fff]/.test(ch) && conv(ch) !== ch) {
          if (!REVIEWED_SAME_FORM.has(ch)) suspects.set(ch, `${k} = ${t}`);
        }
      }
      out[k] = t;
    }
    dicts[v.code] = out;
    const pct = Math.round((changed / keys.length) * 100);
    process.stdout.write(`  ${v.code.padEnd(8)} ${v.label.padEnd(18)} ${changed}/${keys.length} 条有差异 (${pct}%)\n`);
    // 合理性闸门：词典没加载成功时差异率会异常低
    if (pct < 40) problems.push(`${v.code} 差异率只有 ${pct}% —— OpenCC 词典可能没加载成功`);
  }

  if (suspects.size) {
    process.stdout.write(`\n待复核字符 ${suspects.size} 个（单字转换会变，但可能是合法的繁体同形字）:\n`);
    for (const [ch, where] of suspects) process.stdout.write(`  ${ch}  ← ${where}\n`);
    problems.push(
      `有 ${suspects.size} 个字符需要人工复核：${[...suspects.keys()].join(' ')}（确认无误后加入 REVIEWED_SAME_FORM）`,
    );
  }

  if (problems.length) {
    process.stderr.write('\n转换自检失败 / conversion self-check failed:\n');
    for (const p of problems.slice(0, 10)) process.stderr.write('  - ' + p + '\n');
    if (problems.length > 10) process.stderr.write(`  …还有 ${problems.length - 10} 条\n`);
    process.exit(1);
  }

  const header = [
    '// 本文件由 tools/i18n-hant.mjs 生成，请勿手改 / GENERATED — do not edit by hand.',
    '// 数据来源：OpenCC 词典（构建期转换），因此不存在「漏字导致简繁混排」的问题。',
    '// 重新生成：node tools/i18n-hant.mjs',
    `// 生成时间：${new Date().toISOString()}`,
    '',
  ].join('\n');
  const body =
    header +
    'export const GENERATED = ' +
    JSON.stringify(dicts, null, 2) +
    ';\n\nexport default GENERATED;\n';

  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // 时间戳会让每次比较都不相等：比较时忽略它
  const strip = (s) => s.replace(/^\/\/ 生成时间：.*$/m, '');
  if (strip(prev) === strip(body)) {
    process.stdout.write('\n已经是最新 / up to date: ' + path.relative(ROOT, OUT) + '\n');
    return;
  }
  if (check) {
    process.stderr.write('\n繁体词条已过期 / generated.js is stale — run: node tools/i18n-hant.mjs\n');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
  process.stdout.write(`\n生成 / written: ${path.relative(ROOT, OUT)} (${kb} KB, ${VARIANTS.length} 变体 × ${keys.length} 条)\n`);
}

main();
