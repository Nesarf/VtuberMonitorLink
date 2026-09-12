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
import { inheritableAncestors } from './lib/locale-chain.mjs';
import { byCode, LOCALES } from '../web/src/locales/index.js';
import { HAND, HAND_COMMON } from '../web/src/locales/overlays.js';

const CACHE_DIR_DEFAULT = path.join(ROOT, 'web/src/locales/.cache');
const OUT_FILE_DEFAULT = path.join(ROOT, 'web/src/locales/machine.json');
const GLOSSARY_FILE = path.join(ROOT, 'web/src/locales/glossary.json');

const args = {
  engine: 'mock',
  locales: [],
  keys: [],
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
  // 假引擎的行为开关（只有 --engine mock 才看它）：echo = 原样回原文，用来测「不合格就不写」
  mockMode: '',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--engine') args.engine = process.argv[++i];
  else if (a === '--locales') args.locales = String(process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // 只修某几个键：校对发现「这一个键在十个语言里都坏了」时，没必要把整本重跑一遍
  else if (a === '--keys') args.keys = String(process.argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--batch') args.batch = Number(process.argv[++i]);
  else if (a === '--concurrency') args.concurrency = Number(process.argv[++i]);
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--bust') args.bust = String(process.argv[++i] ?? 'terms');
  else if (a === '--cache-dir') args.cacheDir = path.resolve(process.argv[++i]);
  else if (a === '--out') args.out = path.resolve(process.argv[++i]);
  else if (a === '--mock-mode') args.mockMode = String(process.argv[++i] ?? '');
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
 *
 * 剔除保留词必须**先长后短**：术语表里同时有「嘉然」和「嘉然今天吃什么」，
 * 先剔短的话长词会被切碎成「今天吃什么」，反而制造出一堆假的「未翻译」。
 */
export function looksUntranslated(text, locale, glossary = {}) {
  if (!text || String(locale).startsWith('ja')) return false;
  const keep = Object.keys(glossary)
    .filter((k) => !k.startsWith('_') && glossary[k]?.default === k)
    .sort((a, b) => b.length - a.length);
  let s = String(text);
  for (const t of keep) s = s.split(t).join('');
  return /[\u4e00-\u9fff]/.test(s);
}

/**
 * 译文里躺着**没被还原的哨兵**吗？
 *
 * 这是真实事故：源串「天后」里根本没有占位符（tokens 为空），模型却自己写了个 ⟦0⟧
 * 出来（提示词里见过这个东西），而 restore() 只检查「发出的哨兵有没有丢」，
 * 不管「译文里有没有多出来的哨兵」—— 于是「daqui a ⟦0⟧ dias」就这么写进了葡语界面，
 * 四个语言中招。判据：译文里出现任何 ⟦数字⟧ 都不允许（还原之后本不该存在）。
 */
export function hasStraySentinel(text) {
  return /⟦\s*\d+\s*⟧/.test(String(text ?? ''));
}

/** 「这条译文坏了」的统一判据：没翻完（还留着汉字）或残留哨兵 */
export function looksBroken(text, locale, glossary = {}) {
  return hasStraySentinel(text) || looksUntranslated(text, locale, glossary);
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
  // 坏译文（没翻完 / 残留哨兵）一律重译 —— 这两个都是「有值但没法看」的典型
  if (mode === 'suspicious') return looksBroken(existing, locale, glossary);
  if (mode !== 'terms') return false;
  for (const term of Object.keys(glossary)) if (String(sourceText).includes(term)) return true;
  // 含「看起来像品牌名」的拉丁片段：连续 ≥2 个字符且带大写（Telegram / SQLite / X）
  return /\b[A-Z][A-Za-z0-9.+#-]{1,}\b/.test(String(sourceText));
}

// ───────────────────────────────────────────── 引擎

async function translateBatchOpenAI({ texts, locale, target }, provider = {}, { task = 'translate' } = {}) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  // 「把半成品翻完」是一次**任务不同**的调用：输入不是中文原文，而是上一次那份
  // 「中英/中韩混排」的输出。这一点很关键 —— 温度是 0，只要输入与提示词都不变，
  // 模型就会把同一份坏译文再给一遍（踩过：6 条 ko-KR 连续三次原样返回）。
  const finishing = task === 'finish';
  const body = {
    model: provider.model || args.model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [
          finishing
            ? `These UI strings were supposed to be in ${target} (${locale}) but are still partly in the source language. Rewrite each one completely in ${target}.`
            : `You translate UI strings for a desktop app into ${target} (${locale}).`,
          'Output JSON only: {"t":["...","..."]} with exactly ' + texts.length + ' items, same order. Keep it short like a UI label.',
          'Never translate ⟦n⟧ placeholders — copy them exactly.',
          // 专有名词政策（使用者指定）：维持原文优先；只有约定俗成的本地叫法才替换。
          // 这条必须写进提示词 —— 术语表只能覆盖列进去的词，盖不到的要靠模型自己守规矩。
          'PROPER NOUNS: keep person names, group names, brand names, product names and service names in their original form.',
          'Only replace a proper noun when the target language has a widely established local name for it (e.g. YouTube→유튜브 in Korean, Telegram→Телеграм in Russian, hololive→ホロライブ in Japanese).',
          'If unsure, keep the original — never invent a transliteration.',
          ...(finishing
            ? [
                'Translate every single word. Chinese characters in the output are a hard failure, unless they are part of a proper noun you are told to keep.',
                'Do not just copy the input: it is a rejected draft.',
              ]
            : []),
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
  // --mock-mode echo：模拟「模型原样回原文」的坏行为，用来端到端验证「补译 → 仍不合格 → 不写入」。
  if (args.mockMode === 'echo') return texts.map((s) => String(s));
  // --mock-mode sentinel：模拟「模型凭空造哨兵」（真实事故：葡语界面出现 daqui a ⟦0⟧ dias）
  if (args.mockMode === 'sentinel') return texts.map((s) => marker + String(s).replace(/[\u4e00-\u9fff]/g, '~') + ' ⟦0⟧');
  // 正常假引擎把汉字去掉：假翻译也该「看起来翻好了」，否则 25 种语言的巡检会被自己的假数据卡住
  return texts.map((s) => marker + String(s).replace(/[\u4e00-\u9fff]/g, '~'));
}

async function translateBatch({ texts, locale, target }, opts = {}) {
  if (args.engine === 'mock') return translateBatchMock({ texts, locale });
  if (args.engine === 'app' || args.engine === 'openai') {
    const p = args.engine === 'app' ? providerFromApp() : { baseUrl: args.url, apiKey: args.key, model: args.model };
    if (!p?.baseUrl || !p?.apiKey) throw new Error('没有可用的模型档位（界面里配好，或显式给 --url/--key）');
    return translateBatchOpenAI({ texts, locale, target }, p, opts);
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
  // 自己 + **同语言祖先**（es-MX 继承 es-419/es-ES、zh-TW 继承 zh-Hant/zh-Hans）。
  // 兄弟地区不算：pt-PT 的 chain 不含 pt-BR，运行时继承不到，把 pt-BR 的词条当
  // 「人工已有」只会让 pt-PT 永远拿不到机翻（缺口被工具报成 100% 覆盖）。
  for (const c of [locale, ...inheritableAncestors(locale)]) {
    for (const layer of [HAND_COMMON[c], HAND[c]]) {
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

/**
 * 写盘前剪枝：机器层里**永远不会被显示**的条目清掉。
 *
 * 哪两种：① 人工层已经写过的键（人工压过机器，机器那条是死的）；
 * ② 简中原文与英文逐字相同的键（各语言都用同一个字符串，不需要译文）。
 * 不剪会怎样：machine.json 里堆着一批看不见的旧译文，其中带汉字的还会被
 * 「疑似未翻译」统计抓出来 —— 变成让人去修一条界面上根本不存在的坏译文。
 */
export function pruneMachine(machine, { zh, en } = {}) {
  const removed = [];
  for (const [code, dict] of Object.entries(machine)) {
    if (!dict || typeof dict !== 'object') continue;
    const shadowed = humanKeys(code);
    for (const key of Object.keys(dict)) {
      const neutral = zh && en ? isLanguageNeutral(zh.get(key), en.get(key)) : false;
      if (!neutral && !shadowed.has(key)) continue;
      removed.push(`${code}.${key}`);
      delete dict[key];
    }
  }
  return removed;
}

function writeMachine(all) {
  fs.writeFileSync(args.out || OUT_FILE_DEFAULT, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/**
 * 这条根本不用翻：简中原文与英文**逐字相同**（品牌名与缩写，如 LLM / API Key）。
 * 判据来自源码本身（zh 值 === en 值），不另立豁免清单 —— 清单会漂移。
 */
export function isLanguageNeutral(zhValue, enValue) {
  return !!zhValue && zhValue === enValue;
}

async function main() {
  const { zh, en } = readDicts();
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
    let skippedNeutral = 0;
    for (const key of used) {
      if (args.keys.length && !args.keys.includes(key)) continue;
      if (human.has(key)) {
        skippedHuman++;
        continue;
      }
      const value = zh.get(key);
      if (!value) continue;
      if (isLanguageNeutral(value, en.get(key))) {
        skippedNeutral++;
        continue;
      }
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
    log(`\n${locale}（${loc.name}）: 人工已有 ${human.size} 条（跳过 ${skippedHuman}）· 原文=英文不用翻 ${skippedNeutral} 条 · 待译 ${todo.length} · 本次处理 ${queue.length} · 缓存命中 ${grand.cached}`);

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

        // 第一遍结果：还原并校验占位符
        const draft = b.map((_, i) => {
          const restored = restore(out[i], prepared[i].tokens);
          return restored.ok ? { ok: true, text: restored.text } : { ok: false, missing: restored.missing };
        });

        // 第二遍（只对「看起来坏了」的条目）：把这些半成品当输入再要一次。
        // 为什么不重发原文：温度 0，输入与提示词都不变 → 模型原样再给一遍坏译文。
        const leftover = draft.map((d, i) => (d.ok && looksBroken(d.text, locale, glossary) ? i : -1)).filter((i) => i >= 0);
        if (leftover.length) {
          const again = leftover.map((i) => protect(draft[i].text, glossary, locale));
          let out2 = null;
          try {
            out2 = await translateBatch({ texts: again.map((p) => p.text), locale, target: loc.name }, { task: 'finish' });
          } catch (e) {
            log(`  ⚠ 补译批次失败（${leftover.length} 条）: ${e.message}`);
          }
          if (out2) {
            leftover.forEach((slot, k) => {
              const r = restore(out2[k], again[k].tokens);
              if (r.ok) draft[slot] = { ok: true, text: r.text, refinished: true };
            });
          }
        }

        for (let i = 0; i < b.length; i++) {
          const d = draft[i];
          if (!d.ok) {
            // 哨兵丢了 → 这一条不写（宁缺勿坏），并记账等下次
            failed++;
            log(`  ✕ ${b[i].key}: 占位符缺失 ${d.missing.join(',')}，已丢弃`);
            continue;
          }
          if (looksBroken(d.text, locale, glossary)) {
            // 补译之后**仍然**不合格 → 不写进机器层。
            // 写了会是什么后果：韩语界面上出现一整句中文（真实发生过），
            // 葡语界面上出现「daqui a ⟦0⟧ dias」（哨兵残留，真实发生过），
            // 而且因为「有值」，覆盖度还会显示 100%。不写则回落英文。
            failed++;
            const prev = machine[locale]?.[b[i].key];
            const why = hasStraySentinel(d.text) ? '残留哨兵' : '仍含原文';
            if (looksBroken(prev, locale, glossary)) {
              // 旧值同样是坏的 → 一并清掉，否则「宁缺勿坏」只是句口号：
              // 坏值留在 machine.json 里，界面还是那句中文 / 那个 ⟦0⟧。
              // （旧值是好的话绝不动它 —— 不能因为模型今天状态差就把译文删了。）
              delete machine[locale][b[i].key];
              log(`  ✕ ${b[i].key}: 补译后${why}，已从机器层移除（界面回落英文，下次再试）`);
            } else {
              log(`  ✕ ${b[i].key}: 补译后${why}，未写入（保留原有译文，界面回落英文，下次再试）`);
            }
            continue;
          }
          cache[b[i].ck] = d.text;
          machine[locale] ??= {};
          machine[locale][b[i].key] = d.text;
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
    const pruned = pruneMachine(machine, { zh, en });
    writeMachine(machine);
    log(`\n写入 ${path.relative(ROOT, args.out || OUT_FILE_DEFAULT)}`);
    if (pruned.length) log(`剪掉 ${pruned.length} 条永远不会显示的机器词条（人工层已有 / 原文即英文）`);
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
