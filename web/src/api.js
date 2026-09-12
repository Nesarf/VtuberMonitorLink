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

  // 每个站点的自动出口判定
  getEgress: () => j('/api/egress'),
  decideEgress: (ids) => post('/api/egress/decide', { ids }),
  clearEgress: () => post('/api/egress/clear', {}),

  // 按「人」关注
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

  // 纪念日 / 生日 / 3D披露 倒计时
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
  checkCookies: (payload) => post('/api/cookies/check', payload),

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

  // 一键分享
  shareTargets: () => j('/api/share/targets'),
  shareText: ({ scope, note } = {}) => post('/api/share/bundle', { scope, format: 'text', note }),
  sharePost: (body) => post('/api/share/post', body),
  shareAudit: () => j('/api/share/audit'),

  // 图片理解打标
  visionStats: () => j('/api/vision/stats'),
  tagImages: (body) => post('/api/vision/tag', body ?? {}),

  // SQLite 归档与图表
  archiveStats: () => j('/api/archive/stats'),
  archiveSeries: (days) => j(`/api/archive/series?days=${days ?? 30}`),
  groups: (days) => j(`/api/groups?days=${days ?? 30}`),
  silence: (days) => j(`/api/silence?days=${days ?? 60}`),
  cost: (days) => j(`/api/cost?days=${days ?? 14}`),
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

  // 连通性探测
  getProbe: () => j('/api/probe'),
  probe: (payload) => post('/api/probe', payload),
  getHealth: () => j('/api/health'),

  // 站点缩略图
  thumbMeta: (url, sourceId, mode) =>
    j(`/api/thumb?url=${encodeURIComponent(url)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}${mode ? `&mode=${mode}` : ''}`),

  // 自检与诊断文件
  diagnose: (id) => post(`/api/sources/${encodeURIComponent(id)}/diagnose`, {}),
  listAdvice: () => j('/api/advice'),
  deleteAdvice: (file) => j(`/api/advice/${encodeURIComponent(file)}`, { method: 'DELETE' }),

  // 计划任务
  getSchedule: () => j('/api/schedule'),
  runSchedule: (id) => post('/api/schedule/run', { id }),

  // 通知推送
  getNotify: () => j('/api/notify'),
  newNotify: (kind, overrides) => post('/api/notify/new', { kind, overrides }),
  testNotify: (target) => post('/api/notify/test', { target }),

  // 代理内核
  proxyControl: () => j('/api/proxy/control'),
  proxyNodes: (control) => j(`/api/proxy/nodes${control ? `?control=${encodeURIComponent(control)}` : ''}`),
  proxyNodeTest: (payload) => post('/api/proxy/nodes/test', payload),
  proxyNodeSelect: (payload) => post('/api/proxy/node', payload),

  // 配置导入导出
  exportConfigUrl: (secrets) => `/api/config/export${secrets ? '?secrets=1' : ''}`,
  importConfig: (config) => post('/api/config/import', { config }),

  // 情报
  getIntelDiff: () => j('/api/intel/diff'),
  flagIntel: (id, patch) =>
    j(`/api/intel/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  // 检索（纯本地匹配，不需要 LLM）
  search: (query) => post('/api/search', query),
  searchTags: () => j('/api/search/tags'),
  saveSearchTags: (tags) => put('/api/search/tags', { tags }),
  // 可选助手：只在「忘了名字」时用
  assist: (description) => post('/api/search/assist', { description }),

  // 导出（Office 可读写）
  intelExportUrl: (format, limit = 500) => `/api/intel/export?format=${format}&limit=${limit}`,

  // 特征抽取（需要 LLM）
  getFeatures: () => j('/api/features'),
  extractFeatures: () => post('/api/features/extract', {}),

  // 开播监测（功能来源：dd-center/bilibili-dd-monitor，MIT）
  getLive: (fresh) => j('/api/live' + (fresh ? '?fresh=1' : '')),
  searchRoster: (q) => j('/api/live/roster?q=' + encodeURIComponent(q)),

  // 登录账号与发弹幕（发送是写操作，必须显式确认）
  getAccounts: () => j('/api/accounts'),
  sendDanmaku: (payload) => post('/api/danmaku', payload),
  getDanmakuAudit: () => j('/api/danmaku/audit'),

  // 人物档案（由特征抽取聚合）
  getEntities: () => j('/api/entities'),
  getEntity: (name) => j('/api/entities/' + encodeURIComponent(name)),

  // 来源批量开关
  bulkSources: (payload) => post('/api/sources/bulk', payload),

  // Tor 无痕出口
  probeTor: (socks) => post('/api/proxy/tor', { socks }),
  startTor: (exe) => post('/api/proxy/tor/start', { exe }),
};
