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

export const api = {
  getConfig: () => j('/api/config'),
  putConfig: (cfg) =>
    j('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }),
  getSources: () => j('/api/sources'),
  patchSource: (id, patch) =>
    j(`/api/sources/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  getBrowsers: () => j('/api/browsers'),
  detectProxy: () => j('/api/proxy/detect'),
  getState: () => j('/api/state'),
  run: (mode = 'daily') =>
    j('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }),
  preflight: () => j('/api/preflight', { method: 'POST' }),
  getReports: () => j('/api/reports'),
  getReport: (name) => fetch(`/api/reports/${encodeURIComponent(name)}`).then((r) => r.text()),
};
