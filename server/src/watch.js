// watch.js — watch targets / watch targets
//
// The design borrows the watch techniques from Moegirlpedia (MediaWiki's watchlist-brief and
// recent-changes-brief): upgrade "did it change" into "what changed, how much changed, is it worth reading".
//
// Four kinds of watch targets:
//   url                    any web page/API: fetch body -> normalize -> hash baseline -> line-level diff
//   mediawiki-page         revisions of a given page: revid comparison + the compare API for the diff
//   mediawiki-recentchanges the recent-changes stream: filter out the changes worth attention by rule
//   mediawiki-watchlist    the watchlist after logging in: requires BotPassword (stored locally only)
//   bili-opus              bilibili dynamics: compare new opus_id and record follower growth
//
// Alarm rules (copied from that Moegirlpedia set, thresholds configurable):
//   large edit / large delete / new page / anonymous edit / unpatrolled / specific log types / suspicious keywords
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

/** Fields a watch target may carry (an allowlist, so the front end cannot write arbitrary things into the config) */
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

// ───────────────────────────────────────────── storage / storage

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
    /* corrupt file: treat as absent */
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

// ───────────────────────────────────────────── text / text

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

// ───────────────────────────────────────────── alarm rules / alarm rules

/**
 * Apply the alarm rules to one change
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

// ───────────────────────────────────────────── per-kind checks / checks

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

// ── 1) Any web page
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
  // Keyword alarms must be judged over "the whole of the new content"; looking only at added lines misses a reworded line that adds no lines
  const verdict = applyRules({ ...event, text: `${added}\n${text.slice(0, 1500)}` }, ctx.rules);
  setBaseline(ctx.cfg, target.id, { kind: 'url', hash, text, url: target.url });
  return {
    target,
    changed: true,
    events: [{ ...event, reasons: verdict.reasons }],
    summary: `内容变化 +${stats.added}/-${stats.removed} 行${verdict.reasons.length ? `（告警：${verdict.reasons.join('、')}）` : ''}`,
  };
}

// ── 2) MediaWiki page
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
    /* if compare fails, only report "it changed" */
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

// ── 3) MediaWiki recent changes
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
      // MediaWiki flags unpatrolled edits with `unpatrolled` in flags
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

// ── 4a) "does this wiki credential work?" -- a pure request builder and a pure parser
//
// Why this exists as its own pair of pure functions rather than as three lines inside a route: the
// target configures a **real login credential** (a wiki `username` + `botPassword`, used by the
// watchlist check below), and until now nothing in the application ever measured whether it works --
// the first thing that found out was a watch run, whose failure reads as "the wiki changed".
//
// Two rules shape the request, and both come from the credential being secret:
//   • the password travels **only** in the Authorization header. A basic-auth credential put in the
//     URL would be echoed by proxies, redirect targets and error messages, and this project logs the
//     URLs it fetches;
//   • the call is **read-only**: `meta=userinfo` with `assert=user` answers "who am I" in one request
//     and can never write. There is no write action anywhere in this pair of functions.
// The returned "safe request" carries no credential at all, so it is the one thing that may be logged.

/** The wiki host of an api.php address ('' when the address has no parseable host) */
export function wikiHostOf(apiUrl) {
  try {
    return new URL(String(apiUrl ?? '').trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Build the MediaWiki "who am I, and am I logged in" request.
 *
 * Pure: nothing is sent here. The caller hands the result to netFetch.
 * @param {{apiUrl?:string, username?:string, botPassword?:string, proxy?:string}} target
 * @returns {{ok:true, url:string, headers:object, host:string, domain:string}
 *          |{ok:false, error:string, missing:string}}
 */
export function buildWikiLoginRequest(target = {}) {
  const apiUrl = String(target.apiUrl ?? '').trim();
  const username = String(target.username ?? '').trim();
  const password = String(target.botPassword ?? '');
  // Refuse politely rather than firing a request with a blank password: a blank credential is not a
  // failed login, it is a question that was never asked, and an anonymous answer would be read as
  // "your credential does not work".
  const missing = [];
  if (!apiUrl) missing.push('apiUrl');
  if (!username) missing.push('username');
  if (!password) missing.push('botPassword');
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: `missing ${missing.join(' / ')} -- nothing was requested`,
    };
  }
  const host = wikiHostOf(apiUrl);
  if (!host) return { ok: false, missing: ['apiUrl'], error: 'the api url has no usable host -- nothing was requested' };
  // `format=json` is appended the same way apiOf() does it, but this builder must stay usable on its
  // own (the route and the tests both call it directly).
  const url =
    `${apiUrl}${apiUrl.includes('?') ? '&' : '?'}format=json` +
    '&action=query&meta=userinfo&uiprop=rights%7Cgroups&assert=user';
  return {
    ok: true,
    url,
    host,
    // The label the UI shows next to a result: the same host the credential was read for. Kept apart
    // from `host` because the cookie probe lower-cases and may strip a leading `www.`.
    domain: host.replace(/^www\./, ''),
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      // BotPassword credentials are sent as basic auth (`BotName@TaskName:password`).
      authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      // No cookie jar: one request, one credential, nothing to persist at the site.
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
}

/**
 * The log-safe view of a built request: **no credential**. Written as its own function so "nothing
 * secret is logged" is a property a test can assert rather than a habit.
 */
export function safeLoginRequestSummary(req) {
  if (!req?.ok) return { ok: false, error: req?.error ?? 'request not built' };
  return { ok: true, url: req.url, host: req.host, method: 'GET', hasAuthorization: true };
}

/**
 * Parse the answer to that request.
 *
 * Pure. Three outcomes are kept apart on purpose, because they send the person in different
 * directions: an authenticated answer names the account, `anon` means the site ignored the
 * credential (for a basic-auth request that means the Wiki does not accept BotPassword over
 * Authorization), and `error` is the site's own reason -- userinfo plus `assert=user` answers
 * `assertuserfailed` when the credential is wrong, and that code is more useful than anything this
 * module could invent.
 * @returns {{ok:boolean, status:'ok'|'anon'|'error', user?:string, anon?:boolean, groups?:string[],
 *            rights?:string[], code?:string, reason:string}}
 */
export function parseWikiLoginResponse(payload) {
  const j = payload && typeof payload === 'object' ? payload : null;
  if (!j) return { ok: false, status: 'error', code: 'bad-response', reason: 'the wiki did not return JSON' };
  if (j.error) {
    const code = String(j.error.code ?? 'error');
    const info = String(j.error.info ?? '').trim();
    return { ok: false, status: 'error', code, reason: info ? `${code}: ${info}` : code };
  }
  const u = j.query?.userinfo;
  if (!u) return { ok: false, status: 'error', code: 'no-userinfo', reason: 'the answer carried no userinfo block' };
  if (u.anon === true || u.id === 0) {
    return {
      ok: false,
      status: 'anon',
      anon: true,
      reason: 'the wiki answered as an anonymous user: the credential was not accepted',
    };
  }
  const user = String(u.name ?? '').trim();
  if (!user) return { ok: false, status: 'error', code: 'no-name', reason: 'the answer named no account' };
  return {
    ok: true,
    status: 'ok',
    user,
    anon: false,
    groups: Array.isArray(u.groups) ? u.groups : [],
    rights: Array.isArray(u.rights) ? u.rights : [],
    reason: '',
  };
}

/**
 * Measure the configured wiki credential with one read-only request.
 *
 * The password is never returned, logged or echoed: the result carries the account name or the
 * site's own reason, and nothing else. A failure to reach the wiki is reported as such rather than
 * as "the credential is wrong" -- the two are different facts.
 * @param {{apiUrl?:string, username?:string, botPassword?:string, proxy?:string}} target
 * @param {{cfg?:object, log?:object}} ctx
 * @param {{fetchImpl?:Function}} [opts] injectable for tests
 */
export async function checkWatchLogin(target = {}, ctx = {}, opts = {}) {
  const built = buildWikiLoginRequest(target);
  if (!built.ok) return { ok: false, checked: false, status: 'incomplete', missing: built.missing, reason: built.error };
  const doFetch = opts.fetchImpl ?? jget;
  let res;
  try {
    res = await doFetch(built.url, {
      cfg: ctx.cfg,
      target: { ...target, botPassword: undefined },
      headers: { authorization: built.headers.authorization },
    });
  } catch (e) {
    const cause = e?.cause?.message ?? e?.cause?.code ?? '';
    return { ok: false, checked: true, status: 'error', domain: built.domain, reason: `could not reach the wiki: ${e.message}${cause ? ` (${cause})` : ''}` };
  }
  if (!res?.ok) {
    return { ok: false, checked: true, status: 'error', domain: built.domain, httpStatus: res?.status ?? null, reason: `the wiki answered HTTP ${res?.status ?? '?'}` };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const parsed = parseWikiLoginResponse(payload);
  return { ok: parsed.ok, checked: true, domain: built.domain, ...parsed };
}

// ── 4) MediaWiki watchlist (requires login)
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

// ── 5) bilibili dynamics
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

// ───────────────────────────────────────────── public / public

const HANDLERS = {
  url: checkUrl,
  'mediawiki-page': checkMediaWikiPage,
  'mediawiki-recentchanges': checkRecentChanges,
  'mediawiki-watchlist': checkWatchlist,
  'bili-opus': checkBiliOpus,
};

/** Check a single watch target / check one target */
export async function checkTarget(target, { cfg, rules, log } = {}) {
  const fn = HANDLERS[target.kind];
  if (!fn) return { target, ok: false, error: `未知监视类型 / unknown kind: ${target.kind}`, events: [] };
  const ctx = { cfg, log, rules: { ...DEFAULT_RULES, ...(rules ?? cfg?.watch?.rules ?? {}) }, applyRules };
  try {
    const r = await fn(target, ctx);
    const out = { ok: true, ...r };
    // Only record history when something changed, to avoid noise
    if (out.changed && !out.first) {
      appendHistory(cfg, target.id, {
        kind: target.kind,
        label: target.label,
        summary: out.summary,
        growth: out.growth ?? null,
        events: out.events.map((e) => ({ ...e, hunks: e.hunks ? e.hunks.slice(0, 200) : undefined })),
      });
    }
    log?.info(`watch ${target.id}: ${out.summary}`);
    return out;
  } catch (err) {
    // undici's "fetch failed" carries no information by itself; including the cause is what makes it diagnosable
    const cause = err?.cause?.message ?? err?.cause?.code ?? '';
    const msg = cause ? `${err.message}（${cause}）` : err.message;
    log?.error(`watch ${target.id} failed / failed — ${msg}`);
    return { target, ok: false, changed: false, events: [], error: msg };
  }
}

/**
 * Check the watch targets.
 * @param {object} cfg
 * @param {object} log
 * @param {{targets?:object[]}} opts in observation mode only pass the ones drawn this round (see observe.js)
 */
export async function checkAll(cfg, log, opts = {}) {
  const targets = Array.isArray(opts.targets)
    ? opts.targets
    : (cfg?.watch?.targets ?? []).filter((t) => t.enabled !== false);
  const results = [];
  let first = true;
  for (const t of targets) {
    // Jitter between checks in observation mode too -- checking several targets at exactly even intervals is itself a machine signature
    if (!first && cfg?.observation?.enabled) {
      const gap = gapWithJitter(2, cfg?.observation?.jitterSeconds);
      if (gap > 0) await sleep(gap * 1000);
    }
    first = false;
    results.push(await checkTarget(t, { cfg, rules: cfg?.watch?.rules, log }));
  }
  return results;
}
