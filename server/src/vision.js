// vision.js — 图片理解打标 / image understanding & tagging
//
// 用途：把情报里的配图变成**可搜索的标签**。文字特征抽取解决不了「这张图里是什么」——
// 而 VTuber 情报里配图往往就是信息本身（3D 模型截图、周边实物、联动海报、活动合影）。
//
// 需要支持视觉的模型（OpenAI 兼容接口的 image_url 形式）。没有配置时**整块功能不启用**，
// 而不是「调用失败再兜底」—— 因为把图片发到外部服务是隐私相关的动作，必须由使用者明确打开。
//
// 三个工程要点：
//   1) **按图片 URL 缓存**：同一张图不重复花钱（情报会反复出现在多次运行里）
//   2) **解析要宽容**：模型经常在 JSON 外面裹一段解释、或者把数组写成字符串 ——
//      这些都当成「可恢复」处理并记下来，而不是整批失败
//   3) **并发受限**：一次运行几十张图不能同时打出去（既慢又容易被限流）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDir } from './config.js';
import { activeProvider, chatRequest } from './llm.js';
import { netFetch } from './net.js';

/** 允许的图片类型（模型能看的东西就这几种） */
export const IMAGE_KINDS = ['illustration', 'screenshot', 'photo', 'meme', 'merch', 'poster', 'event', 'other'];

export const DEFAULT_PROMPT = [
  'You are tagging images attached to VTuber news posts. Look at the image and answer with JSON only.',
  'Schema: {"kind":"illustration|screenshot|photo|meme|merch|poster|event|other","tags":["..."],"text":"any text visible in the image, or empty","people":["names if recognisable, else empty"],"confidence":0..1}',
  'Rules: tags must be short (1-3 words), in the same language as the post if possible; do not guess identities you cannot read;',
  'if the image is mostly text, set kind="poster" or "screenshot" and put the text in "text".',
].join(' ');

export function visionPath(cfg) {
  return path.join(resolveDir(cfg, 'feedsDir'), 'vision.json');
}

export function loadVisionCache(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(visionPath(cfg), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    /* 没有缓存就从空开始 */
  }
  return {};
}

export function saveVisionCache(cfg, cache) {
  const p = visionPath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // 落盘失败不该让打标流程崩
  }
}

/** 同一张图的缓存键：URL 归一化后的哈希（去掉会变的查询参数里的签名段） */
export function imageKey(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  return crypto.createHash('sha256').update(s.split('?')[0]).digest('hex').slice(0, 16);
}

/**
 * 是否具备打标条件。
 * @returns {{ok:boolean, reason?:string, provider?:object}}
 */
export function visionReady(cfg) {
  if (cfg?.vision?.enabled !== true) {
    return { ok: false, reason: '图片打标未启用（它会把图片发送到外部服务，所以必须由你明确开启）' };
  }
  const providers = (cfg?.llm?.providers ?? []).filter((p) => p?.apiKey);
  if (!providers.length) {
    // 兼容旧的平铺格式（llm.apiKey）
    if (!cfg?.llm?.apiKey) return { ok: false, reason: '没有配置带 API Key 的模型档位' };
  }
  const picked = activeProvider(cfg);
  if (!picked?.apiKey) return { ok: false, reason: '没有配置带 API Key 的模型档位' };
  if (cfg.vision?.requireVisionModel !== false && picked?.vision === false) {
    return { ok: false, reason: `档位「${picked.name ?? picked.id}」被标记为不支持视觉（可在设置里改）` };
  }
  return { ok: true, provider: picked };
}

/**
 * 从模型回复里抠出结构化标签。
 * 宽容处理：外面裹解释、```json 围栏、标签写成逗号串、confidence 写成字符串 —— 都当可恢复。
 */
export function parseTags(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '空回复' };
  // 先剥掉 ``` 围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  // 再取第一个平衡的花括号片段
  let candidate = body.trim();
  const start = candidate.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let end = -1;
    let inStr = null;
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'") inStr = c;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > start) candidate = candidate.slice(start, end + 1);
  }
  let obj = null;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return { ok: false, error: '回复里没有可解析的 JSON' };
  }
  const asList = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean);
    return [];
  };
  const kind = IMAGE_KINDS.includes(String(obj.kind)) ? String(obj.kind) : 'other';
  const conf = Number(obj.confidence);
  return {
    ok: true,
    tags: asList(obj.tags).slice(0, 12),
    kind,
    text: String(obj.text ?? '').trim().slice(0, 300),
    people: asList(obj.people).slice(0, 6),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
  };
}

/** 给一张图打标（不缓存、不重试 —— 那些在上层） */
export async function tagOneImage(cfg, { url, provider, context = '', prompt = null, log = null }) {
  const model = provider?.model ?? '';
  const messages = [
    { role: 'system', content: prompt ?? cfg?.vision?.prompt ?? DEFAULT_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: context ? `Post context: ${context.slice(0, 300)}` : 'Tag this image.' },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ];
  // 与 features.js 同一套调用方式：chatRequest 只组装请求描述，抓取自己做
  const req = chatRequest(provider, messages, {
    max_tokens: Number(cfg?.vision?.maxTokens ?? 300),
    temperature: 0,
  });
  try {
    const res = await netFetch(
      req.url,
      { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(Number(cfg?.vision?.timeoutMs ?? 60000)) },
      { cfg }
    );
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    let content = '';
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      return { ok: false, error: '响应不是 JSON（接口地址对吗？）' };
    }
    const parsed = parseTags(content);
    if (!parsed.ok) return { ok: false, error: parsed.error, raw: String(content).slice(0, 200) };
    return { ok: true, ...parsed, model };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}

/** 简单并发池：一次运行几十张图不能同时打出去 */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 给一批情报里的配图打标。
 * @param {object} o
 * @param {object[]} o.items 情报条目（每条可有 images: string[]）
 * @param {number} o.limit 本次最多处理多少张图
 * @param {boolean} o.force 忽略缓存
 */
export async function tagItems(cfg, { items = [], limit = 40, force = false, concurrency = null, log = null } = {}) {
  const ready = visionReady(cfg);
  if (!ready.ok) return { ok: false, error: ready.reason, tagged: 0, skipped: 0, cached: 0 };

  const cache = loadVisionCache(cfg);
  const jobs = [];
  let cachedHits = 0;
  for (const it of items) {
    for (const url of it?.images ?? []) {
      const key = imageKey(url);
      if (!key) continue;
      if (!force && cache[key]?.ok) {
        cachedHits++;
        continue;
      }
      jobs.push({ key, url, item: it });
      if (jobs.length >= Math.max(1, Number(limit) || 40)) break;
    }
    if (jobs.length >= Math.max(1, Number(limit) || 40)) break;
  }

  const results = await pool(
    jobs,
    concurrency ?? Number(cfg?.vision?.concurrency ?? 2),
    async (job) => {
      const r = await tagOneImage(cfg, {
        url: job.url,
        provider: ready.provider,
        context: [job.item?.title, job.item?.text].filter(Boolean).join(' · '),
        log,
      });
      return { ...job, result: r };
    }
  );

  let tagged = 0;
  let failed = 0;
  for (const row of results) {
    if (!row) continue;
    if (row.result?.ok) {
      cache[row.key] = {
        ok: true,
        url: row.url,
        kind: row.result.kind,
        tags: row.result.tags,
        text: row.result.text,
        people: row.result.people,
        confidence: row.result.confidence,
        model: row.result.model,
        at: new Date().toISOString(),
      };
      tagged++;
    } else {
      failed++;
      // 失败也记一笔（但标记 ok:false，下次仍会重试）—— 免得每轮都对同一张坏图反复花钱
      cache[row.key] = { ok: false, url: row.url, error: row.result?.error ?? 'unknown', at: new Date().toISOString() };
    }
  }
  if (tagged || failed) saveVisionCache(cfg, cache);
  return { ok: true, tagged, failed, cached: cachedHits, total: jobs.length, provider: ready.provider?.name ?? ready.provider?.id ?? null };
}

/**
 * 把缓存里的标签贴回情报条目（读时合并，和特征抽取一样）。
 * 这样界面与检索都不需要知道缓存机制。
 */
export function applyVisionTags(items, cache, { inheritKeywords = true } = {}) {
  const out = [];
  const tagCount = {};
  for (const it of items ?? []) {
    const hits = [];
    for (const url of it?.images ?? []) {
      const c = cache?.[imageKey(url)];
      if (c?.ok) hits.push({ url, kind: c.kind, tags: c.tags, text: c.text, people: c.people });
    }
    if (!hits.length) {
      out.push(it);
      continue;
    }
    const tags = [...new Set(hits.flatMap((h) => h.tags ?? []))];
    const kinds = [...new Set(hits.map((h) => h.kind).filter(Boolean))];
    for (const t of tags) tagCount[t] = (tagCount[t] ?? 0) + 1;
    // 图片标签也能被检索命中（和文字关键词同一套检索路径）
    const keywords = inheritKeywords ? [...new Set([...(it.keywords ?? []), ...tags])] : it.keywords ?? [];
    out.push({
      ...it,
      imageTags: tags,
      imageKinds: kinds,
      imageText: hits.map((h) => h.text).filter(Boolean).join(' / ').slice(0, 300),
      keywords,
    });
  }
  return { items: out, tagCount };
}

/** 打标统计（界面用） */
export function visionStats(cfg) {
  const cache = loadVisionCache(cfg);
  const entries = Object.values(cache);
  const ok = entries.filter((e) => e?.ok);
  const kinds = {};
  const tags = {};
  for (const e of ok) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    for (const t of e.tags ?? []) tags[t] = (tags[t] ?? 0) + 1;
  }
  return {
    enabled: cfg?.vision?.enabled === true,
    images: entries.length,
    tagged: ok.length,
    failed: entries.filter((e) => e && e.ok === false).length,
    kinds,
    topTags: Object.entries(tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count })),
  };
}
