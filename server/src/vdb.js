// vdb.js — VDB（Vtuber Database）提供者：花名册 + 社团维度，**多平台**
//
// 数据来源：github.com/dd-center/vdb（vtbs.moe 的上游数据库）。
// 它每条记录长这样（一文件一人）：
//   { "name": { "cn": "嘉然", "en": "Diana" },
//     "accounts": { "bilibili": "672328094", "weibo": "7595006312" },
//     "group": "A-SOUL" }
// 也就是我们缺的那一维：**社团（箱）**，加上多语言名字与各平台账号。
//
// 为什么是「一条请求拿全库」而不是逐个调 API：
//   整库 tarball 只有 ~0.54MB（10035 条），一次 codeload 请求、一两秒。
//   逐个调 GitHub API 要几千次请求、吃配额、还可能被限流 —— 对使用者也更吵。
//
// 许可（重要）：VDB 的数据是 **CC BY-NC-SA 4.0**（代码 GPL）。所以：
//   · 只**运行时**获取，缓存在运行期目录 —— **绝不进仓库、绝不进发行包**
//     （我们是 MIT，把 NC/SA 的数据塞进发行包既冲突又麻烦）
//   · 界面上、文档里都要**署名**数据来源
//   · 非商业：个人工具没问题
//
// 平台无关：这里不假设 bilibili。`accounts` 里有什么平台就收什么平台
// （bilibili/youtube/twitter/twitch/acfun/weibo/tiktok/niconico/showroom/pixiv/…），
// 匹配与展示都按「平台 → id」的通用形状走。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTar } from './tar.js';
import { resolveDir } from './config.js';

export const VDB_DEFAULTS = {
  url: 'https://codeload.github.com/dd-center/vdb/tar.gz/refs/heads/master',
  ttlDays: 7, // 花名册变化很慢，一周一次足够；要立刻刷新可以 force
  timeoutMs: 60000,
  software: 'vtuber-monitor-link',
};

/** 各平台账号对应的「规范化链接形状」——用于把 id 变成可匹配的别名，以及给界面展示 */
export const PLATFORM_URLS = {
  bilibili: 'https://space.bilibili.com/{id}',
  youtube: 'https://www.youtube.com/channel/{id}',
  youtubeAt: 'https://www.youtube.com/@{id}',
  twitter: 'https://twitter.com/{id}',
  twitch: 'https://www.twitch.tv/{id}',
  tiktok: 'https://www.tiktok.com/@{id}',
  weibo: 'https://weibo.com/u/{id}',
  weiboByName: 'https://weibo.com/n/{id}',
  acfun: 'https://www.acfun.cn/u/{id}',
  niconico: 'https://www.nicovideo.jp/user/{id}',
  showroom: 'https://www.showroom-live.com/{id}',
  pixiv: 'https://www.pixiv.net/member.php?id={id}',
  afdian: 'https://afdian.net/@{id}',
  'ci-en': 'https://ci-en.net/creator/{id}',
  booth: 'https://{id}.booth.pm',
  fantia: 'https://fantia.jp/fanclubs/{id}',
  marshmallow: 'https://marshmallow-qa.com/{id}',
  userlocal: 'https://virtual-youtuber.userlocal.jp/user/{id}',
  instagram: 'https://www.instagram.com/{id}/',
  telegram: 'https://t.me/{id}',
  patreon: 'https://www.patreon.com/{id}',
  peing: 'https://peing.net/zh-CN/{id}',
  '163music': 'https://music.163.com/#/user/home?id={id}',
  line: 'https://line.me/R/ti/p/{id}',
  github: 'https://github.com/{id}',
  web: '{id}',
  other: '{id}',
};

function cacheDir(cfg) {
  // 运行期目录：跟 reports/feeds 同级，不进仓库也不进发行包
  return path.join(resolveDir(cfg, 'feedsDir'), '..', 'vdb');
}

function indexPath(cfg) {
  return path.join(cacheDir(cfg), 'index.json');
}

/** 把一条 VDB 记录归一化 / normalise one record */
export function parseRecord(raw, file = '') {
  if (!raw || typeof raw !== 'object') return null;
  const names = [];
  const n = raw.name ?? {};
  const push = (v) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    if (!names.includes(s)) names.push(s);
  };
  // default 指向哪个语言就用哪个当主名；否则按 cn → jp → en 的顺序
  const pref = typeof n.default === 'string' ? n[n.default] : null;
  push(pref);
  for (const k of ['cn', 'jp', 'en', 'kr', 'tw']) push(n[k]);
  for (const x of Array.isArray(n.extra) ? n.extra : []) push(x);
  if (!names.length && file) push(file.replace(/\.json$/, ''));

  const accounts = {};
  if (raw.accounts && typeof raw.accounts === 'object') {
    for (const [platform, id] of Object.entries(raw.accounts)) {
      if (id === null || id === undefined || id === '') continue;
      accounts[platform] = String(id);
    }
  }
  const group = typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : null;
  const type = typeof raw.type === 'string' ? raw.type : 'vtuber';
  return { key: file.replace(/\.json$/, ''), names, accounts, group, type };
}

/**
 * 从 tarball 内容建索引。纯函数（不碰磁盘），好断言。
 * @param {Buffer} tarGz
 * @param {{prefix?:string}} opts
 */
export function buildIndex(tarGz, { prefix = null, generatedAt = new Date().toISOString() } = {}) {
  const files = readTar(zlib.gunzipSync(tarGz));
  const records = [];
  let skipped = 0;
  for (const [full, data] of files) {
    if (!/\/vtbs\/.*\.json$/.test(full) && !/^vtbs\/.*\.json$/.test(full)) continue;
    if (prefix && !full.startsWith(prefix)) continue;
    const file = full.slice(full.lastIndexOf('/') + 1);
    try {
      const rec = parseRecord(JSON.parse(data.toString('utf8')), file);
      if (rec) records.push(rec);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  const groups = new Map();
  for (const r of records) if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
  const platforms = new Map();
  for (const r of records) for (const p of Object.keys(r.accounts)) platforms.set(p, (platforms.get(p) ?? 0) + 1);
  return {
    source: 'dd-center/vdb',
    license: 'CC BY-NC-SA 4.0',
    generatedAt,
    count: records.length,
    skipped,
    groups: Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1])),
    platforms: Object.fromEntries([...platforms.entries()].sort((a, b) => b[1] - a[1])),
    records,
  };
}

/** 下载 + 建索引 + 落缓存（TTL 内不重复下载；force 时强制刷新） */
export async function ensureIndex(cfg, { force = false, log = null } = {}) {
  const opts = { ...VDB_DEFAULTS, ...(cfg?.vdb ?? {}) };
  const p = indexPath(cfg);
  const ttlMs = Math.max(0, Number(opts.ttlDays) || 0) * 86400000;
  if (!force) {
    try {
      const st = fs.statSync(p);
      const index = JSON.parse(fs.readFileSync(p, 'utf8'));
      const age = Date.now() - st.mtimeMs;
      if (age < ttlMs && index?.count) return { ...index, cached: true, ageHours: Math.round(age / 3600000) };
    } catch {
      /* 没缓存就下 */
    }
  }
  const url = String(opts.url ?? VDB_DEFAULTS.url);
  log?.info?.(`拉取 VDB 花名册（一条请求，~0.5MB）：${url}`);
  const res = await fetch(url, {
    headers: { 'user-agent': opts.software ?? VDB_DEFAULTS.software, accept: 'application/gzip,*/*' },
    signal: AbortSignal.timeout(Number(opts.timeoutMs) || VDB_DEFAULTS.timeoutMs),
  });
  if (!res.ok) throw new Error(`VDB 下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const index = buildIndex(buf, { generatedAt: new Date().toISOString() });
  if (!index.count) throw new Error('VDB 包里没有解析出任何条目（上游结构可能变了）');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(index), 'utf8');
  } catch (e) {
    log?.warn?.(`VDB 索引写缓存失败（不影响本次使用）: ${e.message}`);
  }
  return { ...index, cached: false, ageHours: 0 };
}

export function loadCachedIndex(cfg) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(cfg), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 搜索：名字（任意语言、含 extra 别名）与**任意平台**的账号 id/链接都能命中。
 * 这样「我只记得他在 twitch 上的名字」也能搜到。
 */
export function searchIndex(index, query, { limit = 20, group = null } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!index?.records?.length) return [];
  const out = [];
  for (const r of index.records) {
    if (group && r.group !== group) continue;
    let score = 0;
    for (const nm of r.names) {
      const low = nm.toLowerCase();
      if (low === q) score = Math.max(score, 100);
      else if (low.startsWith(q)) score = Math.max(score, 80);
      else if (low.includes(q)) score = Math.max(score, 60);
    }
    for (const [platform, id] of Object.entries(r.accounts)) {
      const low = String(id).toLowerCase();
      if (low === q) score = Math.max(score, 90);
      else if (low.includes(q)) score = Math.max(score, 50);
      const tpl = PLATFORM_URLS[platform];
      if (tpl && tpl.replace('{id}', id).toLowerCase().includes(q)) score = Math.max(score, 55);
    }
    if (score > 0) out.push({ ...r, score });
  }
  out.sort((a, b) => b.score - a.score || a.names[0].localeCompare(b.names[0]));
  return out.slice(0, Math.max(1, Number(limit) || 20));
}

/** 某个社团的成员 */
export function membersOfGroup(index, group) {
  return (index?.records ?? []).filter((r) => r.group === group);
}

/**
 * VDB 记录 → 我们的「关注对象」形状。
 * **平台无关**：accounts 里有什么就写进 links 什么（不假设 bilibili）。
 */
export function toPerson(record, { id = null } = {}) {
  const names = record?.names ?? [];
  const name = names[0] ?? record?.key ?? 'unknown';
  const aliases = names.slice(1);
  const links = { ...(record?.accounts ?? {}) };
  return {
    id: id ?? slug(record?.key ?? name),
    name,
    agency: record?.group ?? '',
    aliases,
    links,
    tags: [],
    notes: '',
    _vdb: { key: record?.key ?? null, names },
  };
}

/** 生成一个稳定、可读的 id（VDB 的文件名就是天然主键） */
export function slug(s) {
  const base = String(s ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  return base || `vdb-${Date.now().toString(36)}`;
}

/** 索引摘要（界面与日志用） */
export function indexSummary(index) {
  if (!index?.count) return '尚未获取 VDB 花名册';
  return `${index.count} 位（社团 ${Object.keys(index.groups ?? {}).length} 个）· 更新于 ${String(index.generatedAt).slice(0, 10)}`;
}
