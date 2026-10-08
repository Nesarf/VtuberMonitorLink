// llm.js — LLM provider profiles
//
// Design goal: the web UI can "pick a provider -> fill in the key -> pick a model -> test
// connectivity", and can also store several profiles to switch between at any time
// (for example a cheap one for everyday use and an expensive one when writing reports).
// Depends only on the OpenAI-compatible /chat/completions and /models, with no vendor SDK.
import { netFetch } from './net.js';
import { markUrlCleared, validateRemoteUrl } from './remote-url.js';

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
    // The one shipped preset that carries the loopback allowance, and the decision behind it: a local model
    // server is on loopback **by design**, and this address is ours rather than something a user typed, so there
    // is no user intent for the URL policy (server/src/remote-url.js) to second-guess. A preset that is refused
    // the first time it is used teaches people to turn the rule off wholesale, which is worse than the rule
    // being one entry less absolute. The flag stays per entry, so this admits the Ollama profile and nothing
    // else: a profile a user typed pointing at 127.0.0.1 is still refused, and this flag relaxes the loopback
    // rule only — a private, link-local or metadata address is refused even with it set. Both of those are
    // pinned by tools/remote-url-test.mjs, the second one as the control.
    allowLoopback: true,
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
    // The allowance is per entry and this object is built field by field, so a preset that sets it would be
    // silently stripped here — the same trap `local: true` already falls into (it is read by the page, never
    // copied onto a profile). Copied explicitly rather than by spreading the preset, because everything else a
    // preset carries is presentation (name, model list) and spreading would put the whole table on the profile.
    ...(p.allowLoopback === true ? { allowLoopback: true } : {}),
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


/**
 * The policy for one LLM profile: the profile carries its own allowance (the Ollama preset points at
 * 127.0.0.1 by design, and a profile the user typed is otherwise an address like any other).
 *
 * `cfg` is accepted because two routes build a **transient** profile out of the request body plus the saved
 * one (/api/llm/test and /api/llm/models) and a browser round-trip does not carry the flag back. The stored
 * profile is the one the user configured, so it is the authority; the passed object is consulted first so a
 * caller that has a profile in hand does not need the config at all.
 *
 * Found by a test rather than by reading: the vision suite built its provider from `cfg.llm.providers[0]` and
 * every case failed with a refusal — which turned out to be correct behaviour for a provider object that had
 * been separated from the config it came from, and is worth keeping as one function rather than two policies.
 */
export function providerPolicy(provider = {}, cfg = null) {
  if (provider?.allowLoopback === true) return { allowLoopback: true };
  const list = Array.isArray(cfg?.llm?.providers) ? cfg.llm.providers : [];
  const saved = list.find((x) => x?.id && x.id === provider?.id);
  return { allowLoopback: saved?.allowLoopback === true || cfg?.llm?.allowLoopback === true };
}

/**
 * The address of one chat/completions request, checked against the policy — or a refusal, in words.
 *
 * Why the check lives here rather than at each fetch site: the LLM endpoint is reached from five places
 * (analyze's run and its preflight, features' extraction, the vision tagger, the model list, and the
 * natural-language search route in server.js), all of them through chatRequest(). Putting the check in the
 * one function that builds the address is what makes "every one of them" true by construction rather than
 * by remembering, and it is why those callers carry no check of their own.
 *
 * @returns {Promise<{ok:true, url:string}|{ok:false, error:string, code:string}>}
 */
export async function checkChatEndpoint(p, cfg = null) {
  const url = endpoint(p?.baseUrl || 'https://api.deepseek.com', '/chat/completions');
  const policy = providerPolicy(p, cfg);
  const check = await validateRemoteUrl(url, policy);
  if (!check.ok) return { ok: false, error: check.message, code: check.code };
  return { ok: true, url: markUrlCleared(check.url, policy) };
}
function endpoint(baseUrl, suffix) {
  return `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}${suffix}`;
}

/** List models from an OpenAI-compatible endpoint */
export async function listModels(cfg, provider) {
  const p = provider ?? activeProvider(cfg);
  if (!p.baseUrl) return { ok: false, error: 'baseUrl is empty', models: [] };
  const policy = providerPolicy(p, cfg);
  const target = await validateRemoteUrl(endpoint(p.baseUrl, '/models'), policy);
  if (!target.ok) return { ok: false, error: target.message, code: target.code, models: [] };
  try {
    const r = await netFetch(
      markUrlCleared(target.url, policy),
      {
        headers: { authorization: `Bearer ${p.apiKey ?? ''}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      },
      { cfg, policy }
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

/**
 * The shared request bits of one chat request, with the address already checked.
 *
 * This is the function the five callers use; `chatRequest` stays as it was because it is pure assembly and
 * some callers (and the tests) want the description without deciding whether it may be sent. The refusal is
 * returned in the shape every caller already handles — `{ok:false, error}` — so a call site needs one line
 * to be safe rather than a new error path.
 *
 * @returns {Promise<{ok:true, url:string, headers:object, body:object}|{ok:false, error:string, code:string}>}
 */
export async function checkedChatRequest(p, messages, extra = {}, cfg = null) {
  const req = chatRequest(p, messages, extra);
  const policy = providerPolicy(p, cfg);
  const check = await validateRemoteUrl(req.url, policy);
  if (!check.ok) return { ok: false, error: check.message, code: check.code };
  return { ok: true, ...req, url: markUrlCleared(check.url, policy) };
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
