// share.js — 一键分享 / one-click sharing
//
// 「分享」这件事有两类目标，它们对**登录**的要求完全不同，必须分开对待：
//
//   A. 不需要登录的：导出单文件 HTML / Markdown / JSON、复制文本、推到 webhook
//      —— 这是主路径。它永远可用，也不涉及任何账号风险。
//   B. 需要登录的：发到 B 站动态 / X 之类。这类必须**先探测登录态再决定能不能做** ——
//      不能假装能发、更不能在没登录时默默失败。而且**绝不在定时运行里自动发**：
//      对外发声是不可撤销的动作，必须由人明确确认（与弹幕发送同一套纪律）。
//
// 所以本模块的核心不是「怎么发」，而是三件事：
//   1) **生成一个自带样式的单文件**（打开就能看，不依赖任何外部资源，发给朋友不会被拦）
//   2) **如实说明每个目标缺什么**（ready / needs-login / needs-verification / unsupported）
//   3) **能做的才做，且留痕**（确认闸门 + 审计日志）
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { htmlShell } from './reports.js';
import { listAccounts } from './accounts.js';
import { readBrowserCookies } from './cookies.js';
import { netFetch } from './net.js';

/**
 * 分享目标登记表。
 *
 * 每个目标必须如实声明：
 *   needsLogin  —— 是否需要登录态
 *   status      —— ready（现在就可用）/ needs-login（缺登录）/ needs-verification（功能已实现
 *                  但**还没被真实账号验证过**，必须验证后才允许对外使用）/ unsupported（做不到）
 * 宁可写 needs-verification 也不要假装 ready —— 对外发东西失败或发错是不可撤销的。
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

// ───────────────────────────────────────────── 内容打包

/** 从情报条目里收集可分享的内容（就地使用 people / keywords 字段） */
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

/** 纯 markdown 版本（也用于 HTML 与文本的中间形态） */
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
 * 单文件 HTML。
 * 关键要求：**不带任何外部引用**（没有外链 CSS / 字体 / 图片 / 脚本）——
 * 对方在离线、内网、或任何限制环境下都能打开；也不会因为图片防盗链而一片空白。
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
  // 复用报告那套样式壳，保证「同一套观感」；再加两条分享场景需要的规则
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
 * 生成一个分享包。
 *
 * 注意区分两个日期，它们不该混为一谈：
 *   · contentDate —— **内容**属于哪一天（那份日报 / 那个人当时的数据）
 *   · generatedAt —— **什么时候导出**的
 * 文件名与标题用 contentDate（对方拿到手才知道这是什么），没有内容日期时才落到导出日。
 * @param {object} o
 * @param {'latest'|'day'|'person'|'event'|'items'} o.scopeKind
 * @param {object[]} o.items 已经筛好的条目
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

/** 文件名：带上范围与**内容日期**，方便对方一眼知道这是什么 */
export function bundleFilename(bundle, ext) {
  const safe = String(bundle.title).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const day = bundle.contentDate ?? bundle.generatedAt.slice(0, 10);
  return `vml-share-${safe}-${day}.${ext}`;
}

/**
 * 生成 content-disposition 头。
 *
 * ⚠️ HTTP 头**只能是 ASCII** —— 文件名里带中文（分享标题往往是中文）会直接抛
 * `ERR_INVALID_CHAR: Invalid character in header content`，接口 500。
 * 单元测试只验证了「文件名生成得对」，没走 HTTP 层，所以没抓到（巡检的真实请求抓到了）。
 * 正确做法是 RFC 5987/6266：给一个 ASCII 兜底名 + `filename*=UTF-8''<百分号编码>`，
 * 现代浏览器会优先用后者，于是中文名照样能保住。
 */
export function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ───────────────────────────────────────────── 登录需求

/**
 * 一个分享目标现在能不能用。
 * @param {object} target
 * @param {object[]} accounts listAccounts() 的结果
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

/** 所有目标就绪情况一览（界面用它显示「缺什么」） */
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

// ───────────────────────────────────────────── 账号读取的缓存

/**
 * 读取登录态是**阻塞**的（同步 SQLite + execFileSync 调 PowerShell 解 DPAPI），
 * 而 Node 是单线程 —— 每次打开分享页都现读一遍，会把整个服务卡住几秒，
 * 连累其它请求（巡检里表现为报告列表迟迟停在「加载中」）。
 *
 * 所以：读一次缓存一会儿。但**对外发声前必须强制刷新** ——
 * 发帖前拿到过期的登录态判断，等于拿旧钥匙开新锁。
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
    // 读不到就当没有登录态（而不是让整个接口 500）
    return { accounts: accountsCache.value ?? [], cached: false, error: e.message };
  }
}

export function clearAccountsCache() {
  accountsCache.at = 0;
  accountsCache.value = null;
}

// ───────────────────────────────────────────── 审计

export function auditPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'share.jsonl');
}

/** 任何「对外发声」的动作都要留痕（谁、什么时候、发到哪、发了什么摘要） */
export function appendAudit(cfg, entry) {
  const p = auditPath(cfg);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // 审计写不进去也不能让主流程崩，但要如实返回失败
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
 * 对外发声的闸门。
 *
 * 与弹幕发送同一套纪律，因为失败/发错都不可撤销：
 *   ① 必须显式 confirm
 *   ② 目标必须存在且**当前可做**（登录态够、且不是「未验证」）
 *   ③ 内容非空且长度受限
 *   ④ 留审计
 * 定时任务永远不会走到这里 —— 调用点只在 HTTP 路由上。
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
 * 真的把内容发到 B 站动态。
 *
 * 纪律与弹幕一致：**现场重新读 cookie**（不缓存）、CSRF 从 bili_jct 取、
 * 失败如实回传 B 站给的错误码。这个函数只在「已确认 + 已验证 + 已登录」之后才会被调用。
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
    if (ok) log?.info(`动态已发布 / dynamic posted as ${out.account}`);
    else log?.warn(`动态发布失败 / dynamic post failed: ${out.error}`);
    return out;
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}
