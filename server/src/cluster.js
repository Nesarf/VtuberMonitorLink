// cluster.js — 多源同事件合并 / 相似度去重 / 来源权重
//
// 要解决的问题：同一件事会被多个来源各报一遍（官方公告 + 新闻站 + 社区转发），
// 使用者的信息流于是被刷成三份重复。而对「提前预警」来说更糟的是：
// 重复会稀释信噪比，让人漏掉真正的新东西。
//
// 三个部分：
//   1) **相似度**：中文没有词边界，所以用**字符 bigram**（「嘉然生日」→ 嘉然/然生/生日）；
//      拉丁文本用词 token。两者合起来算 Dice 系数。
//   2) **聚类**：单遍增量聚类 + 时间窗。同一件事的定义是「文本够像 **且** 时间够近」，
//      光靠文本会把「去年的同一活动」也并进来。
//   3) **来源权重**：官方公告 > 新闻站 > 社区转发。除了静态基准，还会**从历史里学**：
//      谁最先报出来（在每个事件簇里时间最早）谁就更可信。这是「多源确认」与
//      「信源排序」的依据，也让使用者知道一件事是不是已经被多方证实。
//
// 性能：不做 O(n²) 全比较 —— 先按「日历日」分桶，只在同桶与相邻桶之间比，
// 每个条目最多比 CANDIDATE_CAP 个候选。2000 条也能在毫秒级完成。

/** 拉丁停用词：这些词在标题里几乎无意义，参与相似度只会拉高假阳性 */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'new', 'news',
  'official', 'announce', 'announcement', 'update', 'info', 'release', 'about', 'from',
  'is', 'are', 'was', 'be', 'by', 'at', 'as', 'it', 'its', 'this', 'that', 'we', 'you',
]);

export const DEFAULT_THRESHOLD = 0.52;
export const DEFAULT_WINDOW_HOURS = 72;
const CANDIDATE_CAP = 60;

/** 中日韩统一表意文字 + 假名 + 韩文 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

/**
 * 把文本切成用于比较的 token。
 * · CJK 取单字 + 相邻 bigram（bigram 提供精度，单字提供召回）
 * · 拉丁取小写词（去掉停用词与单字符）
 * · 日期/数字单独保留 —— 「3月15日」这种是事件同一性的强信号
 */
export function tokens(text) {
  const s = String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .toLowerCase();
  const out = new Set();
  // 数字串（含日期）：3 15 2026 / 3.15 等
  for (const m of s.matchAll(/\d+/g)) if (m[0].length >= 2 || /^\d$/.test(m[0])) out.add('#' + m[0]);

  const cjk = [...s].filter((c) => CJK.test(c));
  for (const c of cjk) out.add(c);
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk[i] + cjk[i + 1]);

  const latin = s
    .replace(/[^\p{Script=Latin}\p{Nd}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  for (const w of latin) out.add(w);
  return out;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，对长度差异比 Jaccard 宽容一些 */
export function similarity(a, b) {
  const A = a instanceof Set ? a : tokens(a);
  const B = b instanceof Set ? b : tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 文档频率 → IDF 权重。
 *
 * 为什么必须加权：新闻标题里充满**廉价的高频套话**（「官方公告」「最新消息」
 * 「将于…举行」），它们会让任何两条标题都显得很像。IDF 把「这一批里到处都是的词」
 * 降到几乎不计分，只留下真正区分事件的内容词（人名、日期、活动名）。
 * 这是「相似度」这类功能最容易忽略、也最关键的一步。
 */
export function buildIdf(tokenSets) {
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, tokenSets.length);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(n / d) + 1);
  return idf;
}

/** IDF 加权 Dice：权重和之比 */
export function weightedSimilarity(A, B, idf) {
  if (!A?.size || !B?.size) return 0;
  const w = (t) => idf?.get(t) ?? 1;
  let inter = 0;
  let total = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) {
    const weight = w(t);
    total += weight;
    if (big.has(t)) inter += weight;
  }
  for (const t of big) if (!small.has(t)) total += w(t);
  if (!total) return 0;
  return (2 * inter) / total;
}

function tsOf(item) {
  const raw = item?.publishedAt ?? item?.at ?? item?.ts ?? item?.time ?? null;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** 条目文本：标题权重高，所以标题单独参与比较 */
function textOf(item) {
  const parts = [item?.title, item?.text, item?.summary, item?.contentText, item?.content].filter(Boolean);
  return parts.join(' ').slice(0, 1200);
}

// ───────────────────────────────────────────── 来源权重

/** 静态基准：越靠上游越可信。可在配置里按来源覆盖。 */
export const BASE_WEIGHT = {
  official: 1.5, // 官方公告
  news: 1.2, // 新闻站
  wiki: 1.0,
  bili: 1.1, // 本人账号动态
  live: 0.9,
  resource: 0.9,
  community: 0.8, // 社区转发
  social: 0.7, // 社交平台（噪音最大）
  custom: 1.0,
  other: 1.0,
};

export function weightPath(cfg) {
  return null; // 由调用方给目录，见 loadWeights
}

/**
 * 计算每个来源的当前权重。
 * @param {object} cfg
 * @param {object} history { firstSeen: { [sourceId]: n }, totalEvents: n }
 * @returns {(sourceId:string)=>number}
 */
export function makeWeighter(cfg, history = {}) {
  const overrides = cfg?.sourceWeights ?? {};
  const seen = history?.firstSeen ?? {};
  const total = Math.max(1, history?.totalEvents ?? 0);
  const cache = new Map();
  return (sourceId) => {
    if (!sourceId) return 1;
    if (cache.has(sourceId)) return cache.get(sourceId);
    const cat = String(sourceId).split('-')[0];
    const base = Number(overrides[sourceId] ?? BASE_WEIGHT[cat] ?? BASE_WEIGHT.other);
    // 「最先报出来」的比例：0 次 → 不加分；长期第一 → 最多 +40%
    const rate = (seen[sourceId] ?? 0) / total;
    const learned = 1 + Math.min(0.4, rate);
    const w = Math.max(0.2, Math.min(3, base * learned));
    cache.set(sourceId, w);
    return w;
  };
}

/**
 * 记一次「谁最先报的」。用于让权重从历史里长出来。
 * @returns {object} 新的 history
 */
export function recordFirstReporter(history, sourceId) {
  const h = { firstSeen: { ...(history?.firstSeen ?? {}) }, totalEvents: (history?.totalEvents ?? 0) + 1 };
  if (sourceId) h.firstSeen[sourceId] = (h.firstSeen[sourceId] ?? 0) + 1;
  return h;
}

// ───────────────────────────────────────────── 聚类

/** 单调递增的簇 id，保证结果稳定（不看输入顺序） */
function clusterId(seed) {
  return 'ev-' + String(seed).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

/**
 * 把条目聚成「事件」。
 * @param {object[]} items
 * @param {object} opts
 * @param {(id:string)=>number} opts.weight 来源权重函数
 * @param {number} opts.threshold Dice 阈值
 * @param {number} opts.windowHours 时间窗（超过就不算同一件事）
 * @param {number} opts.max 最多处理多少条（防止意外爆量）
 */
/**
 * 「必须共享罕见词」闸门。
 *
 * 为什么需要它：新闻标题里大量字节是**套话**（「官方公告：…将于…举行」），
 * 光看加权相似度，两条只差一个数字的标题也会很像 —— 于是一串条目会被链成
 * 一个大簇（实测：2000 条合成数据被并成 1 个事件）。
 * 同一件事一定共享至少一个**这一批里罕见**的词（人名、活动名、特殊日期）。
 * 只共享套话不算同一件事。
 */
function sharesRareToken(A, B, idf, docCount) {
  const rareDf = Math.max(2, Math.ceil(docCount * 0.05));
  const rareIdf = Math.log(Math.max(2, docCount) / rareDf) + 1;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (big.has(t) && (idf.get(t) ?? 1) >= rareIdf) return true;
  return false;
}

/** 数字/日期 token：事件同一性的强信号（'#15' 这种） */
function numberTokens(set) {
  return [...set].filter((t) => t.startsWith('#'));
}

/** 两边的数字集合是否有交集；两边都没有数字时返回 true（无从比较，不算否决） */
function numbersCompatible(A, B) {
  const a = numberTokens(A);
  const b = numberTokens(B);
  if (!a.length && !b.length) return true;
  const bs = new Set(b);
  return a.some((t) => bs.has(t));
}

export function cluster(items, opts = {}) {
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  const windowMs = Number(opts.windowHours ?? DEFAULT_WINDOW_HOURS) * 3600_000;
  const weigh = opts.weight ?? (() => 1);
  const max = Number(opts.max ?? 4000);

  // ⚠️ 先做**规范化排序**：贪心/单链接都依赖处理顺序，直接吃输入顺序会让
  // 同一批数据换个顺序得到不同结果（自检里「与输入顺序无关」这条就是抓它）。
  const list = (items ?? [])
    .filter(Boolean)
    .slice(0, max)
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ta = tsOf(a.it);
      const tb = tsOf(b.it);
      if (ta === null && tb !== null) return 1;
      if (tb === null && ta !== null) return -1;
      if (ta !== tb) return (ta ?? 0) - (tb ?? 0);
      return String(a.it.id ?? a.i).localeCompare(String(b.it.id ?? b.i));
    })
    .map((x) => x.it);

  const prepared = list.map((it, i) => ({
    item: it,
    tokens: tokens(textOf(it)),
    titleTokens: tokens(it?.title ?? ''),
    ts: tsOf(it),
    idx: i,
    people: new Set(it?.people ?? []),
  }));
  const idf = buildIdf(prepared.map((p) => p.tokens));
  const docCount = prepared.length;

  // 先按日历日分桶，只比较同桶与相邻桶 —— 不做 O(n²)
  const buckets = new Map();
  const dayOf = (p) => (p.ts === null ? 'unknown' : new Date(p.ts).toISOString().slice(0, 10));
  prepared.forEach((p, i) => {
    const d = dayOf(p);
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(i);
  });

  // ── 单链接：把「够像」的条目两两连边，再用并查集合并成连通分量。
  // 用并查集而不是「种子 + 吸收」：后者会让先出现的条目落单
  // （i1~i3 像、i2~i3 像，但 i1~i2 不像 → 三条本该是一件，却并成两簇）。
  const parent = prepared.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); // 取小编号，保证稳定
  };

  let edges = 0;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const day = dayOf(p);
    const candidateDays = p.ts === null ? [...buckets.keys()] : neighbourDays(day);
    const candidates = [];
    for (const d of candidateDays) for (const j of buckets.get(d) ?? []) if (j > i) candidates.push(j);
    candidates.sort((a, b) => Math.abs((prepared[a].ts ?? 0) - (p.ts ?? 0)) - Math.abs((prepared[b].ts ?? 0) - (p.ts ?? 0)));

    let compared = 0;
    for (const j of candidates) {
      if (compared++ >= CANDIDATE_CAP) break;
      const q = prepared[j];
      if (p.ts !== null && q.ts !== null && Math.abs(p.ts - q.ts) > windowMs) continue;
      const sim = weightedSimilarity(p.tokens, q.tokens, idf);
      const titleSim = weightedSimilarity(p.titleTokens, q.titleTokens, idf);
      const score = Math.max(sim, titleSim * 0.95);
      // 闸门：必须共享一个这一批里罕见的词，**或者**两条几乎一样且数字/日期对得上。
      //
      // 两个条件都是踩出来的：
      //  · 只看罕见词 → 内容完全相同的重复报道里每个词的 df 都等于文档数、
      //    一个罕见词都不剩，真正的重复被全部漏掉（20 条一模一样的条目一条没合并）。
      //  · 只加「相似度 ≥ 0.8」→ 只差一个编号的两条也会被并（60 条各成一件事的数据
      //    被链成 1 个簇）。所以再加一条：数字/日期必须兼容 ——
      //    真重复的数字当然一致，只差编号的就不是同一件事。
      if (!sharesRareToken(p.tokens, q.tokens, idf, docCount)) {
        if (score < 0.8 || !numbersCompatible(p.tokens, q.tokens)) continue;
      }
      const samePerson = p.people.size && q.people.size && [...p.people].some((x) => q.people.has(x));
      // 两边都标了人、但人不一样 → 门槛大幅提高：
      // 一旦误并，等于把 A 的事件挂到 B 头上，这是最难发现、后果最重的错误方向
      const disjointPeople = p.people.size > 0 && q.people.size > 0 && !samePerson;
      let need = threshold;
      if (samePerson && titleSim >= 0.3) need = Math.min(threshold, 0.38);
      else if (disjointPeople) need = Math.max(threshold, 0.78);
      if (score < need) continue;
      union(i, j);
      edges++;
    }
  }

  const groups = new Map();
  for (let i = 0; i < prepared.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const built = [...groups.values()].map((ms, k) => buildCluster(k, ms.map((m) => prepared[m]), weigh, { edges }));

  // 稳定排序：先按时间（未知的排最后），再按权重
  built.sort((a, b) => {
    const ta = a.firstAt ? Date.parse(a.firstAt) : -1;
    const tb = b.firstAt ? Date.parse(b.firstAt) : -1;
    return tb - ta || b.weight - a.weight;
  });
  return built;
}

function neighbourDays(day) {
  const base = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(base)) return [day];
  return [0, -1, 1].map((d) => new Date(base + d * 86400000).toISOString().slice(0, 10));
}

function buildCluster(seed, members, weigh, meta = {}) {
  const items = members.map((m) => m.item);
  const times = members.map((m) => m.ts).filter((t) => t !== null).sort((a, b) => a - b);
  const sources = [...new Set(items.map((i) => i.sourceId).filter(Boolean))];
  const weighed = items
    .map((it) => ({ it, w: weigh(it.sourceId) }))
    .sort((a, b) => b.w - a.w || String(a.it.id).localeCompare(String(b.it.id)));
  const best = weighed[0]?.it ?? items[0] ?? {};
  // 最先报出来的来源：多源确认与「学习权重」都用它
  const earliest = members
    .filter((m) => m.ts !== null)
    .sort((a, b) => a.ts - b.ts)[0];
  const totalWeight = weighed.reduce((n, x) => n + x.w, 0);
  return {
    id: clusterId(best.id ?? best.url ?? best.title ?? String(seed)),
    title: best.title ?? String(best.text ?? '').slice(0, 100),
    url: best.url ?? null,
    firstAt: times.length ? new Date(times[0]).toISOString() : null,
    lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    sources,
    sourceCount: sources.length,
    items: weighed.map((x) => x.it),
    weight: Number(totalWeight.toFixed(3)),
    leadSourceId: best.sourceId ?? null,
    firstSourceId: earliest ? items[earliest.idx - members[0].idx]?.sourceId ?? members[0].item.sourceId : null,
    people: [...new Set(items.flatMap((i) => i.people ?? []))],
    duplicateCount: Math.max(0, items.length - 1),
    // 多源确认：≥2 个来源报道同一件事时，可信度明显更高
    confirmed: sources.length >= 2,
    similarity: meta.sim ?? null,
  };
}

/**
 * 相似度去重：同一事件只留**权重最高**的那一条，并说明丢了什么。
 * 与 cluster 不同：这个不改变顺序、只做去重，适合直接接在信息流上。
 */
export function dedupe(items, { weight = () => 1, threshold = DEFAULT_THRESHOLD, windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const clusters = cluster(items, { weight, threshold, windowHours });
  const kept = [];
  const dropped = [];
  for (const c of clusters) {
    const winner = c.items[0];
    kept.push(winner);
    for (const it of c.items.slice(1)) {
      dropped.push({ id: it.id, sourceId: it.sourceId ?? null, keptId: winner.id, eventId: c.id });
    }
  }
  // 保持与输入一致的时间顺序（未知时间放最后）
  kept.sort((a, b) => (tsOf(b) ?? -1) - (tsOf(a) ?? -1));
  return { kept, dropped, events: clusters };
}

/** 给界面用的一份汇总 */
export function clusterStats(clusters) {
  const multi = clusters.filter((c) => c.confirmed);
  const bySource = {};
  for (const c of clusters) for (const s of c.sources) bySource[s] = (bySource[s] ?? 0) + 1;
  return {
    events: clusters.length,
    itemsMerged: clusters.reduce((n, c) => n + c.items.length, 0),
    confirmedEvents: multi.length,
    duplicatesRemoved: clusters.reduce((n, c) => n + c.duplicateCount, 0),
    leadSources: Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, n]) => ({ id, events: n })),
  };
}

// ───────────────────────────────────────────── 权重历史（持久化）

function historyPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'source-weight.json');
}

export function loadWeightHistory(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(cfg), 'utf8'));
    if (raw && typeof raw === 'object') return { firstSeen: raw.firstSeen ?? {}, totalEvents: raw.totalEvents ?? 0 };
  } catch {
    // 没有历史就从零开始，不是错误
  }
  return { firstSeen: {}, totalEvents: 0 };
}

export function saveWeightHistory(cfg, history) {
  try {
    const p = historyPath(cfg);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(history, null, 2), 'utf8');
  } catch {
    // 落盘失败不影响本次运行
  }
}

/**
 * 跑一次聚类 + 把「谁先报的」记进历史（权重因此会随使用时间自己长出来）。
 * @returns {{clusters:object[], stats:object, weights:object}}
 */
export function runClustering(cfg, items, opts = {}) {
  const history = loadWeightHistory(cfg);
  const weigh = makeWeighter(cfg, history);
  const clusters = cluster(items, {
    weight: weigh,
    threshold: Number(cfg?.cluster?.threshold ?? DEFAULT_THRESHOLD),
    windowHours: Number(cfg?.cluster?.windowHours ?? DEFAULT_WINDOW_HOURS),
    ...opts,
  });
  if (opts.learn !== false) {
    let h = history;
    for (const c of clusters) if (c.items.length > 1 && c.firstSourceId) h = recordFirstReporter(h, c.firstSourceId);
    if (h !== history) saveWeightHistory(cfg, h);
  }
  const weights = {};
  for (const c of clusters) for (const s of c.sources) if (!(s in weights)) weights[s] = Number(weigh(s).toFixed(3));
  return { clusters, stats: clusterStats(clusters), weights };
}
