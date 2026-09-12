// share.js — one-click sharing / one-click sharing
//
// "Sharing" covers two classes of target, and they differ completely in what they require around **login**,
// so they have to be treated separately:
//
//   A. No login needed: export a single-file HTML / Markdown / JSON, copy as text, push to a webhook
//      -- this is the main path. It is always available and carries no account risk whatsoever.
//   B. Login needed: post to a bilibili dynamic / X and the like. These must **probe the login state first
//      and only then decide whether they can run** -- we may not pretend we can post, and even less silently
//      fail while logged out. And they are **never sent automatically by a scheduled run**: speaking in
//      public is an irreversible act that requires explicit human confirmation (the same discipline as danmaku posting).
//
// So the core of this module is not "how to post" but three things:
//   1) **Generate a single file that carries its own styling** (open it and it just works, no external
//      assets, and it will not get blocked when sent to a friend)
//   2) **State honestly what each target is missing** (ready / needs-login / needs-verification / unsupported)
//   3) **Do only what can be done, and leave a trace** (confirmation gate + audit log)
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { htmlShell } from './reports.js';
import { listAccounts } from './accounts.js';
import { readBrowserCookies } from './cookies.js';
import { netFetch } from './net.js';

/**
 * The share-target registry.
 *
 * Every target must declare honestly:
 *   needsLogin  -- whether a login state is required
 *   status      -- ready (usable right now) / needs-login (login missing) / needs-verification (the feature
 *                  exists but **has never been verified with a real account**, and may only be used
 *                  externally once it has been) / unsupported (cannot be done)
 * Better to write needs-verification than to pretend to be ready -- a failed or wrong public post is irreversible.
 */
export const SHARE_TARGETS = [
  {
    id: 'file-html',
    name: { zh: '单文件网页（推荐）', en: 'Single-file web page (recommended)' },
    needsLogin: false,
    status: 'ready',
    kind: 'download',
    format: 'html',
    hint: {
      zh: '自带样式的单文件 HTML：对方双击就能看，不依赖网络与任何外部资源。',
      en: 'Self-contained styled HTML: the recipient just opens it; no network or external assets.',
    },
  },
  {
    id: 'file-md',
    name: { zh: 'Markdown 文件', en: 'Markdown file' },
    needsLogin: false,
    status: 'ready',
    kind: 'download',
    format: 'md',
    hint: { zh: '适合贴进文档/仓库。', en: 'Good for pasting into docs or a repo.' },
  },
  {
    id: 'file-json',
    name: { zh: 'JSON 数据', en: 'JSON data' },
    needsLogin: false,
    status: 'ready',
    kind: 'download',
    format: 'json',
    hint: { zh: '给别的程序吃。', en: 'For another program to consume.' },
  },
  {
    id: 'text',
    name: { zh: '复制文本', en: 'Copy as text' },
    needsLogin: false,
    status: 'ready',
    kind: 'text',
    format: 'text',
    hint: { zh: '直接复制到聊天窗口。', en: 'Paste straight into a chat window.' },
  },
  {
    id: 'webhook',
    name: { zh: '推到已配置的推送通道', en: 'Send via a configured notify channel' },
    needsLogin: false,
    status: 'ready',
    kind: 'notify',
    hint: {
      zh: '用「设置 → 推送」里已经配好的通道发出去（不需要额外登录）。',
      en: 'Sends through the channels configured in Settings → Notifications (no extra login).',
    },
  },
  {
    id: 'bilibili-dynamic',
    name: { zh: '发到 B 站动态', en: 'Post to a bilibili dynamic' },
    needsLogin: true,
    loginKind: 'bilibili',
    status: 'needs-verification',
    kind: 'post',
    hint: {
      zh: '需要 B 站的 SESSDATA + bili_jct（就是从浏览器登录态里读的那套）。**功能已实现但尚未用真实账号验证过** —— 第一次成功发出后它才会被标为可用。绝不能自动发：必须你点确认。',
      en: 'Needs bilibili SESSDATA + bili_jct (read from your browser login). The code path exists but has NOT been verified with a real account yet; it becomes available only after one successful post. Never automatic — always requires your confirmation.',
    },
  },
  {
    id: 'x-post',
    name: { zh: '发到 X / Twitter', en: 'Post to X / Twitter' },
    needsLogin: true,
    loginKind: 'twitter',
    status: 'unsupported',
    kind: 'post',
    hint: {
      zh: '不提供：X 的发帖接口要 OAuth 2.0 授权与开发者应用，用浏览器 cookie 硬凑既不可靠也违反其条款。需要的话请用官方 API 自行对接。',
      en: 'Not offered: posting to X requires OAuth 2.0 with a developer app; scraping cookies would be unreliable and against their terms. Use their official API if you need it.',
    },
  },
];

export function targetById(id) {
  return SHARE_TARGETS.find((t) => t.id === id) ?? null;
}

// ───────────────────────────────────────────── content packaging

/** Collect the shareable content out of the intel items (using the people / keywords fields in place) */
function collect(items, { maxItems = 60 } = {}) {
  return (items ?? [])
    .slice(0, maxItems)
    .map((it) => ({
      id: it.id,
      title: it.title ?? String(it.text ?? '').slice(0, 120),
      text: it.text ? String(it.text).slice(0, 400) : '',
      url: it.url ?? null,
      sourceId: it.sourceId ?? null,
      sourceName: it.sourceName ?? null,
      publishedAt: it.publishedAt ?? it.at ?? null,
      people: it.people ?? [],
      keywords: it.keywords ?? [],
      images: (it.images ?? []).slice(0, 4),
    }));
}

/** Plain markdown version (also the intermediate form for HTML and text) */
export function toMarkdown(bundle) {
  const lines = [`# ${bundle.title}`, ''];
  if (bundle.subtitle) lines.push(`> ${bundle.subtitle}`, '');
  lines.push(`共 ${bundle.items.length} 条 · 生成于 ${bundle.generatedAt}`, '');
  for (const it of bundle.items) {
    const when = it.publishedAt ? `\`${String(it.publishedAt).slice(0, 16).replace('T', ' ')}\`` : '';
    const who = it.people?.length ? ` · 👤 ${it.people.join('、')}` : '';
    const kw = it.keywords?.length ? ` · 🏷 ${it.keywords.join('、')}` : '';
    lines.push(`## ${it.title}`);
    lines.push(`${when}${who}${kw}`.trim());
    if (it.text) lines.push('', it.text);
    if (it.url) lines.push('', `[打开原文](${it.url})`);
    lines.push('');
  }
  if (bundle.note) lines.push('---', '', bundle.note);
  return lines.join('\n');
}

export function toPlainText(bundle) {
  const lines = [`${bundle.title}`, bundle.subtitle ?? '', `共 ${bundle.items.length} 条`, ''];
  for (const it of bundle.items) {
    lines.push(`· ${it.title}`);
    if (it.url) lines.push(`  ${it.url}`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Single-file HTML.
 * Key requirement: **no external references whatsoever** (no linked CSS / fonts / images / scripts) --
 * so the recipient can open it offline, on an intranet, or in any restricted environment; and it never
 * goes blank because an image host enforces hotlink protection.
 */
export function toHtml(bundle) {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const cards = bundle.items
    .map((it) => {
      const meta = [
        it.publishedAt ? esc(String(it.publishedAt).slice(0, 16).replace('T', ' ')) : '',
        it.people?.length ? `👤 ${esc(it.people.join('、'))}` : '',
        it.keywords?.length ? `🏷 ${esc(it.keywords.join('、'))}` : '',
        it.sourceId ? esc(it.sourceId) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<article class="card">
  <h2>${esc(it.title)}</h2>
  <div class="meta">${meta}</div>
  ${it.text ? `<p>${esc(it.text)}</p>` : ''}
  ${it.url ? `<p><a href="${esc(it.url)}" rel="noopener noreferrer">${esc(it.url)}</a></p>` : ''}
</article>`;
    })
    .join('\n');
  const body = `<h1>${esc(bundle.title)}</h1>
${bundle.subtitle ? `<p class="sub">${esc(bundle.subtitle)}</p>` : ''}
<p class="note">共 ${bundle.items.length} 条 · 生成于 ${esc(bundle.generatedAt)}${bundle.note ? ` · ${esc(bundle.note)}` : ''}</p>
${cards}`;
  // Reuse the report styling shell so the look stays "the same family"; then add the two rules the share view needs
  return htmlShell(bundle.title, '', '').replace(
    '</body>',
    `<style>
.card { border: 1px solid #8883; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
.card h2 { font-size: 16px; margin: 0 0 6px; border: 0; padding: 0; }
.meta, .note, .sub { font-size: 12px; color: #8888; }
.meta { margin-bottom: 8px; }
a { word-break: break-all; }
</style>
${body}
</body>`
  );
}

/**
 * Build a share bundle.
 *
 * Mind the two dates, they must not be conflated:
 *   - contentDate -- which day the **content** belongs to (that daily report / that person's data at the time)
 *   - generatedAt -- **when it was exported**
 * The filename and the title use contentDate (only then does the recipient know what this is); with no
 * content date it falls back to the export day.
 * @param {object} o
 * @param {'latest'|'day'|'person'|'event'|'items'} o.scopeKind
 * @param {object[]} o.items the already-filtered items
 * @param {string} o.title
 */
export function buildBundle({
  scopeKind = 'latest',
  items = [],
  title,
  subtitle = '',
  note = '',
  contentDate = null,
  generatedAt = new Date().toISOString(),
}) {
  return {
    scope: scopeKind,
    title: title ?? 'Vtuber 情报分享',
    subtitle,
    note,
    contentDate: contentDate ?? null,
    generatedAt,
    items: collect(items),
  };
}

export function renderBundle(bundle, format = 'html') {
  if (format === 'json') {
    return { mime: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify(bundle, null, 2) };
  }
  if (format === 'md') return { mime: 'text/markdown; charset=utf-8', ext: 'md', body: toMarkdown(bundle) };
  if (format === 'text') return { mime: 'text/plain; charset=utf-8', ext: 'txt', body: toPlainText(bundle) };
  return { mime: 'text/html; charset=utf-8', ext: 'html', body: toHtml(bundle) };
}

/** Filename: carries the scope and the **content date**, so the recipient knows at a glance what this is */
export function bundleFilename(bundle, ext) {
  const safe = String(bundle.title).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const day = bundle.contentDate ?? bundle.generatedAt.slice(0, 10);
  return `vml-share-${safe}-${day}.${ext}`;
}

/**
 * Build the content-disposition header.
 *
 * HTTP headers may carry **ASCII only** -- a filename with Chinese in it (share titles usually are
 * Chinese) throws `ERR_INVALID_CHAR: Invalid character in header content` outright and the endpoint
 * answers 500. The unit tests only verified "the filename is generated correctly" and never went
 * through the HTTP layer, so they missed it (the traversal's real request caught it).
 * The right way is RFC 5987/6266: an ASCII fallback name plus `filename*=UTF-8''<percent-encoded>`;
 * modern browsers prefer the latter, so the Chinese name survives anyway.
 */
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ───────────────────────────────────────────── login requirements

/**
 * Whether one share target can be used right now.
 * @param {object} target
 * @param {object[]} accounts the result of listAccounts()
 */
export function checkReadiness(target, accounts = []) {
  if (!target) return { ok: false, reason: 'unknown target' };
  if (target.status === 'unsupported') return { ok: false, status: 'unsupported', reason: 'unsupported' };
  if (!target.needsLogin) return { ok: true, status: 'ready' };
  const usable = (accounts ?? []).filter((a) => a.canSend && a.kind === target.loginKind);
  if (!usable.length) {
    return {
      ok: false,
      status: 'needs-login',
      reason:
        target.loginKind === 'bilibili'
          ? '需要 B 站登录态（SESSDATA + bili_jct），并且浏览器里得是已登录状态'
          : `需要 ${target.loginKind} 的登录态`,
    };
  }
  return { ok: target.status === 'ready', status: target.status, account: usable[0].name ?? usable[0].mid ?? null, ready: target.status === 'ready' };
}

/** Readiness of every target at a glance (the UI uses it to show what is missing) */
export function readinessReport(accounts = [], verified = []) {
  return SHARE_TARGETS.map((t) => {
    const r = checkReadiness(t, accounts);
    const isVerified = (verified ?? []).includes(t.id);
    return {
      id: t.id,
      name: t.name,
      needsLogin: t.needsLogin,
      status: t.status === 'needs-verification' && isVerified ? 'ready' : t.status,
      declaredStatus: t.status,
      verified: isVerified,
      canDo: r.ok || (t.status === 'needs-verification' && isVerified && !t.needsLogin),
      reason: r.reason ?? null,
      account: r.account ?? null,
      hint: t.hint,
    };
  });
}

// ───────────────────────────────────────────── accounts cache

/**
 * Reading the login state is **blocking** (synchronous SQLite plus execFileSync calling PowerShell to
 * unwrap DPAPI), and Node is single-threaded -- reading it fresh on every visit to the share page would
 * stall the whole server for seconds and drag every other request down with it (in the traversal that
 * showed up as the report list sitting at "loading" forever).
 *
 * So: read once, cache for a while. But **force a refresh before speaking in public** -- basing a post
 * decision on a stale login state is like opening a new lock with an old key.
 */
const accountsCache = { at: 0, value: null };
export const ACCOUNTS_TTL_MS = 60000;

export async function getAccounts(cfg, { force = false, ttlMs = ACCOUNTS_TTL_MS } = {}) {
  const now = Date.now();
  if (!force && accountsCache.value && now - accountsCache.at < ttlMs) {
    return { accounts: accountsCache.value, cached: true };
  }
  try {
    const r = await listAccounts(cfg);
    accountsCache.value = r.accounts ?? [];
    accountsCache.at = now;
    return { accounts: accountsCache.value, cached: false };
  } catch (e) {
    // When it cannot be read, treat it as "no login state" (rather than letting the whole endpoint 500)
    return { accounts: accountsCache.value ?? [], cached: false, error: e.message };
  }
}

export function clearAccountsCache() {
  accountsCache.at = 0;
  accountsCache.value = null;
}

// ───────────────────────────────────────────── audit

export function auditPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'share.jsonl');
}

/** Every "speaking in public" action has to leave a trace (who, when, where it went, a summary of what was sent) */
export function appendAudit(cfg, entry) {
  const p = auditPath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // A failed audit write must not bring the main flow down, but the failure still has to be reported honestly
    return false;
  }
  return true;
}

export function readAudit(cfg, limit = 50) {
  const p = auditPath(cfg);
  try {
    return fs
      .readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

/**
 * The gate in front of speaking in public.
 *
 * Same discipline as danmaku posting, because a failure or a wrong post is irreversible:
 *   1. an explicit confirm is mandatory
 *   2. the target must exist and be **currently doable** (login state sufficient, and not "unverified")
 *   3. the content must be non-empty and within the length limit
 *   4. leave an audit entry
 * A scheduled run never reaches this code -- the only call sites are HTTP routes.
 */
export function guardPost(cfg, { target, accounts = [], verified = [], text, confirm = false }) {
  const t = targetById(target);
  if (!t) return { ok: false, error: `unknown target: ${target}` };
  if (t.kind !== 'post') return { ok: false, error: `target is not a posting target: ${target}` };
  if (confirm !== true) return { ok: false, error: '需要显式确认（confirm: true）——对外发声不可撤销，绝不自动执行' };
  if (t.status === 'unsupported') return { ok: false, error: '此平台不支持自动发帖（见目标说明）' };
  const isVerified = (verified ?? []).includes(t.id);
  if (t.status === 'needs-verification' && !isVerified) {
    return {
      ok: false,
      error: '这个目标还没被真实账号验证过，暂不允许对外使用（先在设置里确认一次成功发布）',
      status: 'needs-verification',
    };
  }
  const r = checkReadiness(t, accounts);
  if (!r.ok && t.status !== 'needs-verification') return { ok: false, error: r.reason ?? 'login required', status: r.status };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  if (body.length > 2000) return { ok: false, error: '内容过长（上限 2000 字）' };
  return { ok: true, target: t, body };
}

/**
 * Actually post the content to a bilibili dynamic.
 *
 * Same discipline as danmaku: **re-read the cookie on the spot** (no caching), take CSRF from bili_jct,
 * and report the error code bilibili gives back honestly. This function is only ever called after
 * "confirmed + verified + logged in".
 */
export async function postBilibiliDynamic(cfg, { accountId, text, log = null }) {
  const { accounts } = await listAccounts(cfg);
  const acct = accounts.find((a) => a.id === accountId) ?? accounts.find((a) => a.canSend);
  if (!acct) return { ok: false, error: '没有可用的 B 站登录态' };
  if (!acct.canSend) return { ok: false, error: `账号 ${acct.name ?? acct.id} 缺少 SESSDATA 或 bili_jct` };

  const ck = await readBrowserCookies(acct.profile, ['bilibili.com']);
  if (!ck.ok) return { ok: false, error: `读不到登录态：${ck.error}` };
  const csrf = /(?:^|;\s*)bili_jct=([^;]+)/.exec(ck.cookieHeader)?.[1] ?? '';
  if (!csrf) return { ok: false, error: '缺少 bili_jct，无法通过 CSRF 校验' };

  const body = new URLSearchParams({ dynamic: text, csrf, csrf_token: csrf });
  try {
    const res = await netFetch(
      'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: ck.cookieHeader,
          referer: 'https://t.bilibili.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      },
      { cfg, mode: 'direct' }
    );
    const j = await res.json().catch(() => null);
    const code = Number(j?.code ?? -1);
    const ok = res.ok && code === 0;
    const out = { ok, code, account: acct.name ?? acct.id, error: ok ? null : j?.message ?? `HTTP ${res.status}` };
    if (ok) log?.info(`dynamic posted as ${out.account}`);
    else log?.warn(`dynamic post failed: ${out.error}`);
    return out;
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}
