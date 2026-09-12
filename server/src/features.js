// features.js — use the LLM to extract structured features from intel items / structured feature extraction
//
// This is one of the main uses of the LLM in this tool: turn "a post body" into **searchable attributes**
// -- names, affiliation (big agency / indie), games played, event type, tags.
// Once extracted, search no longer has to rely on literal hits: remembering only "some big-agency member who plays Mario Kart" is enough to find them.
//
// Three engineering constraints:
//   1. **Cached** (feeds/features.json, keyed by item id): the same item never costs money twice;
//   2. **Capped** (run.featureLimit, 40 items per run by default) and batched (10 per batch),
//      so one run cannot burn through the tokens;
//   3. **Failure does not block the main flow**: if extraction fails, skip it and still emit the report.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { activeProvider, chatRequest } from './llm.js';
import { netFetch } from './net.js';

const BATCH = 10;

function cachePath(cfg) {
  return path.join(resolveDir(cfg, 'feedsDir'), 'features.json');
}

export function loadFeatureCache(cfg) {
  try {
    const f = cachePath(cfg);
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveFeatureCache(cfg, cache) {
  try {
    const f = cachePath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cache, null, 1), 'utf8');
  } catch {
    /* a cache write failure must not affect the run */
  }
}

const SYSTEM = `你是 VTuber / VUP 情报的结构化抽取器。
输入是一批情报条目（可能是 B 站动态、Wiki 修订、新闻标题等）。
对每一条，抽出**已知信息**，不确定的一律留空字符串或空数组，不要猜测、不要编造。
只输出 JSON 数组，不要任何解释文字。`;

function buildPrompt(batch, startIndex) {
  const items = batch.map((it, i) => {
    const text = `${it.title ?? ''} ${it.text ?? ''}`.replace(/\s+/g, ' ').slice(0, 400);
    return `${startIndex + i}. [${it.sourceId}] ${text || '(无正文)'}`;
  });
  return (
    `共 ${batch.length} 条。请输出长度为 ${batch.length} 的 JSON 数组，第 n 个元素对应第 ${startIndex + 0} 条起（依次递增）：\n` +
    `[{"i":${startIndex},"names":["提到的 vtuber/vup 名字"],"agency":"所属事务所或团体，没有就空","indie":true/false,` +
    `"games":["提到的游戏"],"events":["事件类型：毕业/解约/联动/新衣装/3D披露/歌回/耐久回/炎上/开播/其他"],` +
    `"tags":["2-5 个便于检索的标签"],"lang":"zh/ja/en"}]\n\n` +
    `条目：\n${items.join('\n')}`
  );
}

function coerce(obj) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : []);
  return {
    names: arr(obj?.names),
    agency: typeof obj?.agency === 'string' ? obj.agency.trim().slice(0, 40) : '',
    indie: obj?.indie === true,
    games: arr(obj?.games),
    events: arr(obj?.events),
    tags: arr(obj?.tags),
    lang: typeof obj?.lang === 'string' ? obj.lang.slice(0, 8) : '',
  };
}

/**
 * Extract features for a batch of items (with cache and cap).
 * @returns {Promise<{cache:object, extracted:number, skipped:number, error?:string}>}
 */
export async function extractFeatures(cfg, items, log) {
  const p = activeProvider(cfg);
  if (!p.apiKey) return { cache: loadFeatureCache(cfg), extracted: 0, skipped: items.length, error: '未配置 LLM' };

  const cache = loadFeatureCache(cfg);
  const limit = Math.max(0, Number(cfg?.run?.featureLimit ?? 40));
  const todo = items.filter((it) => it.id && !cache[it.id]).slice(0, limit);
  const skipped = items.length - todo.length;
  if (!todo.length) {
    log?.info(`feature extraction: all cached (${items.length} items) / all cached`);
    return { cache, extracted: 0, skipped };
  }

  log?.info(`feature extraction: ${todo.length} to extract (cache hits ${items.length - todo.length})`);
  let extracted = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const req = chatRequest(
      p,
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(batch, i) },
      ],
      { max_tokens: 3000, temperature: 0.1 }
    );
    try {
      const res = await netFetch(
        req.url,
        { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(180000) },
        { cfg }
      );
      const text = await res.text();
      if (!res.ok) {
        log?.warn(`feature extraction failed / extract failed — HTTP ${res.status}`);
        return { cache, extracted, skipped, error: `HTTP ${res.status}` };
      }
      const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
      const m = /\[[\s\S]*\]/.exec(content);
      const arr = m ? JSON.parse(m[0]) : [];
      for (const row of arr) {
        const idx = Number(row?.i);
        const item = batch[idx - i];
        if (!item) continue;
        cache[item.id] = { ...coerce(row), at: new Date().toISOString() };
        extracted++;
      }
      // Also mark items the model did not answer for, so the same batch is not retried every round
      for (const item of batch) if (!cache[item.id]) cache[item.id] = { empty: true, at: new Date().toISOString() };
    } catch (err) {
      log?.warn(`feature extraction error / extract error — ${err.message}`);
      return { cache, extracted, skipped, error: err.message };
    }
  }
  saveFeatureCache(cfg, cache);
  log?.info(`feature extraction done: ${extracted} new / extracted ${extracted}`);
  return { cache, extracted, skipped };
}

/** Attach features back onto items and turn them into searchable tags */
export function applyFeatures(items, cache) {
  return items.map((it) => {
    const f = cache?.[it.id];
    if (!f || f.empty) return it;
    const tags = [
      ...(f.names ?? []),
      ...(f.games ?? []),
      ...(f.events ?? []),
      ...(f.tags ?? []),
      f.agency || '',
      f.indie ? '个人势' : '',
    ].filter(Boolean);
    return { ...it, features: f, feats: [...new Set(tags)] };
  });
}

/** Global feature stats, feeding the search page's "find by feature" column */
export function featureStats(cfg) {
  const cache = loadFeatureCache(cfg);
  const count = (key) => {
    const m = new Map();
    for (const f of Object.values(cache)) {
      const list = Array.isArray(f[key]) ? f[key] : f[key] ? [f[key]] : [];
      for (const v of list) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count);
  };
  return {
    extracted: Object.values(cache).filter((f) => !f.empty).length,
    names: count('names').slice(0, 60),
    games: count('games').slice(0, 40),
    events: count('events').slice(0, 40),
    agencies: count('agency').slice(0, 30),
    tags: count('tags').slice(0, 80),
  };
}
