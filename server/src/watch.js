// watch.js — 监视对象 / watch targets
//
// 设计参考了萌娘百科的监视技术（MediaWiki 的 watchlist-brief 与
// recent-changes-brief）：把「改了没」升级成「改了哪里、改了多少、值不值得看」。
//
// 四类监视对象：
//   url                   任意网页/接口：取正文 → 归一化 → 哈希基线 → 行级 diff
//   mediawiki-page        指定条目的版本修订：revid 比对 + compare 接口拿 diff
//   mediawiki-recentchanges 最近更改流：按规则筛出值得关注的改动
//   mediawiki-watchlist   登录后的监视列表：需要 BotPassword（只存本机配置）
//   bili-opus             B 站动态：比对新 opus_id，并记录粉丝数增长
//
// 告警规则（照搬萌百那一套，阈值可配）：
//   大编辑 / 大删除 / 新建页面 / 匿名编辑 / 未巡查 / 特定日志类型 / 可疑关键词
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDir } from './config.js';
import { netFetch, resolveProxyMode } from './net.js';
import { gapWithJitter } from './observe.js';
import { setTimeout as sleep } from 'node:timers/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const TARGET_KINDS = [
  { id: 'url', zh: '任意网页', en: 'Any web page', login: 'none' },
  { id: 'mediawiki-page', zh: 'MediaWiki 条目', en: 'MediaWiki page', login: 'none' },
  { id: 'mediawiki-recentchanges', zh: 'MediaWiki 最近更改', en: 'MediaWiki recent changes', login: 'none' },
  { id: 'mediawiki-watchlist', zh: 'MediaWiki 监视列表', en: 'MediaWiki watchlist', login: 'required' },
  { id: 'bili-opus', zh: 'B 站动态', en: 'bilibili dynamics', login: 'none' },
];

/** 监视对象允许出现的字段（白名单，避免前端把任意东西写进配置） */
export const TARGET_FIELDS = [
  'id',
  'kind',
  'label',
  'enabled',
  'url',
  'proxy',
  'mode',
  'ignorePatterns',
  'apiUrl',
  'page',
  'namespaces',
  'limit',
  'uid',
  'username',
  'botPassword',
  'executablePath',
  'profileDir',
];

export function sanitizeTarget(input = {}, index = 0) {
  const out = {};
  for (const k of TARGET_FIELDS) if (input[k] !== undefined) out[k] = input[k];
  out.kind = TARGET_KINDS.some((k) => k.id === out.kind) ? out.kind : 'url';
  out.id = String(out.id ?? `target-${index + 1}`)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 60);
  out.label = String(out.label ?? out.url ?? out.page ?? out.uid ?? out.id).slice(0, 120);
  out.enabled = out.enabled !== false;
  if (Array.isArray(out.ignorePatterns)) out.ignorePatterns = out.ignorePatterns.filter((x) => typeof x === 'string').slice(0, 50);
  if (Array.isArray(out.namespaces)) out.namespaces = out.namespaces.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (out.limit !== undefined) out.limit = Math.max(1, Math.min(500, Number(out.limit) || 50));
  return out;
}

export const DEFAULT_RULES = {
  largeEditBytes: 5000,
  largeDeleteBytes: 2000,
  newPage: true,
  anonymousEdit: true,
  unpatrolled: true,
  logTypes: ['delete', 'move', 'protect', 'block', 'rights', 'abusefilter', 'upload', 'import'],
  keywords: ['毕业', '卒業', '解约', '引退', '炎上', '休止', '终止', '解散', '独立', '移籍', '道歉', '声明'],
  maxEvents: 40,
};

// ───────────────────────────────────────────── 存储 / storage

export function watchDir(cfg) {
  const dir = resolveDir(cfg, 'watchDir');
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  return dir;
}

function baselinesPath(cfg, id) {
  if (id) return path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.baseline.json`);
  return path.join(watchDir(cfg), 'baselines.json');
}

export function sanitizeId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'target';
}

export function getBaseline(cfg, id) {
  const f = baselinesPath(cfg, id);
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    /* 损坏就当没有 */
  }
  return null;
}

export function setBaseline(cfg, id, data) {
  const f = baselinesPath(cfg, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  return data;
}

export function allBaselines(cfg) {
  const dir = path.join(watchDir(cfg), 'history');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+)\.baseline\.json$/.exec(f);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function appendHistory(cfg, id, entry) {
  const f = path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

export function readHistory(cfg, id, limit = 50) {
  const f = path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

// ───────────────────────────────────────────── 文本处理 / text

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeText(text, ignorePatterns = []) {
  let lines = String(text ?? '').split(/\r?\n/);
  const res = ignorePatterns
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (res.length) lines = lines.filter((l) => !res.some((re) => re.test(l)));
  return lines.join('\n').trim();
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

function truncate(s, max = 200_000) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}\n…（已截断，原文 ${t.length} 字符）` : t;
}

// ───────────────────────────────────────────── 规则 / alarm rules

/**
 * 对一条变更应用告警规则
 * @returns {{alert:boolean, reasons:string[]}}
 */
export function applyRules(change, rules = DEFAULT_RULES) {
  const reasons = [];
  const r = { ...DEFAULT_RULES, ...(rules ?? {}) };

  if (typeof change.delta === 'number') {
    if (change.delta <= -Math.abs(r.largeDeleteBytes ?? 0)) reasons.push(`大量删除 ${-change.delta} 字节`);
    else if (change.delta >= Math.abs(r.largeEditBytes ?? 0)) reasons.push(`大量新增 ${change.delta} 字节`);
  }
  if (r.newPage && change.isNew) reasons.push('新建页面');
  if (r.anonymousEdit && change.anon) reasons.push('匿名用户编辑');
  if (r.unpatrolled && change.unpatrolled) reasons.push('未巡查编辑');
  if (change.logType && (r.logTypes ?? []).includes(change.logType)) reasons.push(`日志：${change.logType}`);

  const hay = `${change.comment ?? ''} ${change.title ?? ''} ${change.text ?? ''}`.toLowerCase();
  const hit = (r.keywords ?? []).filter((k) => k && hay.includes(String(k).toLowerCase()));
  if (hit.length) reasons.push(`关键词：${hit.join('、')}`);

  return { alert: reasons.length > 0, reasons };
}

// ───────────────────────────────────────────── 各类型检查 / checks

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

async function jget(url, { cfg, target, timeout = 25000, headers } = {}) {
  const r = await netFetch(
    url,
    {
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(headers ?? {}),
      },
      signal: withTimeout(timeout),
    },
    { cfg, subject: target }
  );
  return r;
}

function apiOf(apiUrl) {
  const u = String(apiUrl ?? '').trim();
  if (!u) throw new Error('缺少 apiUrl / missing apiUrl');
  return u.includes('?') ? `${u}&format=json` : `${u}?format=json`;
}

// ── 1) 任意网页
async function checkUrl(target, ctx) {
  const r = await jget(target.url, { cfg: ctx.cfg, target });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const raw = await r.text();
  const text = truncate(normalizeText(target.mode === 'html' ? raw : stripHtml(raw), target.ignorePatterns));
  const hash = sha256(text);
  const prev = getBaseline(ctx.cfg, target.id);

  if (!prev) {
    setBaseline(ctx.cfg, target.id, { kind: 'url', hash, text, url: target.url });
    return { target, first: true, changed: false, events: [], summary: '已建立基线 / baseline created' };
  }
  if (prev.hash === hash) return { target, changed: false, events: [], summary: '无变化 / unchanged' };

  const { diffLines, diffStats, diffHunks } = await import('./diff.js');
  const lines = diffLines(prev.text ?? '', text);
  const stats = diffStats(lines);
  const hunks = diffHunks(lines, 3);
  const added = hunks.filter((l) => l.op === '+').map((l) => l.text).join('\n');
  const event = {
    kind: 'change',
    url: target.url,
    stats,
    hunks,
    before: (prev.text ?? '').slice(0, 4000),
    after: text.slice(0, 4000),
    title: target.label ?? target.url,
    text: added.slice(0, 4000),
    delta: text.length - (prev.text ?? '').length,
  };
  // 关键词告警的判定要覆盖「新内容的整体」，只看新增行会漏掉改词不增行的情况
  const verdict = applyRules({ ...event, text: `${added}\n${text.slice(0, 1500)}` }, ctx.rules);
  setBaseline(ctx.cfg, target.id, { kind: 'url', hash, text, url: target.url });
  return {
    target,
    changed: true,
    events: [{ ...event, reasons: verdict.reasons }],
    summary: `内容变化 +${stats.added}/-${stats.removed} 行${verdict.reasons.length ? `（告警：${verdict.reasons.join('、')}）` : ''}`,
  };
}

// ── 2) MediaWiki 条目
async function fetchPageRev(target, ctx) {
  const url = `${apiOf(target.apiUrl)}&action=query&prop=revisions&rvprop=ids%7Ctimestamp%7Cuser%7Ccomment%7Csize%7Cflags&rvlimit=1&titles=${encodeURIComponent(target.page)}`;
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  const pages = j?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) throw new Error(`条目不存在 / page not found: ${target.page}`);
  const rev = (page.revisions ?? [])[0];
  if (!rev) throw new Error('取不到修订 / no revision');
  return { rev, title: page.title };
}

async function checkMediaWikiPage(target, ctx) {
  const { rev, title } = await fetchPageRev(target, ctx);
  const prev = getBaseline(ctx.cfg, target.id);

  if (!prev) {
    setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-page', revid: rev.revid, size: rev.size, title, timestamp: rev.timestamp });
    return { target, first: true, changed: false, events: [], summary: `已建立基线 revid=${rev.revid}` };
  }
  if (prev.revid === rev.revid) return { target, changed: false, events: [], summary: `无变化（revid=${rev.revid}）` };

  let hunks = [];
  try {
    const cmpUrl = `${apiOf(target.apiUrl)}&action=compare&fromrev=${encodeURIComponent(prev.revid)}&torev=${encodeURIComponent(rev.revid)}`;
    const cr = await jget(cmpUrl, { cfg: ctx.cfg, target });
    const cj = await cr.json().catch(() => null);
    const html = cj?.compare?.['*'] ?? '';
    const lines = stripHtml(html).split('\n').filter(Boolean);
    hunks = lines
      .filter((l) => /^[-+]/.test(l) || l.startsWith('&#160;') === false)
      .slice(0, 400)
      .map((l) => ({ op: /^\+/.test(l) ? '+' : /^-/.test(l) ? '-' : ' ', text: l.replace(/^[-+]\s?/, ''), aLine: null, bLine: null }));
  } catch {
    /* compare 失败就只报「变了」 */
  }

  const delta = typeof rev.size === 'number' && typeof prev.size === 'number' ? rev.size - prev.size : undefined;
  const event = {
    kind: 'revision',
    title,
    url: `${String(target.apiUrl).replace(/\/api\.php.*$/, '')}/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
    from: prev.revid,
    to: rev.revid,
    delta,
    user: rev.user,
    comment: rev.comment,
    anon: !!rev.anon,
    timestamp: rev.timestamp,
    hunks,
    text: String(rev.comment ?? ''),
  };
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-page', revid: rev.revid, size: rev.size, title, timestamp: rev.timestamp });
  const verdict = applyRules(event, ctx.rules);
  return { target, changed: true, events: [{ ...event, reasons: verdict.reasons }], summary: `条目已修订 revid ${prev.revid} → ${rev.revid}${delta !== undefined ? `（${delta >= 0 ? '+' : ''}${delta} 字节）` : ''}` };
}

// ── 3) MediaWiki 最近更改
function rcToEvents(rows, rules) {
  const out = [];
  for (const r of rows) {
    const event = {
      kind: 'recentchange',
      title: r.title,
      rcid: r.rcid,
      type: r.type,
      logType: r.logtype,
      user: r.user,
      comment: r.comment,
      timestamp: r.timestamp,
      anon: !!r.anon,
      bot: !!r.bot,
      // MediaWiki 用 flags 里的 unpatrolled 标记未巡查编辑
      unpatrolled: Object.prototype.hasOwnProperty.call(r, 'unpatrolled'),
      isNew: !!r.new,
      delta: typeof r.newlen === 'number' && typeof r.oldlen === 'number' ? r.newlen - r.oldlen : undefined,
      url: r.title ? `https://${String(r.wiki ?? '').replace(/^https?:\/\//, '')}` : '',
    };
    const v = applyRules(event, rules);
    if (v.alert) out.push({ ...event, reasons: v.reasons });
  }
  return out;
}

async function checkRecentChanges(target, ctx) {
  const ns = (target.namespaces ?? [0]).join('|');
  const url =
    `${apiOf(target.apiUrl)}&action=query&list=recentchanges` +
    `&rcprop=title%7Ctimestamp%7Cuser%7Ccomment%7Csize%7Cflags%7Cids%7Cloginfo` +
    `&rclimit=${Number(target.limit ?? 50)}&rctype=edit%7Cnew%7Clog` +
    (ns ? `&rcnamespace=${encodeURIComponent(ns)}` : '');
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  const rows = j?.query?.recentchanges ?? [];
  const prev = getBaseline(ctx.cfg, target.id);
  const since = prev?.lastTimestamp ? Date.parse(prev.lastTimestamp) : 0;

  const fresh = since ? rows.filter((x) => Date.parse(x.timestamp) > since) : rows;
  const events = rcToEvents(fresh, ctx.rules);
  const lastTimestamp = rows[0]?.timestamp ?? prev?.lastTimestamp ?? new Date().toISOString();
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-recentchanges', lastTimestamp });

  return {
    target,
    first: !prev,
    changed: events.length > 0,
    events,
    summary: prev
      ? `${fresh.length} 条新更改，其中 ${events.length} 条命中规则`
      : `已建立基线（首次抓取 ${rows.length} 条，不计为变更）`,
  };
}

// ── 4) MediaWiki 监视列表（需要登录）
async function mwLogin(target, ctx) {
  const api = apiOf(target.apiUrl);
  const tokRes = await jget(`${api}&action=query&meta=tokens&type=login`, { cfg: ctx.cfg, target });
  const tok = await tokRes.json().catch(() => null);
  const loginToken = tok?.query?.tokens?.logintoken;
  if (!loginToken) throw new Error('取不到 login token / cannot obtain login token');

  const body = new URLSearchParams({
    action: 'login',
    lgname: target.username ?? '',
    lgpassword: target.botPassword ?? '',
    lgtoken: loginToken,
    format: 'json',
  });
  const r = await netFetch(
    api,
    {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: withTimeout(25000),
    },
    { cfg: ctx.cfg, subject: target }
  );
  const j = await r.json().catch(() => null);
  const result = j?.login?.result;
  if (result !== 'Success') throw new Error(`登录失败 / login failed: ${result ?? 'unknown'}${j?.login?.reason ? ` (${j.login.reason})` : ''}`);
  return true;
}

async function checkWatchlist(target, ctx) {
  if (!target.username || !target.botPassword) {
    throw new Error('监视列表需要 username 与 botPassword / username & botPassword required');
  }
  await mwLogin(target, ctx);
  const url =
    `${apiOf(target.apiUrl)}&action=query&list=watchlist` +
    `&wlprop=title%7Ctimestamp%7Cuser%7Ccomment%7Csizes%7Cflags%7Cids&wllimit=${Number(target.limit ?? 50)}&wlallrev=0`;
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  if (j?.error) throw new Error(`watchlist 报错 / error: ${j.error.info ?? j.error.code}`);
  const rows = j?.query?.watchlist ?? [];
  const prev = getBaseline(ctx.cfg, target.id);
  const since = prev?.lastTimestamp ? Date.parse(prev.lastTimestamp) : 0;
  const fresh = since ? rows.filter((x) => Date.parse(x.timestamp) > since) : rows;
  const events = rcToEvents(fresh, ctx.rules);
  const lastTimestamp = rows[0]?.timestamp ?? prev?.lastTimestamp ?? new Date().toISOString();
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-watchlist', lastTimestamp });
  return {
    target,
    first: !prev,
    changed: events.length > 0,
    events,
    summary: prev ? `监视列表 ${rows.length} 条，${fresh.length} 条新增，${events.length} 条命中规则` : `已建立基线（${rows.length} 条）`,
  };
}

// ── 5) B 站动态
async function checkBiliOpus(target, ctx) {
  const { fetchBilibiliOpus, fetchFollowers } = await import('./fetchers/bilibili.js');
  const source = { ...target, id: target.id, uid: target.uid, proxy: target.proxy };
  const res = await fetchBilibiliOpus(source, { cfg: ctx.cfg, log: ctx.log });
  const ids = res.items.map((i) => i.id);
  const prev = getBaseline(ctx.cfg, target.id);
  const follower = res.followers?.follower ?? null;
  const followerDelta = follower !== null && typeof prev?.follower === 'number' ? follower - prev.follower : null;

  const fresh = prev ? res.items.filter((i) => !(prev.ids ?? []).includes(i.id)) : [];
  const events = fresh.map((i) => ({
    kind: 'dynamic',
    title: i.text.slice(0, 60),
    text: i.text,
    url: i.url,
    images: i.images,
    stats: i.stats,
    timestamp: i.time,
    delta: 0,
  }));
  if (followerDelta) {
    events.push({
      kind: 'growth',
      title: '关注量变化',
      text: `粉丝 ${prev.follower} → ${follower}`,
      delta: followerDelta,
      timestamp: new Date().toISOString(),
    });
  }
  const withReasons = events.map((e) => ({ ...e, reasons: applyRules(e, ctx.rules).reasons }));
  setBaseline(ctx.cfg, target.id, { kind: 'bili-opus', ids: ids.slice(0, 200), follower, at: new Date().toISOString() });

  return {
    target,
    first: !prev,
    changed: fresh.length > 0 || !!followerDelta,
    events: withReasons,
    growth: follower !== null ? { follower, delta: followerDelta } : null,
    summary: prev
      ? `${fresh.length} 条新动态${followerDelta ? `，粉丝 ${followerDelta > 0 ? '+' : ''}${followerDelta}` : ''}`
      : `已建立基线（${ids.length} 条动态，粉丝 ${follower ?? '?'}）`,
  };
}

// ───────────────────────────────────────────── 对外 / public

const HANDLERS = {
  url: checkUrl,
  'mediawiki-page': checkMediaWikiPage,
  'mediawiki-recentchanges': checkRecentChanges,
  'mediawiki-watchlist': checkWatchlist,
  'bili-opus': checkBiliOpus,
};

/** 检查单个监视对象 / check one target */
export async function checkTarget(target, { cfg, rules, log } = {}) {
  const fn = HANDLERS[target.kind];
  if (!fn) return { target, ok: false, error: `未知监视类型 / unknown kind: ${target.kind}`, events: [] };
  const ctx = { cfg, log, rules: { ...DEFAULT_RULES, ...(rules ?? cfg?.watch?.rules ?? {}) }, applyRules };
  try {
    const r = await fn(target, ctx);
    const out = { ok: true, ...r };
    // 有变化的才落历史，避免噪声
    if (out.changed && !out.first) {
      appendHistory(cfg, target.id, {
        kind: target.kind,
        label: target.label,
        summary: out.summary,
        growth: out.growth ?? null,
        events: out.events.map((e) => ({ ...e, hunks: e.hunks ? e.hunks.slice(0, 200) : undefined })),
      });
    }
    log?.info(`监视 ${target.id}: ${out.summary}`);
    return out;
  } catch (err) {
    // undici 的 "fetch failed" 本身没有信息量，把 cause 一起带上才有诊断价值
    const cause = err?.cause?.message ?? err?.cause?.code ?? '';
    const msg = cause ? `${err.message}（${cause}）` : err.message;
    log?.error(`监视 ${target.id} 失败 / failed — ${msg}`);
    return { target, ok: false, changed: false, events: [], error: msg };
  }
}

/**
 * 检查监视对象。
 * @param {object} cfg
 * @param {object} log
 * @param {{targets?:object[]}} opts 观测模式下只传本轮取到的那几个（见 observe.js）
 */
export async function checkAll(cfg, log, opts = {}) {
  const targets = Array.isArray(opts.targets)
    ? opts.targets
    : (cfg?.watch?.targets ?? []).filter((t) => t.enabled !== false);
  const results = [];
  let first = true;
  for (const t of targets) {
    // 观测模式下检查之间也抖动 —— 连着几个对象精确等距地检查，本身就是机器特征
    if (!first && cfg?.observation?.enabled) {
      const gap = gapWithJitter(2, cfg?.observation?.jitterSeconds);
      if (gap > 0) await sleep(gap * 1000);
    }
    first = false;
    results.push(await checkTarget(t, { cfg, rules: cfg?.watch?.rules, log }));
  }
  return results;
}
