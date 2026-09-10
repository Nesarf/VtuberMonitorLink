// api.js — 后端接口封装 / thin wrapper over the local REST API
async function j(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const post = (url, body) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const put = (url, body) =>
  j(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  getConfig: () => j('/api/config'),
  putConfig: (cfg) => put('/api/config', cfg),

  // 来源
  getSources: () => j('/api/sources'),
  patchSource: (id, patch) =>
    j(`/api/sources/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  addCustomSource: (source) => post('/api/sources/custom', source),
  deleteCustomSource: (id) => j(`/api/sources/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // 环境
  getBrowsers: () => j('/api/browsers'),
  detectProxy: () => j('/api/proxy/detect'),

  // 运行
  getState: () => j('/api/state'),
  run: (mode = 'daily') => post('/api/run', { mode }),
  preflight: () => post('/api/preflight'),

  // LLM 档位
  getLlm: () => j('/api/llm/presets'),
  newLlmProvider: (preset, overrides) => post('/api/llm/new', { preset, overrides }),
  testLlmProvider: (provider) => post('/api/llm/test', { provider }),
  listLlmModels: (provider) => post('/api/llm/models', { provider }),

  // 监视对象
  getWatch: () => j('/api/watch'),
  putWatch: (payload) => put('/api/watch', payload),
  checkWatch: (id) => post('/api/watch/check', id ? { id } : {}),
  watchHistory: (id, limit = 50) => j(`/api/watch/${encodeURIComponent(id)}/history?limit=${limit}`),
  clearBaseline: (id) => j(`/api/watch/${encodeURIComponent(id)}/baseline`, { method: 'DELETE' }),

  // 情报条目
  getIntel: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false)
    ).toString();
    return j(`/api/intel${qs ? `?${qs}` : ''}`);
  },

  // 报告
  getReports: () => j('/api/reports'),
  getReport: (name) => fetch(`/api/reports/${encodeURIComponent(name)}`).then((r) => r.text()),
  searchReports: (q) => j(`/api/reports/search?q=${encodeURIComponent(q)}`),
  exportUrl: (name, format = 'html') =>
    `/api/reports/${encodeURIComponent(name)}/export?format=${format}`,
};
