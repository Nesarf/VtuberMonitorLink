// llm.js — LLM 提供商档位 / LLM provider profiles
//
// 设计目标：网页里能「选提供商 → 填 Key → 选模型 → 测连通性」，也可以存多套档位
// 随时切换（例如平时用便宜的、出报告时用贵的）。
// 只依赖 OpenAI 兼容的 /chat/completions 与 /models，不引入任何厂商 SDK。
import { netFetch } from './net.js';

/** 常见提供商预设（baseUrl 均可改，模型列表也会在网页里实时拉取） */
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

/** 新建一个档位 / build a new provider profile from a preset */
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
 * 取当前生效的档位。
 * 同时兼容 v1.0.0 的扁平写法（cfg.llm.apiKey / baseUrl / model …），
 * 老配置读到就自动升级成「单档位」，不需要使用者手动改文件。
 */
export function activeProvider(cfg) {
  const llm = cfg?.llm ?? {};
  const list = Array.isArray(llm.providers) ? llm.providers : [];
  if (list.length) {
    const id = llm.activeId ?? list[0].id;
    return list.find((p) => p.id === id) ?? list[0];
  }
  // 旧格式 → 即时降级成一个临时档位
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

/** 拉取提供商暴露的模型清单 / list models from an OpenAI-compatible endpoint */
export async function listModels(cfg, provider) {
  const p = provider ?? activeProvider(cfg);
  if (!p.baseUrl) return { ok: false, error: '未填写接口地址 / baseUrl is empty', models: [] };
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

/** 单次对话请求的公共部分 / shared request bits */
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
