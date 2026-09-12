// danmaku.js — post a live comment
//
// ⚠ This differs in kind from every other module in this project, so read it first:
//   everything else is **read-only fetching**; this module **writes content into a live room under
//   the user's own account identity**.
//   That is why it is deliberately built as a stack of gates that must be passed by hand:
//     1. confirm=true must be passed explicitly (missing it is a 400, it never "sends for you by default");
//     2. the account must be named (the convenience of "just use the first usable one" is not allowed);
//     3. the cookie is read once more right before sending (not cached, not written to disk, not logged);
//     4. a conservative local rate limit (minimum gap per account), so an accidental double-fire is not judged as flooding by the platform;
//     5. every send records one audit line (only who / to where / what / result, never the cookie);
//     6. **it is wired into no automatic flow at all** — neither the scheduler nor the collection run ever calls it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { netFetch } from './net.js';
import { readBrowserCookies } from './cookies.js';
import { listAccounts, ACCOUNT_UA } from './accounts.js';
import { wbiPost } from './wbi.js';

const SEND_URL = 'https://api.live.bilibili.com/msg/send';
const MAX_LEN = 20; // bilibili live-room danmaku length cap
const MIN_INTERVAL_MS = 5000; // minimum gap between two sends from the same account (local rate limit, more conservative than the platform)

/** last send time per account, tracked inside this process */
const lastSent = new Map();

/** turn a bilibili return code into words a human can read */
const CODE_HINT = {
  0: '发送成功',
  '-101': '账号未登录（登录态可能已失效，重新登录该浏览器即可）',
  '-111': 'CSRF 校验失败（bili_jct 与 SESSDATA 不配套）',
  '-400': '请求被拒绝（参数或风控）',
  '-403': '没有权限（可能被禁言或该房间不允许发言）',
  10030: '发送过于频繁或内容重复，稍后再试',
  1003212: '该账号未绑定手机号，B 站要求绑定后才能发言',
  '-412': '被风控拦截（这条限制通常有时效，等待或换网络出口）',
};

function logPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'danmaku.jsonl');
}

function audit(cfg, entry) {
  try {
    const f = logPath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // only time / account mid / room / content / result are written — never any credential
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* an unwritable audit must not change the send result, but the return value has to say so */
    return false;
  }
  return true;
}

export function readAudit(cfg, limit = 50) {
  try {
    const f = logPath(cfg);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
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
  } catch {
    return [];
  }
}

export function validateText(text) {
  const t = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!t) return { ok: false, error: '内容为空' };
  // counted in characters (bilibili limits by length, and one CJK character counts as one)
  if ([...t].length > MAX_LEN) return { ok: false, error: `超过 ${MAX_LEN} 字上限（当前 ${[...t].length}）` };
  return { ok: true, text: t };
}

/**
 * Post one danmaku.
 * @param {object} cfg
 * @param {object} log
 * @param {{accountId:string, roomId:string|number, text:string, confirm:boolean}} req
 */
export async function sendDanmaku(cfg, log, req) {
  // gate 1: explicit confirmation is required
  if (req?.confirm !== true) {
    return { ok: false, error: '必须显式确认（confirm=true）才会发送 —— 这是用你的账号身份公开发言，不做任何默认动作' };
  }
  // gate 2: the account has to be named
  const accountId = String(req?.accountId ?? '').trim();
  if (!accountId) return { ok: false, error: '必须指定用哪个账号发送' };

  const roomId = String(req?.roomId ?? '').replace(/\D/g, '');
  if (!roomId) return { ok: false, error: '缺少直播间号' };

  const v = validateText(req?.text);
  if (!v.ok) return { ok: false, error: v.error };

  // gate 3: confirm this account is still usable right now
  const { accounts } = await listAccounts(cfg);
  const acct = accounts.find((a) => a.id === accountId);
  if (!acct) return { ok: false, error: '找不到该账号（登录态可能已失效，刷新一下列表）' };
  if (!acct.canSend) return { ok: false, error: `该账号当前不能发言：${acct.note ?? '缺少 SESSDATA 或 bili_jct'}` };

  // gate 4: local rate limit
  const last = lastSent.get(accountId) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) return { ok: false, error: `本地限速：请等 ${Math.ceil(wait / 1000)} 秒后再发（同一账号 ${MIN_INTERVAL_MS / 1000} 秒一条）` };

  // gate 5: read the cookie again on the spot (no caching)
  const ck = await readBrowserCookies(acct.profile, ['bilibili.com']);
  if (!ck.ok) return { ok: false, error: `读不到登录态：${ck.error}` };
  const csrf = /(?:^|;\s*)bili_jct=([^;]+)/.exec(ck.cookieHeader)?.[1] ?? '';
  if (!csrf) return { ok: false, error: '缺少 bili_jct，无法通过 CSRF 校验' };

  const body = new URLSearchParams({
    bubble: '0',
    msg: v.text,
    color: '16777215',
    mode: '1',
    fontsize: '25',
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: roomId,
    csrf,
    csrf_token: csrf,
  });

  let result;
  try {
    // Sending needs WBI signing too: bilibili's newer risk control treats write endpoints the same as any
    // other, and an unsigned call is turned away with -352.
    // The signature goes on the **query**, the form body stays as it is (pushing the signature into the body makes the server call it invalid).
    const r = await wbiPost(
      cfg,
      SEND_URL,
      {
        body: body.toString(),
        headers: {
          'user-agent': ACCOUNT_UA,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json, text/plain, */*',
          cookie: ck.cookieHeader,
          referer: `https://live.bilibili.com/${roomId}`,
          origin: 'https://live.bilibili.com',
        },
        log,
      }
    );
    const j = r.json ?? null;
    const code = j?.code ?? (r.ok ? 0 : null);
    const ok = code === 0;
    result = {
      ok,
      code,
      message: j?.message ?? null,
      hint: code !== null ? (CODE_HINT[String(code)] ?? null) : null,
      httpStatus: r.status,
      raw: j ? undefined : text.slice(0, 200),
    };
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  lastSent.set(accountId, Date.now());
  const logged = audit(cfg, {
    accountId,
    mid: acct.mid ?? null,
    uname: acct.uname ?? null,
    roomId,
    text: v.text,
    ok: !!result.ok,
    code: result.code ?? null,
    error: result.ok ? null : (result.error ?? result.message ?? null),
  });
  if (result.ok) log?.info(`danmaku sent — ${acct.uname ?? acct.mid} → room ${roomId}: ${v.text}`);
  else log?.warn(`danmaku failed — code=${result.code ?? '-'} ${result.error ?? result.message ?? ''}`);

  return { ...result, auditLogged: logged, account: { mid: acct.mid, uname: acct.uname }, roomId, text: v.text };
}

export { MAX_LEN, MIN_INTERVAL_MS };
