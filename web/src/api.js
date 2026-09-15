// api.js — thin wrapper over the local REST API
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

  // per-site automatic exit selection
  getEgress: () => j('/api/egress'),
  decideEgress: (ids) => post('/api/egress/decide', { ids }),
  clearEgress: () => post('/api/egress/clear', {}),

  // following by "person"
  getPeople: (limit) => j(`/api/people?limit=${limit ?? 300}`),
  addPerson: (person) => post('/api/people', person),
  patchPerson: (id, patch) =>
    j(`/api/people/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deletePerson: (id) => j(`/api/people/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  peopleFeed: (id, per) => j(`/api/people/feed?id=${encodeURIComponent(id)}&per=${per ?? 50}`),
  suggestPeople: (min) => j(`/api/people/suggest?min=${min ?? 2}`),
  personExportUrl: (id, format) => `/api/people/${encodeURIComponent(id)}/export?format=${format ?? 'json'}`,

  // anniversary / birthday / 3D debut countdown
  getCalendar: ({ days, month, year, weekStart } = {}) =>
    j(`/api/calendar?days=${days ?? 400}&month=${month ?? ''}&year=${year ?? ''}&weekStart=${weekStart ?? 1}`),
  addCalendarEntry: (entry) => post('/api/calendar/entry', entry),
  patchCalendarEntry: (id, patch) =>
    j(`/api/calendar/entry/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  deleteCalendarEntry: (id) => j(`/api/calendar/entry/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  detectCalendar: (limit) => j(`/api/calendar/detect?limit=${limit ?? 300}`),
  importCalendar: (entries) => post('/api/calendar/import', { entries }),

  // sources
  getSources: () => j('/api/sources'),
  patchSource: (id, patch) =>
    j(`/api/sources/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  addCustomSource: (source) => post('/api/sources/custom', source),
  deleteCustomSource: (id) => j(`/api/sources/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // environment
  getBrowsers: () => j('/api/browsers'),
  detectProxy: () => j('/api/proxy/detect'),
  checkCookies: (payload) => post('/api/cookies/check', payload),

  // run
  getState: () => j('/api/state'),
  run: (mode = 'daily') => post('/api/run', { mode }),
  preflight: () => post('/api/preflight'),

  // LLM profiles
  getLlm: () => j('/api/llm/presets'),
  newLlmProvider: (preset, overrides) => post('/api/llm/new', { preset, overrides }),
  testLlmProvider: (provider) => post('/api/llm/test', { provider }),
  listLlmModels: (provider) => post('/api/llm/models', { provider }),

  // watch targets
  getWatch: () => j('/api/watch'),
  putWatch: (payload) => put('/api/watch', payload),
  checkWatch: (id) => post('/api/watch/check', id ? { id } : {}),
  watchHistory: (id, limit = 50) => j(`/api/watch/${encodeURIComponent(id)}/history?limit=${limit}`),
  clearBaseline: (id) => j(`/api/watch/${encodeURIComponent(id)}/baseline`, { method: 'DELETE' }),

  // intel items
  getIntel: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false)
    ).toString();
    return j(`/api/intel${qs ? `?${qs}` : ''}`);
  },

  // reports
  getReports: () => j('/api/reports'),

  // one-click sharing
  shareTargets: () => j('/api/share/targets'),
  shareText: ({ scope, note } = {}) => post('/api/share/bundle', { scope, format: 'text', note }),
  sharePost: (body) => post('/api/share/post', body),
  shareAudit: () => j('/api/share/audit'),

  // image understanding tagging
  visionStats: () => j('/api/vision/stats'),
  tagImages: (body) => post('/api/vision/tag', body ?? {}),

  // SQLite archive and charts
  archiveStats: () => j('/api/archive/stats'),
  archiveSeries: (range) => j(`/api/archive/series?range=${encodeURIComponent(range ?? '30d')}`),
  groups: (days) => j(`/api/groups?days=${days ?? 30}`),
  silence: (days) => j(`/api/silence?days=${days ?? 60}`),
  cost: (days) => j(`/api/cost?days=${days ?? 14}`),
  // VDB roster (multi-platform: agency + the accounts on each platform)
  vdbStatus: () => j('/api/vdb/status'),
  vdbSync: () => post('/api/vdb/sync', {}),
  vdbSearch: (q, group) => j(`/api/vdb/search?q=${encodeURIComponent(q)}${group ? `&group=${encodeURIComponent(group)}` : ''}`),
  vdbGroups: () => j('/api/vdb/groups'),
  vdbImport: (keys) => post('/api/vdb/import', { keys }),
  // README viewer (the About panel renders these; `lang=zh` → README.zh-CN.md)
  readme: (lang) => j(`/api/readme?lang=${encodeURIComponent(lang ?? 'en')}`),
  archiveItems: (q = {}) =>
    j(`/api/archive/items?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`),
  archiveIngest: (limit) => post('/api/archive/ingest', { limit }),
  getEvents: ({ limit, per } = {}) => j(`/api/events?limit=${limit ?? 500}&per=${per ?? 60}`),
  dedupeEvents: (limit) => j(`/api/events/dedupe?limit=${limit ?? 500}`),
  flushNotify: () => post('/api/notify/flush', { force: true }),
  getReport: (name) => fetch(`/api/reports/${encodeURIComponent(name)}`).then((r) => r.text()),
  searchReports: (q) => j(`/api/reports/search?q=${encodeURIComponent(q)}`),
  diffReports: (from, to) => j(`/api/reports/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  exportUrl: (name, format = 'html') =>
    `/api/reports/${encodeURIComponent(name)}/export?format=${format}`,

  // connectivity probes
  getProbe: () => j('/api/probe'),
  probe: (payload) => post('/api/probe', payload),
  getHealth: () => j('/api/health'),

  // site thumbnails
  thumbMeta: (url, sourceId, mode) =>
    j(`/api/thumb?url=${encodeURIComponent(url)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}${mode ? `&mode=${mode}` : ''}`),

  // self-checks and diagnostic files
  diagnose: (id) => post(`/api/sources/${encodeURIComponent(id)}/diagnose`, {}),
  listAdvice: () => j('/api/advice'),
  deleteAdvice: (file) => j(`/api/advice/${encodeURIComponent(file)}`, { method: 'DELETE' }),

  // scheduled tasks
  getSchedule: () => j('/api/schedule'),
  runSchedule: (id) => post('/api/schedule/run', { id }),

  // notification targets
  getNotify: () => j('/api/notify'),
  newNotify: (kind, overrides) => post('/api/notify/new', { kind, overrides }),
  testNotify: (target) => post('/api/notify/test', { target }),

  // proxy core
  proxyControl: () => j('/api/proxy/control'),
  proxyNodes: (control) => j(`/api/proxy/nodes${control ? `?control=${encodeURIComponent(control)}` : ''}`),
  proxyNodeTest: (payload) => post('/api/proxy/nodes/test', payload),
  proxyNodeSelect: (payload) => post('/api/proxy/node', payload),

  // config import / export
  exportConfigUrl: (secrets) => `/api/config/export${secrets ? '?secrets=1' : ''}`,
  importConfig: (config) => post('/api/config/import', { config }),

  // intel
  getIntelDiff: () => j('/api/intel/diff'),
  flagIntel: (id, patch) =>
    j(`/api/intel/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  // search (purely local matching, no LLM needed)
  search: (query) => post('/api/search', query),
  searchTags: () => j('/api/search/tags'),
  saveSearchTags: (tags) => put('/api/search/tags', { tags }),
  // optional assistant: only pulled in when the name has been forgotten
  assist: (description) => post('/api/search/assist', { description }),

  // export (readable and writable by Office)
  intelExportUrl: (format, limit = 500) => `/api/intel/export?format=${format}&limit=${limit}`,

  // feature extraction (needs an LLM)
  getFeatures: () => j('/api/features'),
  extractFeatures: () => post('/api/features/extract', {}),

  // live-stream monitoring (feature origin: dd-center/bilibili-dd-monitor, MIT)
  getLive: (fresh) => j('/api/live' + (fresh ? '?fresh=1' : '')),
  searchRoster: (q) => j('/api/live/roster?q=' + encodeURIComponent(q)),

  // login accounts and danmaku sending (sending is a write, so it must be confirmed explicitly)
  getAccounts: () => j('/api/accounts'),
  sendDanmaku: (payload) => post('/api/danmaku', payload),
  getDanmakuAudit: () => j('/api/danmaku/audit'),

  // person profiles (aggregated by feature extraction)
  getEntities: () => j('/api/entities'),
  getEntity: (name) => j('/api/entities/' + encodeURIComponent(name)),

  // bulk source toggles
  bulkSources: (payload) => post('/api/sources/bulk', payload),

  // Tor anonymizing exit
  probeTor: (socks) => post('/api/proxy/tor', { socks }),
  startTor: (exe) => post('/api/proxy/tor/start', { exe }),
};
