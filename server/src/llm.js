// llm.js — LLM provider profiles
//
// Design goal: the web UI can "pick a provider -> fill in the key -> pick a model -> test
// connectivity", and can also store several profiles to switch between at any time
// (for example a cheap one for everyday use and an expensive one when writing reports).
// Depends only on the OpenAI-compatible /chat/completions and /models, with no vendor SDK.
import { netFetch } from './net.js';

/** Common provider presets (every baseUrl can be edited, and the model list is fetched live in the UI) */
export const PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  {
    id: 'dashscope',
    name: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-3.7-sonnet', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'],
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'],
    local: true,
  },
  {
    id: 'custom',
    name: '自定义 / 其它 OpenAI 兼容接口',
    baseUrl: '',
    models: [],
  },
];

export function presetOf(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** Build a new provider profile from a preset */
export function newProvider(presetId = 'deepseek', overrides = {}) {
  const p = presetOf(presetId) ?? presetOf('custom');
  const base = {
    id: `${presetId}-${Date.now().toString(36)}`,
    preset: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.models[0] ?? '',
    models: [...p.models],
    reasoningEffort: '',
    maxTokens: 8192,
    temperature: 0.3,
  };
  return { ...base, ...overrides };
}

/**
 * Get the currently active profile.
 * Also accepts the flat v1.0.0 layout (cfg.llm.apiKey / baseUrl / model ...):
 * an old config is upgraded to a "single profile" on read, so the user never has to
 * edit the file by hand.
 */
export function activeProvider(cfg) {
  const llm = cfg?.llm ?? {};
  const list = Array.isArray(llm.providers) ? llm.providers : [];
  if (list.length) {
    const id = llm.activeId ?? list[0].id;
    return list.find((p) => p.id === id) ?? list[0];
  }
  // old format -> degrade it into a temporary profile on the fly
  if (llm.apiKey || llm.baseUrl) {
    return {
      id: '__legacy__',
      preset: 'custom',
      name: '默认',
      baseUrl: llm.baseUrl ?? '',
      apiKey: llm.apiKey ?? '',
      model: llm.model ?? '',
      models: llm.model ? [llm.model] : [],
      reasoningEffort: llm.reasoningEffort ?? '',
      maxTokens: llm.maxTokens ?? 8192,
      temperature: llm.temperature ?? 0.3,
    };
  }
  return newProvider('deepseek', { id: '__default__', name: 'DeepSeek' });
}

function endpoint(baseUrl, suffix) {
  return `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}${suffix}`;
}

/** List models from an OpenAI-compatible endpoint */
export async function listModels(cfg, provider) {
  const p = provider ?? activeProvider(cfg);
  if (!p.baseUrl) return { ok: false, error: 'baseUrl is empty', models: [] };
  try {
    const r = await netFetch(
      endpoint(p.baseUrl, '/models'),
      {
        headers: { authorization: `Bearer ${p.apiKey ?? ''}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      },
      { cfg }
    );
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}${text ? ` — ${text.slice(0, 160)}` : ''}`, models: [] };
    const j = JSON.parse(text);
    const models = (j?.data ?? j?.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name))
      .filter(Boolean)
      .sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message, models: [] };
  }
}

/** Shared request bits for a single chat request */
export function chatRequest(p, messages, extra = {}) {
  const body = {
    model: p.model || 'deepseek-chat',
    messages,
    max_tokens: p.maxTokens ?? 8192,
    temperature: p.temperature ?? 0.3,
    ...extra,
  };
  if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
  return {
    url: endpoint(p.baseUrl || 'https://api.deepseek.com', '/chat/completions'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey ?? ''}` },
    body,
  };
}
