// i18n-translate.mjs — 界面词条的机器翻译管线 / machine-translation pipeline for UI strings
//
// 机制参考 MTool（那套工具把「批量翻译界面文本」这件事的坑都踩过一遍了），取它最关键的五点：
//
//   1) **多引擎可选**：引擎是可插拔的（本地 mock / 任意 OpenAI 兼容接口），
//      换引擎不改管线。没有配置就明确拒绝运行，不会拿空 key 去调。
//   2) **按「源串 + 目标语言」哈希缓存**：同一句永不重复花钱；改了源串自然是新键，
//      旧译文留在缓存里不脏数据。缓存可复用、可提交（不含密钥）。
//   3) **术语表**：人名、产品词必须锁死（`情报` 不能一处翻成 Intel 一处翻成 Info）。
//      做法是翻译前把术语替换成哨兵，译完还原 —— 这样模型根本没机会改它。
//   4) **占位符保护**：`{target}`、`${x}`、`%s`、换行、`MM-DD` 这类必须原样活着。
//      译完**校验哨兵是否全部还原**，缺一个就判该条失败，绝不写进一个被模型改坏的值。
//   5) **增量 + 单条失败不拖垮整批**：只翻缺失的键；失败的单独记账、下次重试。
//
// 与 MTool 的一个刻意的不同：**机器译文单独一层，永远压不过人工词条**。
// 层级顺序见 web/src/i18n.jsx：人工(HAND/COMMON) → 构建期生成(繁体) → 机器 → 英文兜底。
// 这样「机器翻过一遍」不会覆盖任何人工校对过的内容。
//
//   node tools/i18n-translate.mjs --engine mock --locales ja-JP,ko-KR --limit 20
//   node tools/i18n-translate.mjs --engine openai --locales ja-JP --dry-run
//   node tools/i18n-translate.mjs --review ja-JP         # 列出机器译文供人工复核
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, readDicts, usedKeys } from './lib/i18n-source.mjs';
import { byCode, LOCALES } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';

const CACHE_DIR_DEFAULT = path.join(ROOT, 'web/src/locales/.cache');
const OUT_FILE_DEFAULT = path.join(ROOT, 'web/src/locales/machine.json');
const GLOSSARY_FILE = path.join(ROOT, 'web/src/locales/glossary.json');

const args = {
  engine: 'mock',
  locales: [],
  limit: 0,
  dryRun: false,
  review: null,
  concurrency: 2,
  batch: 8,
  url: '',
  key: '',
  model: '',
  retry: 1,
  bust: 'none',
  // 沙箱：把缓存与产物指到别处。自检用它保证互不干扰（否则「第一次应当新译 N 条」
  // 这种断言会被真实缓存命中打败）；手动跑时也方便「换个模型试一遍而不污染正式缓存」。
  cacheDir: '',
  out: '',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--engine') args.engine = process.argv[++i];
  else if (a === '--locales') args.locales = String(process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--batch') args.batch = Number(process.argv[++i]);
  else if (a === '--concurrency') args.concurrency = Number(process.argv[++i]);
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--bust') args.bust = String(process.argv[++i] ?? 'terms');
  else if (a === '--cache-dir') args.cacheDir = path.resolve(process.argv[++i]);
  else if (a === '--out') args.out = path.resolve(process.argv[++i]);
  else if (a === '--review') args.review = process.argv[++i];
  else if (a === '--url') args.url = process.argv[++i];
  else if (a === '--key') args.key = process.argv[++i];
  else if (a === '--model') args.model = process.argv[++i];
}

const log = (s) => process.stdout.write(s + '\n');

// ───────────────────────────────────────────── 缓存

function cachePath(locale) {
  return path.join(args.cacheDir || CACHE_DIR_DEFAULT, `${locale}.json`);
}

export function loadCache(locale) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(locale), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* 没有就从空开始 */
  }
  return {};
}

export function saveCache(locale, cache) {
  const dir = args.cacheDir || CACHE_DIR_DEFAULT;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${locale}.json`), JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

/** 缓存键：源串 + 目标语言（换了语言自然要重译，改了源串也是新键） */
export function cacheKey(text, locale) {
  return crypto.createHash('sha256').update(`${locale}\u0000${text}`).digest('hex').slice(0, 20);
}

// ───────────────────────────────────────────── 术语表与占位符

export function loadGlossary() {
  try {
    const raw = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* 没有术语表也能跑 */
  }
  return {};
}

/**
 * 把必须保留的东西替换成哨兵。
 * 返回 { text, tokens } —— tokens 用来在译完后还原并**校验**。
 */
export function protect(text, glossary = {}, locale = '') {
  const tokens = [];
  let out = String(text);
  const push = (value, kind) => {
    const i = tokens.length;
    tokens.push({ value, kind });
    return `⟦${i}⟧`;
  };
  // 术语表：源串里出现的术语整体替换（长的优先，避免短词把长词切碎）
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (!out.includes(term)) continue;
    const target = glossary[term]?.[locale] ?? glossary[term]?.default ?? term;
    // 用 split/join 做全局替换（避免正则转义问题）
    out = out.split(term).join(push(target, 'term'));
  }
  // 占位符类：{} / ${} / %s / %d / 换行 / 日期与数字形态
  out = out.replace(/\$\{[^}]+\}/g, (m) => push(m, 'tpl'));
  out = out.replace(/\{[^}]+\}/g, (m) => push(m, 'brace'));
  out = out.replace(/%[sdif]/g, (m) => push(m, 'printf'));
  out = out.replace(/\\n/g, (m) => push(m, 'newline'));
  out = out.replace(/\b\d{2}-\d{2}\b/g, (m) => push(m, 'date'));
  out = out.replace(/\bYYYY-MM-DD\b/g, (m) => push(m, 'datefmt'));
  return { text: out, tokens };
}

/** 还原哨兵。缺任何一个 → ok:false（宁可不写，也不写一个被模型改坏的值） */
export function restore(text, tokens) {
  let out = String(text ?? '');
  const missing = [];
  for (let i = 0; i < tokens.length; i++) {
    const marker = `⟦${i}⟧`;
    // 容忍模型把方括号换成圆括号/加空格
    const loose = new RegExp(`[⟦\\[（(]\\s*${i}\\s*[⟧\\]）)]`);
    if (out.includes(marker)) out = out.split(marker).join(tokens[i].value);
    else if (loose.test(out)) out = out.replace(loose, tokens[i].value);
    else missing.push(i);
  }
  return { ok: missing.length === 0, text: out, missing };
}

/**
 * 这条译文看起来**根本没翻**吗？
 *
 * 为什么需要：覆盖率只统计「有没有值」，于是「值是中文原文」也算 100% —— 度量是虚的。
 * 判据：非中日文目标语言里出现汉字（术语表里有意保留原文的词先剔掉）。
 * 日语例外（汉字本来就是正常书写）。
 */
export function looksUntranslated(text, locale, glossary = {}) {
  if (!text || String(locale).startsWith('ja')) return false;
  const keep = Object.keys(glossary).filter((k) => !k.startsWith('_') && glossary[k]?.default === k);
  let s = String(text);
  for (const t of keep) s = s.split(t).join('');
  return /[\u4e00-\u9fff]/.test(s);
}

/**
 * 缓存失效策略。
 *
 * 为什么需要：缓存键是「源串 + 语言」，所以**改了提示词或术语表，旧译文仍然会被命中** ——
 * 专有名词政策变了却拿不回旧条目，只能干瞪眼。四种模式：
 *   none       正常走缓存（默认）
 *   terms      只重译「源串里含专有名词」的条目（术语表里的词，或含大写字母的英文片段）
 *   suspicious 只重译「看起来根本没翻」的条目（译文里还留着汉字）—— 用来修机翻漏译
 *   all        全部重译（改了大模型或整体译法不对时才用；等于重新花一遍钱）
 */
export function needsRetranslate(sourceText, mode, glossary = {}, existing = null, locale = '') {
  if (mode === 'all') return true;
  if (mode === 'suspicious') return looksUntranslated(existing, locale, glossary);
  if (mode !== 'terms') return false;
  for (const term of Object.keys(glossary)) if (String(sourceText).includes(term)) return true;
  // 含「看起来像品牌名」的拉丁片段：连续 ≥2 个字符且带大写（Telegram / SQLite / X）
  return /\b[A-Z][A-Za-z0-9.+#-]{1,}\b/.test(String(sourceText));
}

// ───────────────────────────────────────────── 引擎

async function translateBatchOpenAI({ texts, locale, target }, provider = {}) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: provider.model || args.model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [
          `You translate UI strings for a desktop app into ${target} (${locale}).`,
          'Output JSON only: {"t":["...","..."]} with exactly ' + texts.length + ' items, same order. Keep it short like a UI label.',
          'Never translate ⟦n⟧ placeholders — copy them exactly.',
          // 专有名词政策（使用者指定）：维持原文优先；只有约定俗成的本地叫法才替换。
          // 这条必须写进提示词 —— 术语表只能覆盖列进去的词，盖不到的要靠模型自己守规矩。
          'PROPER NOUNS: keep person names, group names, brand names, product names and service names in their original form.',
          'Only replace a proper noun when the target language has a widely established local name for it (e.g. YouTube→유튜브 in Korean, Telegram→Телеграм in Russian, hololive→ホロライブ in Japanese).',
          'If unsure, keep the original — never invent a transliteration.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ t: texts }) },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
  const m = /\{[\s\S]*\}/.exec(content);
  const arr = m ? JSON.parse(m[0])?.t : null;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error(`返回条数不对（期望 ${texts.length}）`);
  return arr.map((s) => String(s ?? ''));
}

async function translateBatchMock({ texts, locale }) {
  // 假引擎：确定性「翻译」，只为验证管线（真的翻译要接 --engine openai）
  const marker = { 'ja-JP': '【JA】', 'ko-KR': '【KO】', 'de-DE': '【DE】' }[locale] ?? `【${locale}】`;
  await new Promise((r) => setTimeout(r, 5));
  return texts.map((s) => marker + s);
}

async function translateBatch({ texts, locale, target }) {
  if (args.engine === 'mock') return translateBatchMock({ texts, locale });
  if (args.engine === 'app' || args.engine === 'openai') {
    const p = args.engine === 'app' ? providerFromApp() : { baseUrl: args.url, apiKey: args.key, model: args.model };
    if (!p?.baseUrl || !p?.apiKey) throw new Error('没有可用的模型档位（界面里配好，或显式给 --url/--key）');
    return translateBatchOpenAI({ texts, locale, target }, p);
  }
  throw new Error(`未知引擎: ${args.engine}`);
}

/**
 * 从**本机应用配置**里读取模型档位。
 *
 * 为什么要有这个引擎：用 `--key` 传密钥会让它出现在命令行与 shell 历史里 ——
 * 一个「把密钥打进命令行」的翻译脚本本身就是个隐患。走这个引擎时密钥只在本进程内存里，
 * 而且用的就是你在界面里已经配好的档位（打包版优先，其次是开发树的 config.json）。
 */
function providerFromApp() {
  const candidates = [
    path.join(ROOT, 'dist/VtuberMonitorLink/app/config.json'),
    path.join(ROOT, 'config.json'),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = cfg?.llm?.providers ?? [];
      const active = list.find((x) => x.id === cfg.llm.activeId) ?? list[0];
      if (active?.apiKey) return { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model, name: active.name };
      if (cfg?.llm?.apiKey) return { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, model: cfg.llm.model, name: '默认' };
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

// ───────────────────────────────────────────── 主流程

/** 该语言「人工已经写好」的键（机器层不得覆盖） */
export function humanKeys(locale) {
  const keys = new Set();
  for (const layer of [HAND_COMMON[locale], HAND[locale]]) {
    if (layer) for (const k of Object.keys(layer)) keys.add(k);
  }
  // 同语言的上级（es-MX 继承 es-419/es-ES 之类）也算人工
  const base = String(locale).split('-')[0];
  for (const loc of LOCALES) {
    if (loc.code === locale) continue;
    if (String(loc.code).split('-')[0] !== base) continue;
    for (const layer of [HAND_COMMON[loc.code], HAND[loc.code]]) {
      if (layer) for (const k of Object.keys(layer)) keys.add(k);
    }
  }
  return keys;
}

function readMachine() {
  try {
    const raw = JSON.parse(fs.readFileSync(args.out || OUT_FILE_DEFAULT, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* 没有就从空开始 */
  }
  return {};
}

function writeMachine(all) {
  fs.writeFileSync(args.out || OUT_FILE_DEFAULT, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

async function main() {
  const { zh } = readDicts();
  const used = usedKeys();
  const glossary = loadGlossary();

  if (args.review) {
    const machine = readMachine();
    const dict = machine[args.review] ?? {};
    const keys = Object.keys(dict);
    log(`\n${args.review}: ${keys.length} 条机器译文\n`);
    for (const k of keys.slice(0, 60)) log(`  ${k}\n    zh: ${zh.get(k) ?? ''}\n    mt: ${dict[k]}\n`);
    if (keys.length > 60) log(`  …还有 ${keys.length - 60} 条`);
    return;
  }

  if (!args.locales.length) {
    log('用法: node tools/i18n-translate.mjs --engine mock|openai --locales ja-JP,ko-KR [--limit N] [--dry-run]');
    log('      node tools/i18n-translate.mjs --review ja-JP');
    process.exit(2);
  }
  if (args.engine === 'openai' && (!args.url || !args.key)) {
    log('openai 引擎需要 --url 与 --key（也可先在界面里配好，这里只是脚本入口）');
    process.exit(2);
  }

  const machine = readMachine();
  let grand = { translated: 0, cached: 0, failed: 0, skippedHuman: 0 };

  for (const locale of args.locales) {
    const loc = byCode(locale);
    if (!loc) {
      log(`  ⚠ 未知地区码 ${locale}，跳过`);
      continue;
    }
    const human = humanKeys(locale);
    const cache = loadCache(locale);
    const todo = [];
    let skippedHuman = 0;
    for (const key of used) {
      if (human.has(key)) {
        skippedHuman++;
        continue;
      }
      const value = zh.get(key);
      if (!value) continue;
      const ck = cacheKey(value, locale);
      const existing = cache[ck];
      if (existing && !needsRetranslate(value, args.bust, glossary, existing, locale)) {
        grand.cached++;
        machine[locale] ??= {};
        machine[locale][key] = existing;
        continue;
      }
      todo.push({ key, value, ck });
    }
    const batchSize = Math.max(1, args.batch);
    const queue = args.limit > 0 ? todo.slice(0, args.limit) : todo;
    log(`\n${locale}（${loc.name}）: 人工已有 ${human.size} 条（跳过 ${skippedHuman}）· 待译 ${todo.length} · 本次处理 ${queue.length} · 缓存命中 ${grand.cached}`);

    if (args.dryRun) {
      for (const t of queue.slice(0, 10)) log(`  [dry-run] ${t.key} = ${t.value.slice(0, 40)}`);
      continue;
    }

    let translated = 0;
    let failed = 0;
    const batches = [];
    for (let i = 0; i < queue.length; i += batchSize) batches.push(queue.slice(i, i + batchSize));

    let idx = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(args.concurrency, batches.length || 1)) }, async () => {
      while (true) {
        const b = batches[idx++];
        if (!b) return;
        // 完整流程：术语与占位符保护 → 翻译 → 还原并校验
        const prepared = b.map((x) => protect(x.value, glossary, locale));
        let out = null;
        for (let attempt = 0; attempt <= args.retry; attempt++) {
          try {
            out = await translateBatch({ texts: prepared.map((p) => p.text), locale, target: loc.name });
            break;
          } catch (e) {
            if (attempt === args.retry) {
              failed += b.length;
              log(`  ✕ 批次失败（${b.length} 条）: ${e.message}`);
            }
          }
        }
        if (!out) continue;
        for (let i = 0; i < b.length; i++) {
          const restored = restore(out[i], prepared[i].tokens);
          if (!restored.ok) {
            // 哨兵丢了 → 这一条不写（宁缺勿坏），并记账等下次
            failed++;
            log(`  ✕ ${b[i].key}: 占位符缺失 ${restored.missing.join(',')}，已丢弃`);
            continue;
          }
          cache[b[i].ck] = restored.text;
          machine[locale] ??= {};
          machine[locale][b[i].key] = restored.text;
          translated++;
        }
      }
    });
    await Promise.all(runners);
    saveCache(locale, cache);
    // 每个语言写完就落盘：一次跑 7000 条要好几分钟，中途出错时不该把已经付过费的成果丢掉。
    // （缓存也是按语言存的，重跑会自动命中，所以这里只影响 machine.json。）
    writeMachine(machine);
    log(`  ✓ 新译 ${translated} · 失败 ${failed}`);
    grand.translated += translated;
    grand.failed += failed;
    grand.skippedHuman += skippedHuman;
  }

  if (!args.dryRun) {
    writeMachine(machine);
    log(`\n写入 ${path.relative(ROOT, args.out || OUT_FILE_DEFAULT)}`);
    log(`机器层是**最低优先级**（人工词条永远压过它），改完跑 npm run i18n:coverage 看效果。`);
  }
  log(`\n合计: 新译 ${grand.translated} · 缓存命中 ${grand.cached} · 失败 ${grand.failed}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('i18n-translate.mjs')) {
  main().catch((e) => {
    process.stderr.write('翻译管线异常: ' + (e?.stack ?? e) + '\n');
    process.exit(1);
  });
}
