// vdb.js — VDB (Vtuber Database) provider: roster + agency dimension, **multi-platform**
//
// Data source: github.com/dd-center/vdb (the upstream database behind vtbs.moe).
// Each record looks like this (one file per person):
//   { "name": { "cn": "<name in Chinese>", "en": "Diana" },
//     "accounts": { "bilibili": "672328094", "weibo": "7595006312" },
//     "group": "A-SOUL" }
// i.e. exactly the dimension we were missing: **agency (group)**, plus multilingual names and
// per-platform accounts.
//
// Why "one request for the whole database" instead of calling the API per record:
//   the whole database tarball is only ~0.54MB (10035 records): one codeload request, a second or two.
//   Calling the GitHub API record by record would take thousands of requests, eat quota, and might
//   get rate-limited — and it is noisier for the user too.
//
// Licence (important): VDB's data is **CC BY-NC-SA 4.0** (the code is GPL). Therefore:
//   · fetch it **at runtime** only, cache it in the runtime dir — **never into the repo, never into a release package**
//     (we are MIT, and stuffing NC/SA data into a release package is both conflicting and a hassle)
//   · the UI and the docs must **attribute** the data source
//   · non-commercial: fine for a personal tool
//
// Platform-agnostic: nothing here assumes bilibili. Whatever platforms `accounts` carries are accepted
// (bilibili/youtube/twitter/twitch/acfun/weibo/tiktok/niconico/showroom/pixiv/…),
// and both matching and display follow the generic "platform → id" shape.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTar } from './tar.js';
import { resolveDir } from './config.js';

export const VDB_DEFAULTS = {
  url: 'https://codeload.github.com/dd-center/vdb/tar.gz/refs/heads/master',
  ttlDays: 7, // the roster changes very slowly; once a week is plenty, and `force` refreshes immediately
  timeoutMs: 60000,
  software: 'vtuber-monitor-link',
};

/** The "canonical link shape" for each platform's account — used to turn an id into a matchable alias and to display it in the UI */
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
  // Runtime dir: a sibling of reports/feeds, so it never ends up in the repo or in a release package
  return path.join(resolveDir(cfg, 'feedsDir'), '..', 'vdb');
}

function indexPath(cfg) {
  return path.join(cacheDir(cfg), 'index.json');
}

/** Normalise one VDB record */
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
  // Whichever language `default` points at becomes the primary name; otherwise the cn → jp → en order applies
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
 * Build the index from the tarball contents. A pure function (touches no disk), so it is easy to assert on.
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

/** Download + build index + write cache (no re-download within the TTL; `force` refreshes regardless) */
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
      /* no cache yet, so download */
    }
  }
  const url = String(opts.url ?? VDB_DEFAULTS.url);
  log?.info?.(`fetching the VDB roster (one request, ~0.5MB): ${url}`);
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
    log?.warn?.(`writing the VDB index cache failed (does not affect this use): ${e.message}`);
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
 * Search: names (any language, including extra aliases) and account ids/links on **any platform**
 * both match -- so "I only remember his name on twitch" still finds him.
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

/** Members of one agency */
export function membersOfGroup(index, group) {
  return (index?.records ?? []).filter((r) => r.group === group);
}

/**
 * VDB record → our "watch target" shape.
 * **Platform-agnostic**: whatever accounts holds goes straight into links (no assumption of bilibili).
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

/** Generate a stable, readable id (the VDB filename is the natural primary key) */
export function slug(s) {
  const base = String(s ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  return base || `vdb-${Date.now().toString(36)}`;
}

/** Index summary (for the UI and the logs) */
export function indexSummary(index) {
  if (!index?.count) return '尚未获取 VDB 花名册';
  return `${index.count} 位（社团 ${Object.keys(index.groups ?? {}).length} 个）· 更新于 ${String(index.generatedAt).slice(0, 10)}`;
}
