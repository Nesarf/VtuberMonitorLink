// share.js — one-click sharing
//
// "Sharing" covers two classes of target, and they differ completely in their **login** requirements,
// so they have to be treated separately:
//
//   A. No login needed: export a single-file HTML / Markdown / JSON, copy as text, push to a webhook
//      -- this is the main path. It is always available and carries no account risk whatsoever.
//   B. Login needed: post to a bilibili dynamic / X and the like. These must **probe the login state first
//      and only then decide whether they can run** -- we must not pretend we can post, and still less fail
//      silently while logged out. And they are **never sent automatically by a scheduled run**: speaking in
//      public is an irreversible act that requires explicit human confirmation (the same discipline as danmaku posting).
//
// Why a posting target is described as **three independent stages** rather than one status:
// "can I post to this site" is really three different questions, and they are answered by three different
// things, so collapsing them into one badge hides exactly the step that is missing:
//
//   account      which account/credential this site would use, and whether it exists and is usable
//   verification whether what the site needs *before posting* is satisfied -- for bilibili that is
//                "SESSDATA + bili_jct are valid and the account may post dynamics"
//   send         actually posting, which is only meaningful once the first two are settled
//
// The account stage is read from the local login store (measured, see getAccounts); the verification stage is
// an **app-level state that is only measured against the site on demand** (measureVerification below) -- the user
// explicitly chose that shape over a mandatory live check and over a purely local config check, because a login
// probe costs a request and must not run every time the page is opened, while a local-only check would just be
// a guess dressed up as a measurement.
//
// So the core of this module is not "how to post" but four things:
//   1) **Generate a single file that carries its own styling** (open it and it just works, no external
//      assets, and it will not get blocked when sent to a friend)
//   2) **State honestly what each stage of each target is missing** (account / verification / send)
//   3) **Detect what a site needs before sharing** (the per-site profile declares it, a measurement pass
//      checks it -- including sites the user adds by hand)
//   4) **Do only what can be done, and leave a trace** (confirmation gate + audit log)
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { htmlShell } from './reports.js';
import { listAccounts, whoAmI as defaultWhoAmI } from './accounts.js';
import { readBrowserCookies } from './cookies.js';
import { netFetch } from './net.js';

// ───────────────────────────────────────────── per-site publishing profile
//
// "What a site needs before sharing" is **declared** here and **measured** in measureVerification().
// Declaring it is not the same as checking it, and the two are deliberately kept apart: a site that is
// declared but has never been measured reports "not measured" rather than "fine". That is the difference
// between the "detect it for me" behaviour this feature is asked for and a guess dressed up as a measurement.
//
// Fields of one profile:
//   loginKind        which local login store this site reads (an account modal); null = no login at all
//   credential       what the credential actually is, in the site's own words (bilingual: this is product data)
//   requirements[]   the conditions that must hold before posting; each carries a bilingual label and an id
//                    that a measurement pass can return as unsatisfied
//   verify           the measurement implemented for this site right now:
//                      'login-probe'  read the credential and ask the site who it is  (bilibili)
//                      'token-scope'  check a stored token carries the scope posting needs (mastodon)
//                      'http-probe'   an authenticated request against the site's API
//                      null           nothing implemented; verification honestly reports "no probe yet"
//   publish          how publishing itself is implemented
//   implemented      whether the code path that publishes exists today
//   textLimit        how many characters the site accepts (bilibili dynamics: 2000)
//   maxImages        how many images one post may carry
//   manual           how to hand the work over to a person when this app cannot post there:
//                      compose -- the site's own compose page, with `{text}` where the text goes
//                      needs   -- one bilingual line naming what the person has to bring (account, limits)
//                      images  -- whether the site takes images at all (false for a text-only feed)
//                    A site with no publish code is not a dead end: the hand-off prepares the text and the
//                    attachment and links to the compose page, and records the click as a **manual** action.
//   note             bilingual explanatory copy shown under the site
export const SHARE_SITES = [
  {
    id: 'bilibili-dynamic',
    order: 10,
    name: { zh: '发到 B 站动态', en: 'Post to a bilibili dynamic' },
    loginKind: 'bilibili',
    credential: {
      zh: '浏览器登录态里的 SESSDATA + bili_jct',
      en: 'SESSDATA + bili_jct from the browser login',
    },
    requirements: ['login', 'session', 'csrf', 'write-permission'],
    verify: 'login-probe',
    publish: 'rest-csrf',
    implemented: true,
    unsupported: false,
    textLimit: 2000,
    maxImages: 9,
    manual: {
      compose: 'https://t.bilibili.com/?tab=dyn',
      // The dynamic composer takes no text from the query string, so the hand-off copies and opens the page.
      needs: { zh: 'B 站账号，登录后手动粘贴正文并选图', en: 'a bilibili account; paste the body and pick the images by hand' },
      images: true,
    },
    hint: {
      zh: '需要 B 站的 SESSDATA + bili_jct（就是从浏览器登录态里读的那套）。**功能已实现但尚未用真实账号验证过** —— 第一次成功发出后它才会被标为可用。绝不能自动发：必须你点确认。',
      en: 'Needs bilibili SESSDATA + bili_jct (read from your browser login). The code path exists but has NOT been verified with a real account yet; it becomes available only after one successful post. Never automatic — always requires your confirmation.',
    },
  },
  {
    id: 'x-post',
    order: 20,
    name: { zh: '发到 X / Twitter', en: 'Post to X / Twitter' },
    loginKind: 'twitter',
    credential: { zh: 'OAuth 2.0 授权（需要开发者应用）', en: 'OAuth 2.0 authorisation (needs a developer app)' },
    requirements: ['login', 'token', 'scope'],
    verify: null,
    publish: 'oauth2-api',
    implemented: false,
    // "there is no code yet" and "this must never be done" are different answers, and the send stage has to
    // keep them apart: the first is work in progress, the second will not change. X is the second one.
    unsupported: true,
    textLimit: 280,
    maxImages: 4,
    manual: {
      // The intent endpoint is the one path X offers for a pre-filled post, and it works while logged out too.
      compose: 'https://twitter.com/intent/tweet?text={text}',
      needs: { zh: 'X 账号（网页上登录即可），正文 280 字符以内', en: 'an X account (logged in on the web); the body within 280 characters' },
      images: true,
    },
    hint: {
      zh: '不提供：X 的发帖接口要 OAuth 2.0 授权与开发者应用，用浏览器 cookie 硬凑既不可靠也违反其条款。需要的话请用官方 API 自行对接。',
      en: 'Not offered: posting to X requires OAuth 2.0 with a developer app; scraping cookies would be unreliable and against their terms. Use their official API if you need it.',
    },
  },
  {
    id: 'weibo-post',
    order: 30,
    name: { zh: '发到微博', en: 'Post to Weibo' },
    loginKind: 'weibo',
    credential: { zh: '登录 cookie（SUB）+ 表单里的 XSRF token', en: 'login cookies (SUB) + the XSRF token on the form' },
    requirements: ['login', 'session', 'csrf'],
    verify: null,
    publish: 'form-post',
    implemented: false,
    unsupported: false,
    textLimit: 2000,
    maxImages: 9,
    manual: {
      compose: 'https://weibo.com/',
      needs: { zh: '微博账号（网页上登录），正文 2000 字以内', en: 'a Weibo account (logged in on the web); the body within 2000 characters' },
      images: true,
    },
    hint: {
      zh: '还没接线：微博的发布接口要 SUB 登录 cookie 加一个 XSRF token，代码没写，所以这里只登记「需要什么」，不会假装能发。',
      en: 'Not wired up yet: posting needs the SUB login cookie plus an XSRF token, and the code does not exist, so this only declares what it would need instead of pretending to work.',
    },
  },
  {
    id: 'youtube-community',
    order: 40,
    name: { zh: '发到 YouTube 社区', en: 'Post to a YouTube community tab' },
    loginKind: 'youtube',
    credential: { zh: 'OAuth 2.0（youtube.force-ssl 权限）', en: 'OAuth 2.0 with the youtube.force-ssl scope' },
    requirements: ['login', 'token', 'scope'],
    verify: null,
    publish: 'oauth2-api',
    implemented: false,
    unsupported: false,
    textLimit: 5000,
    maxImages: 1,
    manual: {
      compose: 'https://studio.youtube.com/',
      needs: { zh: 'YouTube 频道账号（能在社区页发帖的那个），正文 5000 字以内', en: 'the YouTube channel account (the one allowed to post on the community tab); the body within 5000 characters' },
      images: true,
    },
    hint: {
      zh: '还没接线：YouTube 的社区帖子只能走官方 Data API v3 的 OAuth（youtube.force-ssl），浏览器 cookie 不适用。',
      en: 'Not wired up yet: a community post can only go through the official Data API v3 with OAuth (youtube.force-ssl); browser cookies do not apply.',
    },
  },
  {
    id: 'mastodon-post',
    order: 50,
    name: { zh: '发到 Mastodon', en: 'Post to Mastodon' },
    loginKind: 'mastodon',
    credential: { zh: '实例上的一张访问令牌（write:statuses）', en: 'an access token from your instance (write:statuses)' },
    requirements: ['login', 'token', 'scope'],
    verify: 'token-scope',
    publish: 'rest-bearer',
    implemented: false,
    unsupported: false,
    textLimit: 500,
    maxImages: 4,
    manual: {
      // The instance is the user's own, so the hand-off can only say "your instance"; the compose path is
      // the same on every Mastodon instance.
      compose: 'https://{instance}/publish?text={text}',
      needs: { zh: '你所在实例的账号，正文 500 字以内（每个实例的字数上限可能不同）', en: 'an account on your own instance; the body within 500 characters (instances differ)' },
      images: true,
    },
    hint: {
      zh: '还没接线：Mastodon 要你自己实例上的访问令牌，令牌带没带 write:statuses 权限是可以本地量出来的（不联外网）。',
      en: 'Not wired up yet: Mastodon needs an access token from your own instance, and whether that token carries write:statuses is measurable locally (no network call).',
    },
  },
  {
    id: 'reddit-post',
    order: 60,
    name: { zh: '发到 Reddit', en: 'Post to Reddit' },
    loginKind: 'reddit',
    credential: { zh: 'OAuth 访问令牌（submit 权限）+ User-Agent', en: 'an OAuth access token (submit scope) + a User-Agent' },
    requirements: ['login', 'token', 'scope'],
    verify: null,
    publish: 'oauth2-api',
    implemented: false,
    unsupported: false,
    textLimit: 40000,
    maxImages: 20,
    manual: {
      compose: 'https://www.reddit.com/submit?title={title}&text={text}',
      needs: { zh: 'Reddit 账号，并选择要发到哪个版块；正文 40000 字以内', en: 'a Reddit account and the subreddit to post in; the body within 40000 characters' },
      images: true,
    },
    hint: {
      zh: '还没接线：Reddit 的发帖接口要 OAuth 令牌、submit 权限和一个如实说明的 User-Agent，没有这些它一律拒绝。',
      en: 'Not wired up yet: the Reddit submit endpoint wants an OAuth token, the submit scope and an honest User-Agent; without them it refuses outright.',
    },
  },
];

/**
 * The share-target registry.
 *
 * Every target must declare honestly:
 *   needsLogin  -- whether a login state is required
 *   status      -- the target's **declared** status, used as the ceiling for its send stage:
 *                  ready (usable right now) / needs-login (login missing) / needs-verification (the feature
 *                  exists but **has never been verified with a real account**, and may only be used
 *                  externally once it has been) / unimplemented (the code path does not exist yet) /
 *                  unsupported (cannot be done at all, for example when the platform forbids the method)
 * Better to declare needs-verification than to pretend to be ready -- a failed or wrong public post is irreversible.
 * A target may carry a `site` reference into the profile table above; local-file targets have none.
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
  // The six posting sites, in the order the work is done (bilibili first, a source for it already exists).
  // They are generated from SHARE_SITES so the declarations cannot drift away from the profile table.
  ...SHARE_SITES.map((site) => ({
    id: site.id,
    name: site.name,
    needsLogin: true,
    loginKind: site.loginKind,
    status: site.unsupported === true ? 'unsupported' : site.implemented ? 'needs-verification' : 'unimplemented',
    kind: 'post',
    site: site.id,
    hint: site.hint,
  })),
];

/**
 * Build the target list for one config.
 *
 * `cfg.share.sites` is the "add your own site" path: a hand-declared profile in the very same shape as
 * SHARE_SITES (id / name / loginKind / credential / requirements / implemented ...). A custom site is
 * never assumed to work -- with `implemented` absent it reports "no publish code", and its verification
 * state comes from measurement like any built-in site. Nothing here sends anything.
 * @param {object} cfg
 * @returns {object[]} targets (built-ins first, then the custom ones)
 */
export function shareTargets(cfg = {}) {
  const custom = (Array.isArray(cfg?.share?.sites) ? cfg.share.sites : [])
    .filter((s) => s && typeof s.id === 'string' && s.id.trim() && !SHARE_TARGETS.some((t) => t.id === s.id))
    .map((s) => {
      const site = normalizeSite(s);
      return {
        id: site.id,
        name: site.name,
        needsLogin: !!site.loginKind,
        loginKind: site.loginKind,
        status: site.unsupported ? 'unsupported' : site.implemented ? 'needs-verification' : 'unimplemented',
        kind: 'post',
        site: site.id,
        custom: true,
        hint: site.hint,
      };
    });
  return [...SHARE_TARGETS, ...custom];
}

/** Fill in the parts of a (possibly hand-written) site profile that the rest of the module assumes */
function normalizeSite(raw) {
  return {
    id: String(raw.id),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 999,
    name: raw.name ?? { zh: String(raw.id), en: String(raw.id) },
    loginKind: raw.loginKind ?? null,
    credential: raw.credential ?? null,
    requirements: Array.isArray(raw.requirements) ? raw.requirements : ['login'],
    verify: raw.verify ?? null,
    publish: raw.publish ?? null,
    implemented: raw.implemented === true,
    unsupported: raw.unsupported === true,
    textLimit: Number.isFinite(Number(raw.textLimit)) ? Number(raw.textLimit) : 2000,
    maxImages: Number.isFinite(Number(raw.maxImages)) ? Number(raw.maxImages) : 4,
    manual: raw.manual ?? null,
    hint: raw.hint ?? { zh: '', en: '' },
    custom: raw.custom === true,
  };
}

/** One target by id, custom sites from the config included */
export function targetById(id, cfg = null) {
  return shareTargets(cfg ?? {}).find((t) => t.id === id) ?? null;
}

/** One site profile by target id (null for the local-file targets, which have no publishing profile) */
export function siteProfileById(id, cfg = null) {
  const t = shareTargets(cfg ?? {}).find((x) => x.id === id);
  if (!t || t.kind !== 'post') return null;
  const builtin = SHARE_SITES.find((s) => s.id === id);
  if (builtin) return normalizeSite({ ...builtin, custom: false });
  const raw = (cfg?.share?.sites ?? []).find((s) => s?.id === id);
  return raw ? normalizeSite({ ...raw, custom: true }) : null;
}

/** The image limits of the currently selected image attachment setting */
export function shareImageSetting(cfg = {}) {
  const raw = cfg?.share?.images ?? {};
  const mode = ['none', 'source', 'inline'].includes(raw.mode) ? raw.mode : 'none';
  const max = raw.maxPerBundle;
  return {
    mode,
    maxPerBundle: Number.isFinite(Number(max)) ? Math.max(0, Math.min(60, Number(max))) : DEFAULT_IMAGES.maxPerBundle,
    maxPerPost: Number.isFinite(Number(raw.maxPerPost)) ? Math.max(0, Math.min(60, Number(raw.maxPerPost))) : DEFAULT_IMAGES.maxPerPost,
    inlineMaxBytes: Number.isFinite(Number(raw.inlineMaxBytes)) ? Number(raw.inlineMaxBytes) : DEFAULT_IMAGES.inlineMaxBytes,
  };
}

export const DEFAULT_IMAGES = {
  // 0 = do not attach images at all; this is the default because a bundle with remote images can go blank
  // in front of the recipient (hotlink protection), which is the one failure a share view must not have
  mode: 'none',
  // How many images one bundle may carry in total
  maxPerBundle: 4,
  // How many images one public post may carry (a chat message should stay small)
  maxPerPost: 1,
  // Cap on one inlined image; above it the image is left out and counted
  inlineMaxBytes: 200 * 1024,
};

/**
 * The three attachment modes, with their wording, declared here rather than in the web layer.
 *
 * Why the product copy lives on this side: what each mode means is a property of what the module does with
 * the file ("inline is the only shape a single-file page may reference"), so the page would otherwise have to
 * restate it and could drift. The web view renders these labels as data, the same way it renders each site's
 * name and credential.
 */
export const IMAGE_MODES = [
  {
    id: 'none',
    label: { zh: '不附图', en: 'no images' },
  },
  {
    id: 'source',
    label: { zh: '保留图片地址', en: 'keep image URLs' },
  },
  {
    id: 'inline',
    label: { zh: '内嵌图片（data:）', en: 'inline images (data:)' },
  },
];

/** The label of the numeric field next to the mode (same reasoning as IMAGE_MODES) */
export const IMAGE_COUNT_LABEL = { zh: '每个文件最多几张', en: 'at most this many per file' };

// ───────────────────────────────────────────── the three stages

/**
 * The `login` requirement is satisfied by the credential existing at all (an account modal); every other
 * requirement is a named condition on that credential. Keeping them as small predicates means a site can
 * declare `requirements: ['login', 'token', 'scope']` and get an honest measurement for free.
 */
const REQUIREMENTS = {
  login: { label: { zh: '要有一个账号', en: 'an account exists' }, test: (a) => !!a },
  session: { label: { zh: '会话 cookie（SESSDATA / SUB）', en: 'the session cookie (SESSDATA / SUB)' }, test: (a) => a?.hasSession === true },
  csrf: { label: { zh: 'CSRF token（bili_jct / XSRF）', en: 'the CSRF token (bili_jct / XSRF)' }, test: (a) => a?.hasCsrf === true },
  token: { label: { zh: '访问令牌', en: 'an access token' }, test: (a) => a?.hasToken === true },
  scope: { label: { zh: '发帖权限（scope）', en: 'the posting scope' }, test: (a) => a?.hasScope === true },
  'write-permission': {
    label: { zh: '账号可以发帖（由站点自己确认）', en: 'the account may post (confirmed by the site itself)' },
    test: (a) => a?.canSend === true,
  },
};

/**
 * The states a stage can be in. They are listed here because the UI only knows the dictionary entries
 * above: any state that has no entry yet is one of the strings named in the report rather than a silent
 * fallback to a wrong label.
 *   account      satisfied | missing | unknown | not-required
 *   verification done | needed | blocked | not-required | unknown
 *   send         ready | blocked | unimplemented | unknown
 */

/** English fallback for any stage status, so a rendering path always has something to show */
const STATUS_DEFAULT = {
  satisfied: { zh: '已满足', en: 'satisfied' },
  missing: { zh: '缺东西', en: 'missing' },
  unknown: { zh: '还没测', en: 'not measured' },
  'not-required': { zh: '不需要', en: 'not required' },
  done: { zh: '已验证', en: 'verified' },
  needed: { zh: '待验证', en: 'verification needed' },
  blocked: { zh: '做不到', en: 'blocked' },
  ready: { zh: '可发送', en: 'ready to send' },
  unimplemented: { zh: '还没实现', en: 'not implemented yet' },
};

/** The bilingual label of one stage status (site data, like every other name/hint in this module) */
export function stageStatusLabel(stage, status) {
  const i18nKey = STAGE_I18N[stage]?.[status] ?? null;
  return { key: i18nKey, label: STATUS_DEFAULT[status] ?? { zh: String(status), en: String(status) } };
}

/**
 * Which existing UI entry expresses each state. The web view keeps showing dictionary strings -- this
 * module must not invent English copy for a UI that ships in 26 locales -- and anything for which no
 * entry exists yet is listed in the report instead of being forced onto a wrong one.
 */
export const STAGE_I18N = {
  account: {
    satisfied: 'shareReady',
    missing: 'shareNeedsLogin',
    unknown: 'shareNeedsLogin',
    'not-required': 'yes',
  },
  verification: {
    done: 'shareReady',
    needed: 'shareNeedsVerify',
    blocked: 'shareUnsupported',
    'not-required': 'yes',
    unknown: 'shareNeedsVerify',
  },
  send: {
    ready: 'shareReady',
    blocked: 'shareUnsupported',
    unimplemented: 'shareUnsupportedShort',
    unknown: 'shareCannotWithoutLogin',
  },
};

/** How long a stored verification result stays usable before the UI asks for a re-check */
export const VERIFY_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Read the verification store out of the config.
 *
 * Shape: `{ [targetId]: { [accountId]: { at, ok, unsatisfied, measured, account } } }`.
 * The older shape was a plain list of target ids (`['bilibili-dynamic']`), which answered the wrong
 * question: it says "this code path once worked", not "this account can post". The credential decides
 * whether a post succeeds, so the account is part of the key and a legacy list is read as "verified with
 * an unknown account" rather than dropped (dropping it would silently re-block a working setup).
 */
export function verificationStore(cfg = {}) {
  const raw = cfg?.share?.verifiedTargets;
  const out = {};
  if (Array.isArray(raw)) {
    for (const id of raw) if (typeof id === 'string') out[id] = { '*': { at: null, ok: true, legacy: true } };
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, perAccount] of Object.entries(raw)) {
    if (!perAccount || typeof perAccount !== 'object') continue;
    out[id] = { ...perAccount };
  }
  return out;
}

/** The stored verification of one target for one account (null when there is none) */
export function verificationFor(store, targetId, accountId) {
  const per = store?.[targetId];
  if (!per) return null;
  if (accountId && per[accountId]) return per[accountId];
  return per['*'] ?? null;
}

/** Write one verification result into the store (a pure object operation; the caller persists the config) */
export function recordVerification(store, targetId, accountId, result) {
  const next = { ...(store ?? {}) };
  next[targetId] = { ...(next[targetId] ?? {}), [accountId || '*']: result };
  return next;
}

/** A stored result older than VERIFY_TTL_MS is still shown, but marked stale: posting rules change, so an old pass is weak evidence */
export function verificationFreshness(entry, nowMs = Date.now()) {
  if (!entry) return { verifiedAt: null, ageMs: null, stale: false };
  const at = entry.at ? Date.parse(entry.at) : NaN;
  if (!Number.isFinite(at)) return { verifiedAt: entry.at ?? null, ageMs: null, stale: entry.legacy === true };
  const age = nowMs - at;
  return { verifiedAt: entry.at, ageMs: age, stale: age > VERIFY_TTL_MS };
}

/** Accounts of the login kind this site reads (empty when the site needs no login) */
function accountsFor(profile, accounts = []) {
  if (!profile?.loginKind) return [];
  return (accounts ?? []).filter((a) => a && a.kind === profile.loginKind);
}

/** The first account whose credential satisfies every declared requirement (this is "which account would be used") */
function pickAccount(profile, accounts = []) {
  const list = accountsFor(profile, accounts);
  return list.find((a) => requirementsMet(profile, a).met) ?? list[0] ?? null;
}

/**
 * Which account a target should use.
 *
 * The choice is explicit and persisted (`cfg.share.accounts[targetId]`), because a machine can hold more than
 * one login for the same site and picking by array order would silently post under whichever profile happened
 * to be scanned first. When the chosen account is not among the candidates any more (the profile was removed,
 * or the cookie store changed), this falls back to the automatic pick rather than reporting nothing.
 */
export function pickAccountId(targetId, accounts = [], cfg = {}) {
  const configured = cfg?.share?.accounts?.[targetId];
  if (!configured) return null;
  const profile = siteProfileById(targetId, cfg);
  const found = accountsFor(profile, accounts).find((a) => a.id === configured);
  return found ? found.id : null;
}

/** Which of a site's declared requirements one account satisfies, and which are still missing */
export function requirementsMet(profile, account) {
  const reqs = (profile?.requirements ?? ['login']).filter((r) => REQUIREMENTS[r]);
  const checks = reqs.map((id) => ({ id, label: REQUIREMENTS[id].label, ok: REQUIREMENTS[id].test(account) }));
  const unsatisfied = checks.filter((c) => !c.ok).map((c) => ({ id: c.id, label: c.label }));
  return { met: checks.length > 0 && unsatisfied.length === 0, checks, unsatisfied };
}

/**
 * The account stage: which account/credential this site would use, and whether it is usable.
 * Reads the **local login store** only -- no network -- so it is cheap enough to report for every site.
 */
function accountStage(target, profile, accounts, accountId, { requirementRows = false } = {}) {
  const withRows = (stage) => {
    if (!requirementRows || !profile) return stage;
    const chosen = stage.accountId ? accountsFor(profile, accounts).find((a) => a.id === stage.accountId) ?? null : null;
    const m = chosen ? requirementsMet(profile, chosen) : null;
    return {
      ...stage,
      // The checklist a person wants when the stage is not satisfied: which of the declared requirements can
      // be looked for on this machine, and which of them the chosen account already satisfies. Built here
      // because the requirement table is here -- a page that restated it would drift from what is measured.
      requirementRows: (profile.requirements ?? []).map((rid) => {
        const known = !!REQUIREMENTS[rid];
        const check = m?.checks.find((c) => c.id === rid) ?? null;
        return {
          id: rid,
          label: REQUIREMENTS[rid]?.label ?? { zh: rid, en: rid },
          checkable: known,
          satisfied: check ? check.ok : null,
        };
      }),
      probe: profile.verify,
      canTest: !!profile.verify && !!stage.accountId,
    };
  };
  if (target.kind !== 'post') {
    return withRows({
      id: 'account',
      i18nKey: STAGE_I18N.account['not-required'],
      status: 'not-required',
      detail: { zh: '这类方式不需要登录', en: 'this kind of method needs no login' },
      accountId: null,
      accountName: null,
      // The account stage is never something the page lets you run: it reports what is there. It still says so
      // explicitly, so every stage object has the same fields.
      actionable: false,
    });
  }
  const list = accountsFor(profile, accounts);
  const chosen = accountId ? list.find((a) => a.id === accountId) ?? null : pickAccount(profile, accounts);
  const label = siteCredentialLabel(profile);
  if (!chosen) {
    return withRows({
      id: 'account',
      i18nKey: STAGE_I18N.account.missing,
      status: 'missing',
      detail: { zh: `本机没有 ${loginKindLabel(profile?.loginKind)} 的登录态；需要 ${label.zh}`, en: `no ${loginKindLabel(profile?.loginKind)} login found on this machine; needs ${label.en}` },
      credential: label,
      accountId: null,
      accountName: null,
      actionable: false,
      unsatisfied: (profile?.requirements ?? []).map((id) => ({ id, label: REQUIREMENTS[id]?.label ?? { zh: id, en: id } })),
    });
  }
  const m = requirementsMet(profile, chosen);
  const name = chosen.name ?? chosen.uname ?? chosen.mid ?? chosen.id ?? null;
  return withRows({
    id: 'account',
    i18nKey: STAGE_I18N.account[m.met ? 'satisfied' : 'missing'],
    status: m.met ? 'satisfied' : 'missing',
    detail: m.met
      ? { zh: `用 ${name ?? chosen.id} 的登录态`, en: `uses the login of ${name ?? chosen.id}` }
      : {
          zh: `${name ?? chosen.id} 还缺：${m.unsatisfied.map((u) => u.label.zh).join('、')}`,
          en: `${name ?? chosen.id} is still missing: ${m.unsatisfied.map((u) => u.label.en).join(', ')}`,
        },
    credential: label,
    accountId: chosen.id ?? null,
    accountName: name,
    actionable: false,
    requirements: m.checks,
    unsatisfied: m.unsatisfied,
  });
}

/**
 * The verification stage: whether what the site needs **before posting** is satisfied.
 *
 * Two kinds of evidence count, and they are kept apart on purpose:
 *   measured -- measureVerification() ran against the site (or against the credential) and said so, for
 *               this exact account, and the result is not stale
 *   declared -- the target is "ready" in its own declaration; that only means "nothing is known to be
 *               missing", which is why a target that has never been measured still shows needs-verification
 * The stage is never claimed as done on the strength of an unrelated account: the stored result is looked
 * up by (target, account) and a mismatch degrades to "needed".
 */
function verificationStage(target, profile, accounts, store, { accountId = null, nowMs = Date.now() } = {}) {
  if (target.kind !== 'post') {
    return {
      id: 'verification',
      i18nKey: STAGE_I18N.verification['not-required'],
      status: 'not-required',
      detail: { zh: '导出文件不需要验证', en: 'exporting a file needs no verification' },
      accountId: null,
      // Always present, always a boolean: "no verification step exists here" and "there is one but it cannot
      // be run" are different states, and a rendering path must not have to read a missing field as false.
      actionable: false,
    };
  }
  if (target.status === 'unsupported') {
    return {
      id: 'verification',
      i18nKey: STAGE_I18N.verification.blocked,
      status: 'blocked',
      detail: {
        zh: '平台本身不允许这种方式（见站点说明）',
        en: 'the platform does not allow this method (see the site note)',
      },
      accountId: null,
      probe: null,
      // Every stage object carries the same fields, so a rendering path never has to guess: an absent
      // "actionable" is not the same answer as false, and the test that reads this API says so.
      actionable: false,
    };
  }
  const chosen = accountId ? accountsFor(profile, accounts).find((a) => a.id === accountId) ?? null : pickAccount(profile, accounts);
  const entry = chosen ? verificationFor(store, target.id, chosen.id) : null;
  const fresh = verificationFreshness(entry, nowMs);
  if (entry?.ok === true && !fresh.stale) {
    return {
      id: 'verification',
      i18nKey: STAGE_I18N.verification.done,
      status: 'done',
      detail: {
        zh: `已测量：${entry.detail?.zh ?? entry.method ?? '通过'}`,
        en: `measured: ${entry.detail?.en ?? entry.method ?? 'passed'}`,
      },
      accountId: chosen?.id ?? null,
      verifiedAt: fresh.verifiedAt,
      method: entry.method ?? null,
    };
  }
  // No probe implemented is **blocked**, not "needed": nothing the user can do here would move it, and
  // showing an actionable "verify" button that cannot run is exactly the fake button this module refuses.
  const noProbe = !profile?.verify;
  const why = noProbe
    ? { zh: '这个站点还没有能跑的检测（只有声明，没有测量）', en: 'no probe exists for this site yet (declared, never measured)' }
    : !chosen
      ? { zh: '先有账号才能验证', en: 'an account is needed before anything can be verified' }
      : entry?.ok === false
        ? { zh: `上次测量的结果是不通过：${entry.detail?.zh ?? entry.reason ?? ''}`, en: `the last measurement failed: ${entry.detail?.en ?? entry.reason ?? ''}` }
        : fresh.stale && entry?.ok === true
          ? { zh: '上次的验证结果已经过期，需要重新测一次', en: 'the last verification is stale; measure again' }
          : { zh: '还没测过', en: 'not measured yet' };
  return {
    id: 'verification',
    i18nKey: STAGE_I18N.verification[noProbe ? 'blocked' : 'needed'],
    status: noProbe ? 'blocked' : 'needed',
    detail: why,
    accountId: chosen?.id ?? null,
    probe: profile?.verify ?? null,
    verifiedAt: fresh.verifiedAt,
    lastOk: entry?.ok ?? null,
    actionable: !noProbe && !!chosen,
  };
}

/** The send stage: only meaningful once the account and the verification stages are settled */
function sendStage(target, profile, account, verification) {
  if (target.kind !== 'post') {
    return {
      id: 'send',
      i18nKey: STAGE_I18N.send.ready,
      status: 'ready',
      detail: { zh: '这一步就是生成/复制，随时可做', en: 'this step is generating or copying; always available' },
      implemented: true,
      actionable: true,
    };
  }
  // "no code yet" and "the platform forbids it" are different answers and must not be merged: the first is
  // work in progress, the second will never happen, and a user reads them differently. unsupported is checked
  // first, because a site can be both (X: cookies would work mechanically, but using them is not allowed).
  if (target.status === 'unsupported') {
    return {
      id: 'send',
      i18nKey: STAGE_I18N.send.blocked,
      status: 'blocked',
      detail: { zh: '平台不允许，永远做不到', en: 'the platform does not allow it; this cannot be done' },
      implemented: false,
      actionable: false,
    };
  }
  if (!profile?.implemented) {
    return {
      id: 'send',
      i18nKey: STAGE_I18N.send.unimplemented,
      status: 'unimplemented',
      detail: {
        zh: '还没实现：发送代码不存在，只有「需要什么」的声明',
        en: 'not implemented: there is no publishing code, only a declaration of what it needs',
      },
      implemented: false,
      actionable: false,
    };
  }
  const ready = account.status === 'satisfied' && verification.status === 'done';
  return {
    id: 'send',
    i18nKey: STAGE_I18N.send[ready ? 'ready' : 'unknown'],
    status: ready ? 'ready' : 'blocked',
    detail: ready
      ? { zh: '账号与验证都齐了，等你确认', en: 'account and verification are settled; waiting for your confirmation' }
      : {
          zh: `先解决前面两步（账号：${account.status === 'satisfied' ? 'ok' : '缺'}；验证：${verification.status === 'done' ? 'ok' : '缺'}）`,
          en: `settle the first two steps first (account: ${account.status === 'satisfied' ? 'ok' : 'missing'}; verification: ${verification.status === 'done' ? 'ok' : 'missing'})`,
        },
    implemented: true,
    actionable: ready,
  };
}

/**
 * The three stages of one target.
 * @param {object} target
 * @param {object[]} accounts the result of listAccounts()
 * @param {object} store the verification store (see verificationStore)
 * @param {object} [opts] { accountId, nowMs }
 */
export function stageReport(target, accounts = [], store = {}, opts = {}) {
  const cfg = opts.cfg ?? {};
  const profile = siteProfileById(target.id, cfg);
  // The account is chosen in one place: an explicit `opts.accountId` (the UI's chooser) wins, then the stored
  // choice for this target, then the automatic pick.
  const accountId = opts.accountId ?? pickAccountId(target.id, accounts, cfg);
  const account = accountStage(target, profile, accounts, accountId, opts);
  const verification = verificationStage(target, profile, accounts, store, { ...opts, accountId });
  const send = sendStage(target, profile, account, verification);
  return { account, verification, send, profile };
}

/** Every target with its three stages (the shape the share page lists) */
export function stagesReport(accounts = [], store = {}, cfg = {}, opts = {}) {
  return shareTargets(cfg).map((t) => {
    const st = stageReport(t, accounts, store, { cfg });
    return {
      id: t.id,
      name: t.name,
      hint: t.hint,
      kind: t.kind,
      needsLogin: t.needsLogin,
      loginKind: t.loginKind ?? null,
      declaredStatus: t.status,
      custom: t.custom === true,
      site: st.profile
        ? {
            id: st.profile.id,
            credential: st.profile.credential,
            requirements: st.profile.requirements,
            verify: st.profile.verify,
            publish: st.profile.publish,
            implemented: st.profile.implemented,
            unsupported: st.profile.unsupported,
            textLimit: st.profile.textLimit,
            maxImages: st.profile.maxImages,
            // The manual hand-off travels with the profile, so a hand-added site can declare its own path and
            // the page needs no per-site knowledge of its own.
            manual: st.profile.manual,
          }
        : null,
      stages: { account: st.account, verification: st.verification, send: st.send },
    };
  });
}

/**
 * The accounts to offer for one target.
 *
 * A chooser needs the accounts that could be used *and* which requirements each of them already satisfies,
 * because "these two accounts are both bilibili logins, but only one of them carries a CSRF token" is the
 * exact question the account stage exists to answer. It is per target because the requirements are.
 */
export function accountsForTarget(targetId, accounts = [], cfg = {}) {
  const target = targetById(targetId, cfg);
  if (!target || target.kind !== 'post') return [];
  const profile = siteProfileById(targetId, cfg);
  return accountsFor(profile, accounts).map((a) => {
    const m = requirementsMet(profile, a);
    return {
      id: a.id ?? null,
      name: a.name ?? a.uname ?? a.mid ?? a.id ?? null,
      kind: a.kind ?? null,
      browser: a.browser ?? null,
      usable: m.met,
      unsatisfied: m.unsatisfied,
      requirements: m.checks,
    };
  });
}

/** The verification results stored by target (the shape the settings route persists) */
export function verifiedByTarget(store) {
  const data = verificationStore({ share: { verifiedTargets: store } });
  const out = {};
  for (const [target, perAccount] of Object.entries(data)) {
    out[target] = {};
    for (const [accountId, entry] of Object.entries(perAccount)) {
      out[target][accountId] = { at: entry.at ?? null, ok: entry.ok === true };
    }
  }
  return out;
}

// ───────────────────────────────────────────── settings a user can change

/**
 * The list of places a hand-added site may take its credentials from.
 *
 * The chooser in the UI is built from this, so it can only offer kinds this module knows how to look for.
 * `null` is in the list and means "no login at all" (a site that accepts anonymous posts), which is a real
 * answer and not a placeholder.
 */
export const LOGIN_KINDS = [
  { id: 'bilibili', label: { zh: 'B 站（浏览器登录态）', en: 'bilibili (browser login)' } },
  { id: 'weibo', label: { zh: '微博（浏览器登录态）', en: 'Weibo (browser login)' } },
  { id: 'twitter', label: { zh: 'X / Twitter（OAuth）', en: 'X / Twitter (OAuth)' } },
  { id: 'youtube', label: { zh: 'YouTube（OAuth）', en: 'YouTube (OAuth)' } },
  { id: 'reddit', label: { zh: 'Reddit（OAuth）', en: 'Reddit (OAuth)' } },
  { id: 'mastodon', label: { zh: 'Mastodon（实例令牌）', en: 'Mastodon (instance token)' } },
  { id: null, label: { zh: '不需要登录', en: 'no login' } },
].map((k) => ({ ...k, probe: probeAvailability(k.id) }));

/**
 * Normalize one site entry coming from the UI.
 *
 * Two things matter here and both are about not lying to the person who typed it:
 *   1) the **requirements are filled in from what this build can actually check** for that login kind --
 *      oauth kinds get login/token/scope, cookie kinds get login/session/csrf -- rather than accepting a
 *      hand-written list that could name a check nothing performs;
 *   2) `implemented` stays false. Declaring a site makes the app able to *describe and measure* it; nothing
 *      in this build can publish to a site the user added, and a form must not be able to claim otherwise.
 * @returns {{ok:true, site:object}|{ok:false, error:string}}
 */
export function sanitizeSiteEntry(input) {
  const raw = input ?? {};
  const id = String(raw.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(id)) {
    return { ok: false, error: 'the site id must be 2-40 characters of letters, digits, "-" or "_"' };
  }
  if (SHARE_TARGETS.some((t) => t.id === id)) {
    return { ok: false, error: `"${id}" is already a built-in target` };
  }
  const kindRaw = raw.loginKind === undefined || raw.loginKind === null || raw.loginKind === '' ? null : String(raw.loginKind);
  if (kindRaw !== null && !LOGIN_KINDS.some((k) => k.id === kindRaw)) {
    return { ok: false, error: `unknown login kind: ${kindRaw}` };
  }
  const nameZh = String(raw.name?.zh ?? '').trim().slice(0, 60) || id;
  const nameEn = String(raw.name?.en ?? '').trim().slice(0, 60) || nameZh;
  const kindLabel = LOGIN_KINDS.find((k) => k.id === kindRaw)?.label ?? { zh: kindRaw ?? '登录态', en: kindRaw ?? 'a login' };
  // A site with no login is only describable while it takes anonymous posts; mark that as a declared
  // requirement of its own instead of an empty list (an empty list means "nothing to check", which would
  // report satisfied for a site nobody has looked at).
  const requirements = kindRaw === null ? ['anonymous'] : kindRaw === 'bilibili' || kindRaw === 'weibo' ? ['login', 'session', 'csrf'] : ['login', 'token', 'scope'];
  const textLimit = Number.isFinite(Number(raw.textLimit)) ? Math.max(1, Math.min(100000, Math.round(Number(raw.textLimit)))) : 2000;
  const maxImages = Number.isFinite(Number(raw.maxImages)) ? Math.max(0, Math.min(60, Math.round(Number(raw.maxImages)))) : 4;
  // A hand-added site may declare its own compose page, because that is what makes the manual hand-off
  // possible for it. Only http(s) is accepted: a compose "URL" that is not a web address would be handed to
  // the browser as-is. `{text}` / `{title}` placeholders are kept for fillCompose().
  const composeRaw = String(raw.manual?.compose ?? '').trim().slice(0, 300);
  let compose = null;
  if (composeRaw) {
    const probe = composeRaw.replace(/\{text\}|\{title\}/g, 'x');
    try {
      const u = new URL(probe);
      if (u.protocol === 'http:' || u.protocol === 'https:') compose = composeRaw;
    } catch {
      compose = null;
    }
  }
  return {
    ok: true,
    site: {
      id,
      custom: true,
      name: { zh: nameZh, en: nameEn },
      loginKind: kindRaw,
      credential: { zh: `${kindLabel.zh} 的登录态`, en: `the login of ${kindLabel.en}` },
      requirements,
      // No probe by default. A probe name that no code implements would be a promise this module cannot
      // keep, so the verification stage reports "no probe exists" until one is written for this kind.
      verify: kindRaw === 'bilibili' ? 'login-probe' : null,
      publish: kindRaw === null ? null : 'rest-api',
      implemented: false,
      textLimit,
      maxImages,
      manual: compose ? { compose, needs: raw.manual?.needs ?? null, images: raw.manual?.images !== false } : null,
      hint: {
        zh: '自己加的站点：登记了它需要什么，能不能发还没接线。',
        en: 'A site you added: it declares what it needs; publishing is not wired up.',
      },
    },
  };
}

/** What one login kind can be measured with, in words (the UI shows this under the add-site form) */
export function probeAvailability(loginKind) {
  if (loginKind === 'bilibili') {
    return {
      probe: 'login-probe',
      label: { zh: '可以检测：读浏览器登录态并向站点确认身份', en: 'measurable: reads the browser login and asks the site who it is' },
    };
  }
  if (loginKind === 'mastodon') {
    return {
      probe: 'token-scope',
      label: { zh: '可以检测：本地检查令牌有没有发帖权限', en: 'measurable: checks locally whether the token carries the posting scope' },
    };
  }
  return {
    probe: null,
    label: { zh: '暂无可跑的检测：只会如实报告缺什么，不会假装验证过', en: 'no probe yet: it reports what is missing instead of pretending it was verified' },
  };
}

/** Apply a partial settings change to the share config (pure; the caller persists it) */
export function applyShareSettings(cfg, patch = {}) {
  const share = { ...(cfg?.share ?? {}) };
  if (patch.images && typeof patch.images === 'object') {
    const current = shareImageSetting(cfg);
    const mode = ['none', 'source', 'inline'].includes(patch.images.mode) ? patch.images.mode : current.mode;
    const clamp = (v, fallback, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : fallback);
    share.images = {
      mode,
      maxPerBundle: clamp(patch.images.maxPerBundle, current.maxPerBundle, 60),
      maxPerPost: clamp(patch.images.maxPerPost, current.maxPerPost, 60),
      inlineMaxBytes: Number.isFinite(Number(patch.images.inlineMaxBytes)) ? patch.images.inlineMaxBytes : current.inlineMaxBytes,
    };
  }
  if (patch.accounts && typeof patch.accounts === 'object' && !Array.isArray(patch.accounts)) {
    const next = { ...(share.accounts ?? {}) };
    for (const [target, accountId] of Object.entries(patch.accounts)) {
      if (!targetById(target, { share })) continue;
      if (accountId === null) delete next[target];
      else next[target] = String(accountId).slice(0, 80);
    }
    share.accounts = next;
  }
  if (Array.isArray(patch.sites)) {
    // **Add** the entries, keyed by id, rather than replacing the list.
    // Replacing would mean a single "add a site" click silently deletes every site whose checkbox the page
    // had not sent -- the same class of mistake as writing a patch with `{...cfg, share: {...}}`: a partial
    // update that turns out to be total. Declared sites are validated here, so one bad entry cannot poison
    // the list, and a site that fails validation is reported instead of being dropped quietly.
    const existing = Array.isArray(share.sites) ? share.sites : [];
    const byId = new Map(existing.map((s) => [s?.id, s]));
    const errors = [];
    for (const raw of patch.sites) {
      const r = sanitizeSiteEntry(raw);
      if (!r.ok) {
        errors.push(`${raw?.id ?? '(no id)'}: ${r.error}`);
        continue;
      }
      byId.set(r.site.id, r.site);
    }
    share.sites = [...byId.values()];
    if (errors.length) return { ...cfg, share, sitesError: errors.join('; ') };
  }
  if (Array.isArray(patch.removeSites)) {
    const remove = new Set(patch.removeSites.map((s) => String(s)));
    share.sites = (share.sites ?? []).filter((s) => !remove.has(String(s?.id)));
  }
  return { ...cfg, share };
}

/** The plain-text body for a site: the title, and every item's title with its link (a post is text, not a file) */
export function renderSiteText(bundle) {
  const lines = [];
  if (bundle.subtitle) lines.push(String(bundle.subtitle), '');
  if (bundle.note) lines.push(String(bundle.note), '');
  for (const it of bundle.items) {
    lines.push(`· ${it.title}`);
    if (it.url) lines.push(`  ${it.url}`);
  }
  return lines.join('\n').trim();
}

/**
 * Cut a body down to a site's limit **on a line boundary** and say that it was cut.
 *
 * A post that silently loses its tail is worse than one that says "there is more": the person is about to
 * publish this under their own name, so the truncation has to be visible in the text itself.
 */
export function truncateForSite(text, limit) {
  const s = String(text ?? '');
  if (!Number.isFinite(Number(limit)) || s.length <= limit) {
    return { text: s, truncated: false, droppedLines: 0, limit: Number(limit) || null };
  }
  const lines = s.split('\n');
  const kept = [];
  let total = 0;
  const placeholder = (n) => (n === 1 ? '[+1 more line cut to fit the limit]' : `[+${n} more lines cut to fit the limit]`);
  for (const line of lines) {
    const rest = lines.length - kept.length - 1;
    // The reservation keeps the marker itself inside the limit: without it the marker pushes the body back
    // over the limit and the post is cut a second time, by the site, with nothing said about it.
    const reserve = rest > 0 ? placeholder(rest).length + 1 : 0;
    if (total + line.length + 1 + reserve > limit) break;
    kept.push(line);
    total += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  const marker = dropped > 0 ? placeholder(dropped) : '';
  const out = marker ? [...kept, marker].join('\n') : kept.join('\n');
  return { text: out.slice(0, limit), truncated: true, droppedLines: dropped, limit };
}

/** Where a site's own compose page is, in words (a template with `{text}` is pre-filled by the hand-off) */
function manualInstruction(manual) {
  if (!manual?.compose) {
    return { zh: '这个站点没有可用的网页发布入口', en: 'this site has no usable web compose page' };
  }
  if (manual.compose.includes('{text}')) {
    return { zh: '按钮会把正文带进站点的发布页', en: 'the button carries the body into the site compose page' };
  }
  return { zh: '按钮只打开站点的发布页（正文用复制按钮粘贴）', en: 'the button only opens the compose page (paste the body with the copy button)' };
}

/** Put the body (and a title, where the template wants one) into a compose URL template */
function fillCompose(manual, bundle, body) {
  if (!manual?.compose) return null;
  let url = String(manual.compose);
  if (url.includes('{text}')) {
    const params = new URLSearchParams({ text: body });
    url = url.replace('{text}', params.toString().replace(/^text=/, ''));
  }
  if (url.includes('{title}')) url = url.replace('{title}', encodeURIComponent(String(bundle.title ?? '')));
  if (/[{]/.test(url)) return null; // a placeholder nothing filled: better no link than a broken one
  return url;
}

/**
 * Build the hand-off for a target this app cannot post to.
 *
 * This is the answer to "anything the project cannot do must still be preparable by hand": the text and the
 * attachment are prepared with **the target's own limit and image setting**, a button opens the site's compose
 * page with as much as the site accepts in a URL, and the copy/download buttons cover the rest.
 *
 * Four rules are built into the shape of what comes back:
 *   1) **nothing is sent** -- `sent: false`, and the caller records a hand-off (`manual`), never a post;
 *   2) `posted` says plainly that this app has not posted there, so no screen can read the hand-off as a send;
 *   3) the text is encoded for a URL by a real encoder, so `&`, `#` and spaces survive into the compose box;
 *   4) no network call, and no image download: this whole function is a pure computation over the bundle.
 *
 * @param {object} o { targetId, bundle, cfg, accountId }
 */
export function buildHandoff({ targetId, bundle = null, cfg = {}, accountId = null } = {}) {
  const target = targetById(targetId, cfg);
  if (!target) return { ok: false, error: `unknown target: ${targetId}` };
  if (target.kind !== 'post') return { ok: false, error: 'this target is not a posting site; use the file or copy buttons' };
  const profile = siteProfileById(targetId, cfg);
  if (profile?.implemented && !profile?.unsupported) {
    // A site this build can publish to does not need a hand-off; saying so keeps the manual path honest.
    return { ok: false, error: 'this site is implemented; use the send step' };
  }
  const b = bundle ?? buildBundle({ scopeKind: 'latest', items: [], title: 'Vtuber 情报分享' });
  const full = renderSiteText(b);
  const cut = truncateForSite(full, profile?.textLimit);
  const images = imagePlan(shareImageSetting(cfg), profile?.maxImages);
  const manual = profile?.manual ?? null;
  return {
    ok: true,
    target: targetId,
    name: target.name,
    manual: true,
    // The two lines that must never be misread: nothing was sent, and this app has not posted there.
    sent: false,
    posted: false,
    postedNote: { zh: '本程序不会替你发到这个站点', en: 'this app does not post to this site for you' },
    prepare: { zh: '准备好正文和配图，由你自己发', en: 'the body and the attachment are prepared; you post it yourself' },
    text: cut.text,
    fullLength: full.length,
    textLength: cut.text.length,
    truncated: cut.truncated,
    droppedLines: cut.droppedLines,
    textLimit: profile?.textLimit ?? null,
    fits: !cut.truncated,
    // With a body that does not fit, no compose link is offered: a truncated compose box is how a half post
    // gets published by accident, and the copy/file path is right there.
    composeUrl: cut.truncated ? null : fillCompose(manual, b, cut.text),
    composeNote: cut.truncated
      ? { zh: `正文 ${full.length} 字符，超过本站上限 ${profile?.textLimit}；按钮里不带正文，请用复制或下载`, en: `the body is ${full.length} characters, over this site's ${profile?.textLimit} limit; the button carries no text, use copy or download` }
      : manualInstruction(manual),
    needs: manual?.needs ?? { zh: '需要该站点的账号', en: 'an account on that site' },
    site: {
      id: profile?.id ?? targetId,
      credential: profile?.credential ?? null,
      textLimit: profile?.textLimit ?? null,
      maxImages: profile?.maxImages ?? 0,
      imagesAllowed: manual?.images !== false,
      implemented: !!profile?.implemented,
      unsupported: !!profile?.unsupported,
      requirements: profile?.requirements ?? [],
    },
    // What the copy/download buttons should carry: the prepared body, and the image setting resolved against
    // this site's own ceiling rather than the page default.
    images: { mode: images.mode, maxPerBundle: images.limit, maxPerPost: images.maxPerPost },
    bundle: { title: b.title, items: b.items.length, contentDate: b.contentDate ?? null, scope: b.scope ?? null },
    accountId: accountId ?? null,
  };
}

// ───────────────────────────────────────────── measurement

const VERIFY_METHODS = {
  'login-probe': 'an authenticated "who am I" request to the site',
  'token-scope': 'the scopes carried by the stored token',
  'http-probe': 'an authenticated request to the site API',
};

/**
 * Measure the verification stage for real.
 *
 * This is the "check against the site only on demand" half of the decision: it costs a request, so the
 * UI runs it when the user asks, not on every page open. What it deliberately does **not** do is publish
 * anything -- for bilibili it reads the credential and asks the site who the account is, which is the
 * closest honest measurement of "this credential can post" that does not put text in public.
 *
 * Every failure path returns a reason; nothing here ever reports ok:true without having talked to the site.
 * @param {object} cfg
 * @param {string} targetId
 * @param {object} [opts] { accounts, accountId, whoAmI (injectable for tests), fetchCookies }
 */
export async function measureVerification(cfg, targetId, { accounts = [], accountId = null, whoAmI = defaultWhoAmI } = {}) {
  const target = targetById(targetId, cfg);
  if (!target) return { ok: false, target: targetId, error: 'unknown target' };
  const profile = siteProfileById(targetId, cfg);
  if (!profile) return { ok: false, target: targetId, error: 'not a posting target' };
  const method = profile.verify;
  if (!method) {
    return {
      ok: false,
      target: targetId,
      implemented: false,
      probe: null,
      reason: 'no probe implemented for this site yet -- declared requirements only',
      unsatisfied: profile.requirements.map((id) => ({ id, label: REQUIREMENTS[id]?.label ?? null })),
    };
  }

  const chosen = accountId
    ? accountsFor(profile, accounts).find((a) => a.id === accountId) ?? null
    : accountsFor(profile, accounts).find((a) => a.id === pickAccountId(targetId, accounts, cfg)) ?? pickAccount(profile, accounts);
  if (!chosen) {
    return { ok: false, target: targetId, probe: method, reason: `no ${profile.loginKind} account to verify`, unsatisfied: [] };
  }

  const m = requirementsMet(profile, chosen);
  if (!m.met) {
    return {
      ok: false,
      target: targetId,
      probe: method,
      accountId: chosen.id,
      accountName: chosen.name ?? chosen.uname ?? chosen.mid ?? chosen.id,
      reason: `the credential does not satisfy: ${m.unsatisfied.map((u) => u.id).join(', ')}`,
      unsatisfied: m.unsatisfied,
    };
  }

  if (method === 'token-scope') {
    const has = chosen.hasScope === true;
    const at = new Date().toISOString();
    return {
      ok: has,
      target: targetId,
      probe: method,
      accountId: chosen.id,
      accountName: chosen.name ?? chosen.id,
      method: VERIFY_METHODS[method],
      at,
      reason: has ? null : 'the stored token does not carry the posting scope',
      detail: has
        ? { zh: '令牌带有发帖权限', en: 'the token carries the posting scope' }
        : { zh: '令牌缺少发帖权限', en: 'the token lacks the posting scope' },
    };
  }

  // login-probe: read the credential fresh (never a cached cookie) and ask the site who it is
  let cookieHeader = chosen.cookieHeader ?? null;
  if (!cookieHeader && chosen.profile) {
    const ck = await readBrowserCookies(chosen.profile, [credentialDomain(profile.loginKind)]);
    if (!ck.ok) {
      return {
        ok: false,
        target: targetId,
        probe: method,
        accountId: chosen.id,
        accountName: chosen.name ?? chosen.uname ?? chosen.mid ?? chosen.id,
        reason: `could not read the credential: ${ck.error}`,
      };
    }
    cookieHeader = ck.cookieHeader;
  }
  if (!cookieHeader) {
    return { ok: false, target: targetId, probe: method, accountId: chosen.id, reason: 'no credential available' };
  }
  const me = await whoAmI(cfg, cookieHeader);
  const at = new Date().toISOString();
  if (!me?.ok) {
    return {
      ok: false,
      target: targetId,
      probe: method,
      accountId: chosen.id,
      at,
      reason: `the site refused the credential: ${me?.error ?? 'unknown error'}`,
      detail: { zh: `站点拒绝了这份登录态：${me?.error ?? ''}`, en: `the site refused the credential: ${me?.error ?? ''}` },
    };
  }
  if (!me.isLogin) {
    return {
      ok: false,
      target: targetId,
      probe: method,
      accountId: chosen.id,
      at,
      reason: 'the credential is not a logged-in session any more',
      detail: { zh: '这份登录态已经失效（站点说没登录）', en: 'the credential is no longer a logged-in session' },
    };
  }
  const name = me.uname ?? chosen.name ?? chosen.uname ?? chosen.mid ?? chosen.id;
  return {
    ok: true,
    target: targetId,
    probe: method,
    accountId: chosen.id,
    accountName: name,
    mid: me.mid ?? null,
    method: VERIFY_METHODS[method],
    at,
    // What was measured, said plainly: the site answered with this identity, which is exactly the thing
    // that must be true before a post can be expected to land under this account.
    measured: { isLogin: true, mid: me.mid ?? null, uname: me.uname ?? null },
    detail: { zh: `站点确认登录态有效：${name}${me.mid ? `（mid ${me.mid}）` : ''}`, en: `the site confirmed the login: ${name}${me.mid ? ` (mid ${me.mid})` : ''}` },
    reason: null,
  };
}

/** The cookie domain a login kind is read from (only the kinds that are actually probed need one) */
function credentialDomain(loginKind) {
  return (
    {
      bilibili: 'bilibili.com',
      weibo: 'weibo.com',
      twitter: 'x.com',
      youtube: 'youtube.com',
      reddit: 'reddit.com',
    }[loginKind] ?? String(loginKind ?? '')
  );
}

function loginKindLabel(kind) {
  return { bilibili: 'B 站', weibo: '微博', twitter: 'X', youtube: 'YouTube', reddit: 'Reddit', mastodon: 'Mastodon' }[kind] ?? String(kind ?? '');
}

function siteCredentialLabel(profile) {
  return profile?.credential ?? { zh: '登录态', en: 'a login' };
}

// ───────────────────────────────────────────── content packaging

/**
 * The image attachment plan of one bundle.
 *
 * Until now the bundle always carried up to four images, which is wrong in both directions: a bundle
 * nobody asked to carry images got them anyway (and a remote image is the one thing that can make the
 * file look broken in front of the recipient), while a post never got one. So the count is a setting
 * now, per bundle and per post, and what could not be attached is reported instead of dropped quietly.
 */
export function imagePlan(setting = DEFAULT_IMAGES, maxImages = null) {
  const mode = setting?.mode ?? 'none';
  const perBundle = Math.max(0, Number(setting?.maxPerBundle ?? 0));
  // `maxImages == null` has to be tested **before** Number(): Number(null) is 0, and 0 is finite, so the
  // obvious `Number.isFinite(Number(maxImages))` reads "no site limit given" as "the site allows nothing"
  // and silently attaches zero images. Measured: that is what the first version of this line did, and the
  // first self-test missed it because every case it exercised passed a site limit in.
  const siteMax = maxImages == null || maxImages === '' ? perBundle : Math.max(0, Number(maxImages) || 0);
  return {
    mode,
    limit: mode === 'none' ? 0 : Math.min(perBundle, siteMax),
    inlineMaxBytes: Number(setting?.inlineMaxBytes) || DEFAULT_IMAGES.inlineMaxBytes,
    maxPerPost: Math.max(0, Number(setting?.maxPerPost ?? 0)),
  };
}

/** Collect the shareable content out of the intel items (using the people / keywords fields in place) */
function collect(items, { maxItems = 60, images = imagePlan() } = {}) {
  let inlineBytes = 0;
  let skipped = 0;
  const out = (items ?? []).slice(0, maxItems).map((it) => {
    const picked = [];
    for (const url of (it.images ?? []).slice(0, images.limit)) {
      const s = String(url);
      if (images.mode === 'inline') {
        // Only a data: URI can be inlined without a network fetch, and rendering a bundle is synchronous
        // on purpose (it is a download endpoint). A remote image is therefore **not** fetched here; the
        // honest outcome is to leave it out and count it, see `imageNote` below.
        if (!s.startsWith('data:')) {
          skipped++;
          continue;
        }
        if (inlineBytes + s.length > images.inlineMaxBytes) {
          skipped++;
          continue;
        }
        inlineBytes += s.length;
      }
      picked.push(s);
    }
    return {
      id: it.id,
      title: it.title ?? String(it.text ?? '').slice(0, 120),
      text: it.text ? String(it.text).slice(0, 400) : '',
      url: it.url ?? null,
      sourceId: it.sourceId ?? null,
      sourceName: it.sourceName ?? null,
      publishedAt: it.publishedAt ?? it.at ?? null,
      people: it.people ?? [],
      keywords: it.keywords ?? [],
      images: picked,
    };
  });
  return { items: out, skipped };
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
    // Markdown can only reference an image that is already addressable; a data: URI is addressable
    // everywhere, so it is the only shape rendered here (an http image in an .md file is a hotlink)
    for (const img of it.images ?? []) {
      if (String(img).startsWith('data:')) lines.push('', `![](${img})`);
    }
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
 * Note this is also why the "source" image mode may not put an http image in here: that would be the very
 * external reference this file must not have, so only inline (data:) images are rendered -- and the page
 * says how many were left out instead of showing a broken frame.
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
      const imgs = (it.images ?? [])
        .filter((u) => String(u).startsWith('data:'))
        .map((u) => `<img alt="" src="${esc(u)}">`)
        .join('');
      return `<article class="card">
  <h2>${esc(it.title)}</h2>
  <div class="meta">${meta}</div>
  ${it.text ? `<p>${esc(it.text)}</p>` : ''}
  ${it.url ? `<p><a href="${esc(it.url)}" rel="noopener noreferrer">${esc(it.url)}</a></p>` : ''}
  ${imgs ? `<div class="imgs">${imgs}</div>` : ''}
</article>`;
    })
    .join('\n');
  const body = `<h1>${esc(bundle.title)}</h1>
${bundle.subtitle ? `<p class="sub">${esc(bundle.subtitle)}</p>` : ''}
<p class="note">共 ${bundle.items.length} 条 · 生成于 ${esc(bundle.generatedAt)}${bundle.note ? ` · ${esc(bundle.note)}` : ''}</p>
${bundle.images?.note ? `<p class="note">${esc(bundle.images.note)}</p>` : ''}
${cards}`;
  // Reuse the report styling shell so the look stays "the same family"; then add the extra rules the share view needs
  return htmlShell(bundle.title, '', '').replace(
    '</body>',
    `<style>
.card { border: 1px solid #8883; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
.card h2 { font-size: 16px; margin: 0 0 6px; border: 0; padding: 0; }
.meta, .note, .sub { font-size: 12px; color: #8888; }
.meta { margin-bottom: 8px; }
.imgs { display: flex; flex-wrap: wrap; gap: 8px; }
.imgs img { max-width: 220px; max-height: 160px; border-radius: 8px; }
a { word-break: break-all; }
</style>
${body}
</body>`
  );
}

/**
 * Build a share bundle.
 *
 * Mind the two dates here; they must not be conflated:
 *   - contentDate -- which day the **content** belongs to (that daily report / that person's data at the time)
 *   - generatedAt -- **when it was exported**
 * The filename and the title use contentDate (only then does the recipient know what this is); with no
 * content date it falls back to the export day.
 * @param {object} o
 * @param {'latest'|'day'|'person'|'event'|'items'} o.scopeKind
 * @param {object[]} o.items the already-filtered items
 * @param {string} o.title
 * @param {object} [o.images] the image setting (cfg.share.images); with it the bundle carries what was asked for
 * @param {number} [o.maxImages] the ceiling of the destination site (from its profile)
 */
export function buildBundle({
  scopeKind = 'latest',
  items = [],
  title,
  subtitle = '',
  note = '',
  contentDate = null,
  generatedAt = new Date().toISOString(),
  images = null,
  maxImages = null,
}) {
  const plan = imagePlan(images ?? DEFAULT_IMAGES, maxImages);
  const picked = collect(items, { images: plan });
  return {
    scope: scopeKind,
    title: title ?? 'Vtuber 情报分享',
    subtitle,
    note,
    contentDate: contentDate ?? null,
    generatedAt,
    images: {
      mode: plan.mode,
      limit: plan.limit,
      attached: picked.items.reduce((n, it) => n + (it.images?.length ?? 0), 0),
      skipped: picked.skipped,
      note: imageNote(plan, picked.skipped),
    },
    items: picked.items,
  };
}

/** What the reader needs to know about the images that are (not) in the file -- silence here reads as "there were none" */
function imageNote(plan, skipped) {
  if (plan.mode === 'none') return '未附图片（分享设置里可开启）';
  const parts = [`图片模式：${plan.mode === 'inline' ? '内嵌' : '仅原始链接'}`];
  if (plan.mode === 'source') parts.push('HTML 不引用外链图，因此单文件里不会显示图片');
  if (skipped) parts.push(`有 ${skipped} 张图没有附上（不是 data: 内嵌，或超过体积上限）`);
  return parts.join(' · ');
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
 * HTTP headers may carry **ASCII only** -- a filename with Chinese in it (share titles usually contain
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
 * Whether one share target can be used right now (the send stage, flattened for callers that only need a yes/no).
 * @param {object} target
 * @param {object[]} accounts the result of listAccounts()
 * @param {object} [store] the verification store
 */
export function checkReadiness(target, accounts = [], store = {}) {
  if (!target) return { ok: false, reason: 'unknown target' };
  if (target.status === 'unsupported') return { ok: false, status: 'unsupported', reason: 'unsupported' };
  if (target.status === 'unimplemented') return { ok: false, status: 'unimplemented', reason: 'there is no publish code for this site yet' };
  if (!target.needsLogin) return { ok: true, status: 'ready' };
  const profile = siteProfileById(target.id);
  const usable = pickAccount(profile, accounts);
  const met = profile ? requirementsMet(profile, usable) : { met: false, unsatisfied: [] };
  if (!usable || !met.met) {
    return {
      ok: false,
      status: 'needs-login',
      reason:
        target.loginKind === 'bilibili'
          ? '需要 B 站登录态（SESSDATA + bili_jct），并且浏览器里得是已登录状态'
          : `需要 ${target.loginKind} 的登录态`,
      unsatisfied: met.unsatisfied,
    };
  }
  const verified = verificationFor(store, target.id, usable.id);
  const fresh = verificationFreshness(verified);
  const done = verified?.ok === true && !fresh.stale;
  if (!done) {
    return {
      ok: false,
      status: 'needs-verification',
      account: usable.name ?? usable.uname ?? usable.mid ?? usable.id ?? null,
      accountId: usable.id ?? null,
      reason: 'this target has not been measured successfully for this account yet',
    };
  }
  return {
    ok: true,
    status: 'ready',
    account: usable.name ?? usable.uname ?? usable.mid ?? usable.id ?? null,
    accountId: usable.id ?? null,
    ready: true,
  };
}

/** Readiness of every target at a glance (the UI uses it to show what is missing) */
export function readinessReport(accounts = [], store = {}, cfg = {}) {
  return shareTargets(cfg).map((t) => {
    const r = checkReadiness(t, accounts, store);
    const st = stageReport(t, accounts, store, { cfg });
    return {
      id: t.id,
      name: t.name,
      needsLogin: t.needsLogin,
      status: r.status,
      declaredStatus: t.status,
      verified: st.verification.status === 'done',
      canDo: r.ok,
      reason: r.reason ?? null,
      account: r.account ?? null,
      accountId: r.accountId ?? null,
      kind: t.kind,
      hint: t.hint,
      stages: { account: st.account, verification: st.verification, send: st.send },
      site: st.profile
        ? { id: st.profile.id, credential: st.profile.credential, verify: st.profile.verify, implemented: st.profile.implemented, maxImages: st.profile.maxImages }
        : null,
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
 *   2. all three stages must be settled: an account that satisfies the site's declared requirements,
 *      a verification that was measured successfully **for that account** and is not stale, and a
 *      publish implementation that exists
 *   3. the content must be non-empty and within the limit the site itself declares
 *   4. leave an audit entry
 * A scheduled run never reaches this code -- the only call sites are HTTP routes.
 */
export function guardPost(cfg, { target, accounts = [], verified = {}, text, confirm = false, accountId = null }) {
  const t = targetById(target, cfg);
  if (!t) return { ok: false, error: `unknown target: ${target}` };
  if (t.kind !== 'post') return { ok: false, error: `target is not a posting target: ${target}` };
  if (confirm !== true) return { ok: false, error: '需要显式确认（confirm: true）——对外发声不可撤销，绝不自动执行' };
  if (t.status === 'unsupported') return { ok: false, error: '此平台不支持自动发帖（见目标说明）' };
  const profile = siteProfileById(target, cfg);
  if (!profile?.implemented) {
    return {
      ok: false,
      error: '这个站点的发送还没实现（只有声明，没有代码）——不会假装发出去了',
      status: 'unimplemented',
    };
  }
  const store = Array.isArray(verified) ? verificationStore({ share: { verifiedTargets: verified } }) : verified ?? {};
  const st = stageReport(t, accounts, store, { cfg, accountId });
  if (st.account.status !== 'satisfied') {
    return { ok: false, error: st.account.detail.zh, status: 'needs-login', account: null };
  }
  if (st.verification.status !== 'done') {
    return {
      ok: false,
      error: '这个账号还没被验证过（先在「验证」这一步测一次），暂不允许对外使用',
      status: 'needs-verification',
    };
  }
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  const limit = Number.isFinite(Number(profile.textLimit)) ? Number(profile.textLimit) : 2000;
  if (body.length > limit) return { ok: false, error: `内容过长（本站上限 ${limit} 字）`, limit };
  return { ok: true, target: t, body, profile, accountId: st.account.accountId };
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
    const out = { ok, code, account: acct.name ?? acct.id, accountId: acct.id, error: ok ? null : j?.message ?? `HTTP ${res.status}` };
    if (ok) log?.info(`dynamic posted as ${out.account}`);
    else log?.warn(`dynamic post failed: ${out.error}`);
    return out;
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}
