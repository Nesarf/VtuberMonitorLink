// analyze.js — 分析层：把抓取摘要交给 LLM，产出结构化情报报告
// 直连 OpenAI 兼容的 /chat/completions，不依赖任何特定厂商 SDK。
import { digestResult } from './digest.js';

const SYSTEM_PROMPT = `你是 VTuber 情报监测助手。你会收到两类输入：
(A) 本工具已抓取的「来源摘要」（Reddit / Fandom / Twitch / 百科 / 官方公告等）；
(B) 你需要自行覆盖的检索方向。
请产出一份结构化中文 Markdown 报告，要求：
1. 开头写「生成日期」与「数据来源清单」（逐条列出本次实际用到的来源）；
2. 严格区分【已确认事实】与【传闻/未证实】，传闻一律单列，不得与事实混写；
3. 每条结论尽量附来源 URL；
4. 重点关注：批量毕业、解约/终止契约、事务所重组或倒闭、重大丑闻、平台政策变动、破纪录事件；
5. 若某来源本次未取到，如实声明，不要编造。
只输出 Markdown 报告本身，不要输出任何额外说明。`;

const MERCH_SYSTEM_PROMPT = `你是 VTuber 情报监测助手，本次专门监测「资源 / 抖内 / 通贩」平台动态。
重点平台：Pixiv FANBOX、Ci-en、BOOTH、DLsite。
关注：资源页开新或关闭、限时通贩、新作发布、付费内容争议、抖内相关事件。
产出结构化中文 Markdown，开头写生成日期；严格区分【已确认】与【传闻】；每条附来源 URL。`;

function buildUserPrompt({ sources, digests, mode }) {
  const parts = [];
  parts.push(`# 本次抓取来源摘要（共 ${digests.length} 条）\n`);
  for (const d of digests) {
    parts.push(`## ${d.source.id} — ${d.source.name?.zh ?? d.source.id}`);
    parts.push(`URL: ${d.source.url ?? '(检索类)'}`);
    parts.push(`登录要求: ${d.source.login}`);
    parts.push('');
    parts.push(d.ok ? d.digest : `⚠️ 本次未取到：${d.error ?? 'unknown'}`);
    parts.push('');
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
- ANN / KAI-YOU / 4Gamers / KAORI Nusantara 等新闻站`
  );
  return parts.join('\n');
}

/**
 * @param {{cfg:object, results:Array, mode:string, log:object}} args
 * @returns {Promise<{ok:boolean, markdown?:string, error?:string}>}
 */
export async function analyze({ cfg, results, mode = 'daily', log }) {
  const { baseUrl, apiKey, model, maxTokens, temperature, reasoningEffort } = cfg.llm ?? {};
  if (!apiKey) return { ok: false, error: '未配置 LLM API Key / apiKey missing（请在设置里填写）' };

  const digests = results.map((r) => ({ ...r, digest: digestResult(r) }));
  const endpoint = `${String(baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: model || 'deepseek-chat',
    messages: [
      { role: 'system', content: mode === 'merch' ? MERCH_SYSTEM_PROMPT : SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ sources: results.map((r) => r.source), digests, mode }) },
    ],
    max_tokens: maxTokens ?? 8192,
    temperature: temperature ?? 0.3,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  log?.info(`LLM → ${endpoint} (model=${body.model})`);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(900000),
    });
    const text = await res.text();
    if (!res.ok) {
      // 常见可诊断错误：余额不足 / key 无效 / 限流
      let hint = '';
      try {
        const j = JSON.parse(text);
        hint = j?.error?.message ?? j?.message ?? '';
      } catch {}
      const msg = `LLM HTTP ${res.status}${hint ? ` — ${hint}` : ''}`;
      log?.error(msg);
      return { ok: false, error: msg };
    }
    const j = JSON.parse(text);
    const markdown = j?.choices?.[0]?.message?.content ?? '';
    if (!markdown) return { ok: false, error: 'LLM 返回空内容 / empty completion' };
    log?.info(`LLM ok ${markdown.length} chars`);
    return { ok: true, markdown };
  } catch (err) {
    log?.error(`LLM failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** 跑之前的轻量连通性/余额探测，避免白等一场 / preflight check */
export async function preflight(cfg) {
  const { baseUrl, apiKey, model } = cfg.llm ?? {};
  if (!apiKey) return { ok: false, error: '未配置 API Key' };
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return { ok: true };
    const t = await res.text();
    let hint = '';
    try {
      hint = JSON.parse(t)?.error?.message ?? '';
    } catch {}
    return { ok: false, error: `HTTP ${res.status}${hint ? ` — ${hint}` : ''}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
