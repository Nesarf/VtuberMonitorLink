// analyze.js — analysis layer: hand the fetch digests to the LLM and get a structured intel report back
// Talks to an OpenAI-compatible /chat/completions directly, with no vendor-specific SDK.
// The profile (provider / model / key) comes from activeProvider() in llm.js; the web UI can switch between several.
import { digestResult, digestWatch } from './digest.js';
import { activeProvider, chatRequest } from './llm.js';
import { netFetch } from './net.js';

const SYSTEM_PROMPT = `你是 VTuber 情报监测助手。你会收到三类输入：
(A) 本工具已抓取的「来源摘要」（Reddit / Fandom / Twitch / 百科 / 官方公告 / B 站动态等）；
(B) 「监视对象」的变更结果（页面修订、内容 diff、最近更改命中规则、B 站新动态与关注量变化）；
(C) 你需要自行覆盖的检索方向。
请产出一份结构化中文 Markdown 报告，要求：
1. 开头写「生成日期」与「数据来源清单」（逐条列出本次实际用到的来源）；
2. 单列一节【监视告警】，把命中告警规则的变更按紧急度排序，写清改了什么、谁改的、变化量；
3. 单列一节【B 站动态】，图文动态按时间倒序，保留原文关键句，不要改写原意；
4. 严格区分【已确认事实】与【传闻/未证实】，传闻一律单列，不得与事实混写；
5. 每条结论尽量附来源 URL；
6. 重点关注：批量毕业、解约/终止契约、事务所重组或倒闭、重大丑闻、平台政策变动、破纪录事件；
7. 若某来源本次未取到，如实声明，不要编造。
只输出 Markdown 报告本身，不要输出任何额外说明。`;

const MERCH_SYSTEM_PROMPT = `你是 VTuber 情报监测助手，本次专门监测「资源 / 抖内 / 通贩」平台动态。
重点平台：Pixiv FANBOX、Ci-en、BOOTH、DLsite。
关注：资源页开新或关闭、限时通贩、新作发布、付费内容争议、抖内相关事件。
产出结构化中文 Markdown，开头写生成日期；严格区分【已确认】与【传闻】；每条附来源 URL。`;

function buildUserPrompt({ digests, watchResults, mode, keywords }) {
  const parts = [];
  parts.push(`# 本次抓取来源摘要（共 ${digests.length} 条）\n`);
  for (const d of digests) {
    parts.push(`## ${d.source.id} — ${d.source.name?.zh ?? d.source.id}`);
    parts.push(`URL: ${d.source.url ?? '(检索类)'}`);
    parts.push(`登录要求: ${d.source.login}`);
    parts.push('');
    parts.push(d.ok || d.items?.length ? d.digest : `⚠️ 本次未取到：${d.error ?? 'unknown'}`);
    parts.push('');
  }

  if (watchResults?.length) {
    parts.push('---');
    parts.push(`# 监视对象检查结果（共 ${watchResults.length} 个对象）\n`);
    parts.push(digestWatch(watchResults) || '（本次无监视对象）');
    parts.push('');
  }

  if (keywords?.length) {
    parts.push('---');
    parts.push(`# 本次重点关注的关键词\n${keywords.join('、')}\n命中这些词的条目请在报告里置顶或显著标出。`);
  }

  parts.push('---');
  parts.push(
    mode === 'merch'
      ? '请基于以上材料，并结合你自己的检索能力（如可用），输出「通贩/付费内容」方向的监测报告。'
      : `请结合以上材料与你的检索能力，补全以下方向的覆盖（若某方向无法覆盖请如实说明）：
- Twitter/X（官方账号与爆料账号）
- YouTube（官方频道公告）
- Fandom Virtual YouTuber Wiki
- Reddit 各 VTuber 子版
- 萌娘百科（作背景与考据）
- B 站（UP 主动态、评论区风向）
- ANN / KAI-YOU / 4Gamers / KAORI Nusantara 等新闻站`
  );
  return parts.join('\n');
}

/**
 * @param {{cfg:object, results:Array, watchResults?:Array, mode:string, log:object}} args
 * @returns {Promise<{ok:boolean, markdown?:string, error?:string, provider?:object}>}
 */
export async function analyze({ cfg, results, watchResults = [], mode = 'daily', log }) {
  const p = activeProvider(cfg);
  if (!p.apiKey) {
    return {
      ok: false,
      error: `未配置 LLM API Key / apiKey missing（请在「设置」里添加一个 LLM 档位并填入 Key）`,
    };
  }
  if (!p.baseUrl) return { ok: false, error: '未配置接口地址 / baseUrl missing' };

  const digests = results.map((r) => ({ ...r, digest: digestResult(r) }));
  const keywords = cfg?.watch?.rules?.keywords ?? [];
  const req = chatRequest(p, [
    { role: 'system', content: mode === 'merch' ? MERCH_SYSTEM_PROMPT : SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt({ digests, watchResults, mode, keywords }) },
  ]);

  log?.info(`LLM → ${req.url} (provider=${p.name ?? p.id}, model=${req.body.model})`);
  try {
    const res = await netFetch(
      req.url,
      { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(900000) },
      { cfg }
    );
    const text = await res.text();
    if (!res.ok) {
      // Diagnosable errors seen in practice: insufficient balance / invalid key / rate limited
      let hint = '';
      try {
        const j = JSON.parse(text);
        hint = j?.error?.message ?? j?.message ?? '';
      } catch {}
      const msg = `LLM HTTP ${res.status}${hint ? ` — ${hint}` : ''}`;
      log?.error(msg);
      return { ok: false, error: msg, provider: { id: p.id, name: p.name, model: req.body.model } };
    }
    const j = JSON.parse(text);
    const markdown = j?.choices?.[0]?.message?.content ?? '';
    if (!markdown) return { ok: false, error: 'LLM 返回空内容 / empty completion' };
    log?.info(`LLM ok ${markdown.length} chars`);
    return {
      ok: true,
      markdown,
      provider: { id: p.id, name: p.name, model: req.body.model },
      usage: j?.usage ?? null,
    };
  } catch (err) {
    log?.error(`LLM failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Lightweight connectivity/balance probe before a run, so a long run does not wait for nothing / preflight check */
export async function preflight(cfg, provider) {
  const p = provider ?? activeProvider(cfg);
  if (!p.apiKey) return { ok: false, error: '未配置 API Key', provider: { id: p.id, name: p.name } };
  if (!p.baseUrl) return { ok: false, error: '未配置接口地址', provider: { id: p.id, name: p.name } };

  const req = chatRequest(p, [{ role: 'user', content: 'ping' }], { max_tokens: 4 });
  try {
    const res = await netFetch(
      req.url,
      { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30000) },
      { cfg }
    );
    if (res.ok) return { ok: true, provider: { id: p.id, name: p.name, model: req.body.model } };
    const t = await res.text();
    let hint = '';
    try {
      hint = JSON.parse(t)?.error?.message ?? '';
    } catch {}
    return { ok: false, error: `HTTP ${res.status}${hint ? ` — ${hint}` : ''}`, provider: { id: p.id, name: p.name, model: req.body.model } };
  } catch (err) {
    return { ok: false, error: err.message, provider: { id: p.id, name: p.name } };
  }
}
