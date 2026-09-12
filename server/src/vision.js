// vision.js — image understanding and tagging / image understanding & tagging
//
// Purpose: turn the images attached to intel into **searchable tags**. Text feature extraction cannot
// answer "what is in this picture" -- while in VTuber intel an attached image often *is* the
// information (3D model screenshots, physical merch, collab posters, event group photos).
//
// Needs a vision-capable model (the OpenAI-compatible `image_url` form). With nothing configured the
// **whole feature stays off**, rather than "call it and fall back when it fails" -- because sending
// images to an external service is a privacy-relevant act and has to be switched on explicitly by the user.
//
// Three engineering points:
//   1) **Cache by image URL**: the same image is never paid for twice (intel repeats across runs)
//   2) **Parse tolerantly**: models often wrap the JSON in a paragraph of prose, or write an array as a
//      string -- all of that counts as "recoverable" and gets recorded, instead of failing the whole batch
//   3) **Bounded concurrency**: dozens of images in one run must not be fired all at once (slow, and easily rate-limited)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDir } from './config.js';
import { activeProvider, chatRequest } from './llm.js';
import { netFetch } from './net.js';

/** Allowed image kinds (these are the only things a model can see) */
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
    /* start from empty when there is no cache */
  }
  return {};
}

export function saveVisionCache(cfg, cache) {
  const p = visionPath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // A failed write to disk must not bring the tagging run down
  }
}

/** Cache key for one image: hash of the normalized URL (dropping the signature segment in the query string, which keeps changing) */
export function imageKey(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  return crypto.createHash('sha256').update(s.split('?')[0]).digest('hex').slice(0, 16);
}

/**
 * Whether tagging is available at all.
 * @returns {{ok:boolean, reason?:string, provider?:object}}
 */
export function visionReady(cfg) {
  if (cfg?.vision?.enabled !== true) {
    return { ok: false, reason: '图片打标未启用（它会把图片发送到外部服务，所以必须由你明确开启）' };
  }
  const providers = (cfg?.llm?.providers ?? []).filter((p) => p?.apiKey);
  if (!providers.length) {
    // Tolerate the old flat format (llm.apiKey)
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
 * Dig structured tags out of a model reply.
 * Tolerant handling: wrapped in prose, a ```json fence, tags written as a comma string, confidence
 * written as a string -- all of it counts as recoverable.
 */
export function parseTags(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '空回复' };
  // strip the ``` fence first
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  // then take the first balanced brace segment
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

/** Transport-layer errors (connection closed by the peer, a pooled socket that happened to be dead...) -- only these deserve a retry as-is */
export function isTransportError(error) {
  return /ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT|socket hang up|other side closed|terminated|fetch failed|ECONNABORTED|ETIMEDOUT/i.test(
    String(error ?? '')
  );
}

/** Tag one image (no caching; one retry on transport errors, none on HTTP/parse errors) */
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
  // Same calling convention as features.js: chatRequest only assembles the request description, the fetching is ours
  const req = chatRequest(provider, messages, {
    max_tokens: Number(cfg?.vision?.maxTokens ?? 300),
    temperature: 0,
  });
  const attempt = async () => {
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
  };
  let out = await attempt();
  // Retry only on a **transport-layer** failure, and record the retry in the return value (`retried: 1`),
  // so that "it occasionally has to retry" stays visible in the report and in the self-check instead of
  // being quietly smoothed over.
  // HTTP errors (401/429/500...) and parse failures are **not** retried: retrying those changes nothing.
  if (!out.ok && isTransportError(out.error)) {
    if (log) log(`vision: transport failure, retrying once (${out.error})`);
    const again = await attempt();
    out = { ...again, retried: 1, firstError: out.error };
  }
  return out;
}

/** A simple concurrency pool: dozens of images in one run must not all be fired at once */
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
 * Tag the images of a batch of intel items.
 * @param {object} o
 * @param {object[]} o.items intel items (each may carry images: string[])
 * @param {number} o.limit how many images to process at most in this run
 * @param {boolean} o.force ignore the cache
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
  let retried = 0;
  const errors = [];
  for (const row of results) {
    if (!row) continue;
    if (row.result?.retried) retried++;
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
      // Record the failure too (but mark it ok:false, so the next run still retries) -- otherwise every
      // round pays again for the same broken image
      const err = row.result?.error ?? 'unknown';
      cache[row.key] = { ok: false, url: row.url, error: err, at: new Date().toISOString() };
      // Carry out **why** it failed (at most 5): with only a number, a failing end-to-end self-check
      // shows `failed:1` and you cannot tell network from auth from parsing (learnt the hard way)
      if (errors.length < 5) errors.push({ url: row.url, error: err });
    }
  }
  if (tagged || failed) saveVisionCache(cfg, cache);
  return { ok: true, tagged, failed, cached: cachedHits, total: jobs.length, retried, errors, provider: ready.provider?.name ?? ready.provider?.id ?? null };
}

/**
 * Paste the cached tags back onto the intel items (merged at read time, same as feature extraction).
 * That way neither the UI nor search has to know about the caching mechanism.
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
    // Image tags are hit by search as well (the same search path as text keywords)
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

/** Tagging statistics (for the UI) */
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
