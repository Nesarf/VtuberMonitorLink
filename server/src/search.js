// search.js — 情报检索 / local search over everything collected
//
// 设计立场（按需求）：**搜索本身不需要 LLM、不需要联网**。
// 它就是一个本地索引 + 关键词/标签/时间区间的匹配器 —— 像查论文、像浏览器里 Ctrl+F，
// 有网没网、有没有配 LLM 都能用。LLM 只在「只记得特征、忘了名字」时作为**可选的**助手出现。
//
// 索引来源：feeds/<date>/_items.json（每次运行落盘的情报条目，含历史）。
// 标签来源：自动标签（来源 / 分类 / 关键词命中 / 正文里的 #话题# 与【名】）+ 用户手打的标签。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

const DAY_MS = 86_400_000;

// ───────────────────────────────────────── 时间归一化

/**
 * B 站给的是相对时间（"8小时前"、"3天前"、"8月29日"），要做时间区间筛选就必须先归一化。
 * 以**该次运行的生成时间**为参照点，而不是「现在」—— 否则翻历史时会算错。
 */
export function parseItemTime(raw, referenceISO) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const ref = referenceISO ? new Date(referenceISO) : new Date();
  if (Number.isNaN(ref.getTime())) return null;

  let m = /^(\d+)\s*(秒|分钟|分|小时|时)前$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = /秒/.test(m[2]) ? 1000 : /分/.test(m[2]) ? 60_000 : 3_600_000;
    return new Date(ref.getTime() - n * unit).toISOString();
  }
  m = /^(\d+)\s*天前$/.exec(s);
  if (m) return new Date(ref.getTime() - Number(m[1]) * DAY_MS).toISOString();
  if (s === '昨天') return new Date(ref.getTime() - DAY_MS).toISOString();
  if (s === '前天') return new Date(ref.getTime() - 2 * DAY_MS).toISOString();
  if (/^今天|^\d+分钟前/.test(s)) return ref.toISOString();

  // "8月29日" / "2025年8月29日"
  m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) {
    const year = m[1] ? Number(m[1]) : ref.getFullYear();
    const d = new Date(year, Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    // 没有年份且比参照点还晚 → 说的是去年
    if (!m[1] && d.getTime() > ref.getTime() + 2 * DAY_MS) d.setFullYear(year - 1);
    return d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ───────────────────────────────────────── 标签词表

const DEFAULT_VOCAB = {
  // 规范名 -> 别名（任一别名命中即算命中该标签）
  // 注意：键名以数字开头的（2434 / 3D披露）必须加引号，否则不是合法标识符
  个人势: ['個人勢', '个人势', 'indie', '个人势vtuber'],
  '2434': ['にじさんじ', '彩虹社', 'nijisanji', '2434'],
  马里奥赛车: ['マリオカート', '马车', 'mario kart', 'mariokart'],
  耐久回: ['耐久', '耐久配信', '耐久回'],
  联动: ['コラボ', 'collab', '联动', '合作'],
  毕业: ['卒業', 'graduation', '毕业'],
  炎上: ['炎上', '争议', '风波'],
  '3D披露': ['3Dお披露目', '3d披露', '3d debut'],
  新衣装: ['新衣装', '新服装', 'new outfit'],
  歌回: ['歌枠', '歌回', '唱歌'],
  杂谈: ['雑談', '杂谈', 'talk'],
  直播: ['配信', '直播', 'live'],
};

function vocabPath(cfg) {
  return path.join(resolveDir(cfg, 'feedsDir'), 'tags.json');
}

export function loadVocab(cfg) {
  try {
    const f = vocabPath(cfg);
    if (!fs.existsSync(f)) return { ...DEFAULT_VOCAB };
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULT_VOCAB, ...(j.tags ?? j) };
  } catch {
    return { ...DEFAULT_VOCAB };
  }
}

export function saveVocab(cfg, tags) {
  const f = vocabPath(cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ tags }, null, 1), 'utf8');
  return tags;
}

/** 把一个检索词展开成它的全部别名 */
export function expandTerm(vocab, term) {
  const t = String(term ?? '').trim();
  if (!t) return [];
  const lower = t.toLowerCase();
  for (const [canon, aliases] of Object.entries(vocab)) {
    const all = [canon, ...(aliases ?? [])];
    if (all.some((a) => String(a).toLowerCase() === lower)) return [...new Set(all.map(String))];
  }
  return [t];
}

// ───────────────────────────────────────── 索引

function listRunDirs(cfg, days) {
  const root = resolveDir(cfg, 'feedsDir');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()
    .slice(0, days);
}

/** 自动标签：来源 / 分类 / 关键词命中 / 正文里的 #话题# 与【名】 */
export function autoTags(item) {
  const out = new Set();
  if (item.sourceId) out.add(`来源:${item.sourceId}`);
  if (item.category) out.add(`分类:${item.category}`);
  for (const k of item.keywords ?? []) out.add(String(k));
  // LLM 抽出来的特征也进标签，这样「只记得玩什么游戏」也能搜到
  for (const k of item.feats ?? []) out.add(String(k));
  for (const k of item.features?.names ?? []) out.add(String(k));
  const text = `${item.title ?? ''} ${item.text ?? ''}`;
  for (const m of text.matchAll(/[#＃]([^#＃\s]{1,20})[#＃]/g)) out.add(m[1]);
  for (const m of text.matchAll(/【([^】\s]{1,20})】/g)) out.add(m[1]);
  for (const m of text.matchAll(/\bat\s+([A-Za-z0-9_\u4e00-\u9fa5-]{2,24})/gi)) out.add(m[1]);
  return [...out];
}

/**
 * 建立索引。可传 days 限制回溯天数。
 * @returns {{items:Array, runs:Array, builtAt:string}}
 */
export function buildIndex(cfg, { days = 60, flags = {} } = {}) {
  const items = [];
  const runs = [];
  for (const d of listRunDirs(cfg, days)) {
    const dir = path.join(resolveDir(cfg, 'feedsDir'), d);
    for (const name of ['_items.json', '_items-prev.json']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const runAt = j.generatedAt ?? `${d}T12:00:00.000Z`;
        runs.push({ date: d, file: name, at: runAt, count: (j.items ?? []).length });
        for (const it of j.items ?? []) {
          const own = parseItemTime(it.time, runAt);
          const withTime = {
            ...it,
            runDate: d,
            runAt,
            // 有些来源没有发布时间（B 站的免登录图文动态就是 pub_time 为空）。
            // 这时用「首次见于哪次运行」兜底，否则时间区间会把这些条目整批排除掉。
            ts: own ?? runAt,
            tsSource: own ? 'item' : 'run',
            tags: [...new Set([...autoTags(it), ...((flags[it.id]?.tags ?? []) || [])])],
          };
          items.push(withTime);
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  }
  // 同一个 id 只留最新一次（后面的覆盖前面的）
  const byId = new Map();
  for (const it of items) byId.set(it.id, it);
  return { items: [...byId.values()], runs, builtAt: new Date().toISOString() };
}

// ───────────────────────────────────────── 检索

const FIELD_SETS = {
  any: (i) => `${i.title ?? ''} ${i.text ?? ''} ${i.url ?? ''} ${i.sourceName?.zh ?? ''} ${i.sourceName?.en ?? ''} ${(i.tags ?? []).join(' ')}`,
  title: (i) => `${i.title ?? ''}`,
  text: (i) => `${i.text ?? ''}`,
  url: (i) => `${i.url ?? ''}`,
  tag: (i) => (i.tags ?? []).join(' '),
  source: (i) => `${i.sourceId ?? ''} ${i.sourceName?.zh ?? ''} ${i.sourceName?.en ?? ''}`,
};

function tokenize(q) {
  return String(q ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 检索。纯字符串匹配 —— 不需要 LLM，不需要联网。
 * @param {object} cfg
 * @param {{q?:string, tags?:string[], source?:string, category?:string, from?:string, to?:string,
 *          field?:string, starred?:boolean, limit?:number, offset?:number, sort?:string, days?:number}} query
 */
export function search(cfg, query = {}, flags = {}) {
  const t0 = Date.now();
  const idx = buildIndex(cfg, { days: Number(query.days) || 60, flags });
  const vocab = loadVocab(cfg);
  const field = FIELD_SETS[query.field] ? query.field : 'any';
  const pick = FIELD_SETS[field];

  const tokens = tokenize(query.q);
  // 每个词展开成别名组；一个组内命中任一别名即可
  const groups = tokens.map((t) => expandTerm(vocab, t).map((x) => x.toLowerCase()));
  const wantTags = (query.tags ?? []).filter(Boolean);

  const from = query.from ? Date.parse(query.from) : null;
  const to = query.to ? Date.parse(query.to) + DAY_MS : null;

  const matched = [];
  let timeFiltered = 0;
  for (const it of idx.items) {
    if (query.source && it.sourceId !== query.source) continue;
    if (query.category && it.category !== query.category) continue;
    if (query.starred && !flags[it.id]?.starred) continue;

    if (from !== null || to !== null) {
      const ts = it.ts ? Date.parse(it.ts) : NaN;
      if (Number.isNaN(ts) || (from !== null && ts < from) || (to !== null && ts > to)) {
        timeFiltered++;
        continue;
      }
    }

    if (wantTags.length) {
      const has = (it.tags ?? []).map((x) => String(x).toLowerCase());
      const ok = wantTags.every((tg) => {
        const aliases = expandTerm(vocab, tg).map((x) => x.toLowerCase());
        return aliases.some((a) => has.some((h) => h === a || h.includes(a)));
      });
      if (!ok) continue;
    }

    if (groups.length) {
      const hay = pick(it).toLowerCase();
      let score = 0;
      let all = true;
      for (const g of groups) {
        const hit = g.some((a) => hay.includes(a));
        if (!hit) {
          all = false;
          break;
        }
        for (const a of g) {
          let p = hay.indexOf(a);
          while (p !== -1) {
            score++;
            p = hay.indexOf(a, p + a.length);
          }
        }
      }
      if (!all) continue;
      matched.push({ ...it, score });
    } else {
      matched.push({ ...it, score: 0 });
    }
  }

  const sort = query.sort === 'time' ? 'time' : 'relevance';
  matched.sort((a, b) => {
    if (sort === 'time') return Date.parse(b.ts ?? b.runAt) - Date.parse(a.ts ?? a.runAt);
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.ts ?? b.runAt) - Date.parse(a.ts ?? a.runAt);
  });

  // 分面（像论文检索左侧那种计数）
  const facet = (list, keyFn) => {
    const m = new Map();
    for (const it of list) for (const k of keyFn(it)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };
  const facets = {
    tags: facet(matched, (i) => i.tags ?? []).slice(0, 40),
    sources: facet(matched, (i) => [i.sourceId]).slice(0, 40),
    categories: facet(matched, (i) => [i.category].filter(Boolean)),
    months: facet(matched, (i) => (i.ts ? [i.ts.slice(0, 7)] : [])).sort((a, b) => (a.value < b.value ? 1 : -1)).slice(0, 24),
  };

  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.max(1, Math.min(500, Number(query.limit) || 60));
  return {
    total: matched.length,
    offset,
    limit,
    took: Date.now() - t0,
    sort,
    field,
    terms: tokens,
    expanded: groups,
    corpus: { items: idx.items.length, runs: idx.runs.length, days: Number(query.days) || 60 },
    // 有时间但落在区间外的条数 —— 让使用者知道「不是没搜到，是被时间条件挡了」
    outsideTimeRange: timeFiltered,
    facets,
    items: matched.slice(offset, offset + limit),
  };
}

/** 词表 + 语料统计，给检索页做标签云 */
export function tagCloud(cfg, flags = {}) {
  const idx = buildIndex(cfg, { days: 60, flags });
  const vocab = loadVocab(cfg);
  const counts = new Map();
  for (const it of idx.items) for (const t of it.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const auto = [...counts.entries()]
    .filter(([t]) => !t.startsWith('来源:'))
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 120);
  return {
    corpus: { items: idx.items.length, runs: idx.runs.length },
    vocabulary: Object.entries(vocab).map(([canon, aliases]) => ({ canon, aliases, count: counts.get(canon) ?? 0 })),
    auto,
  };
}

/** 给 LLM 助手用的语料摘要（只在前端点了「帮我认人」时才会用到） */
export function corpusSample(cfg, limit = 200) {
  const idx = buildIndex(cfg, { days: 30 });
  return idx.items
    .slice(0, limit)
    .map((i) => `${i.sourceId} | ${String(i.text || i.title).replace(/\s+/g, ' ').slice(0, 90)}`);
}
