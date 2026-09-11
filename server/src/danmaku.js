// danmaku.js — 发弹幕 / post a live comment
//
// ⚠ 与本项目其它模块的性质区别，必须先看清楚：
//   其它一切都是**只读抓取**；这个模块会**用使用者本人的账号身份向直播间写内容**。
//   因此这里刻意做成一堆「必须手动通过」的关卡：
//     1. 必须显式传 confirm=true（缺了就 400，不会「默认帮你发」）；
//     2. 必须指定账号（不允许「用第一个能用的」这种便利）；
//     3. 发送前重新读一次 cookie（不缓存、不落盘、不进日志）；
//     4. 保守的本地限速（同一账号最小间隔），避免误触连发被平台判定刷屏；
//     5. 每次发送都记一条审计日志（只记谁/发到哪/发了什么/结果，绝不记 cookie）；
//     6. **不接入任何自动流程** —— 定时任务、收集流程都不会调用它。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';
import { netFetch } from './net.js';
import { readBrowserCookies } from './cookies.js';
import { listAccounts, ACCOUNT_UA } from './accounts.js';

const SEND_URL = 'https://api.live.bilibili.com/msg/send';
const MAX_LEN = 20; // B 站直播间弹幕长度上限
const MIN_INTERVAL_MS = 5000; // 同一账号两次发送的最小间隔（本地限速，比平台更保守）

/** 同一进程内按账号记最后发送时间 */
const lastSent = new Map();

/** 把 B 站返回码翻成人话 */
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
    // 只写：时间 / 账号 mid / 房间 / 内容 / 结果 —— 没有任何凭据
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* 审计写不进去不该影响发送结果，但要在返回值里说明 */
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
  // 按字符数算（B 站按长度限制，中文一字算一个）
  if ([...t].length > MAX_LEN) return { ok: false, error: `超过 ${MAX_LEN} 字上限（当前 ${[...t].length}）` };
  return { ok: true, text: t };
}

/**
 * 发一条弹幕。
 * @param {object} cfg
 * @param {object} log
 * @param {{accountId:string, roomId:string|number, text:string, confirm:boolean}} req
 */
export async function sendDanmaku(cfg, log, req) {
  // 关卡 1：必须显式确认
  if (req?.confirm !== true) {
    return { ok: false, error: '必须显式确认（confirm=true）才会发送 —— 这是用你的账号身份公开发言，不做任何默认动作' };
  }
  // 关卡 2：必须指定账号
  const accountId = String(req?.accountId ?? '').trim();
  if (!accountId) return { ok: false, error: '必须指定用哪个账号发送' };

  const roomId = String(req?.roomId ?? '').replace(/\D/g, '');
  if (!roomId) return { ok: false, error: '缺少直播间号' };

  const v = validateText(req?.text);
  if (!v.ok) return { ok: false, error: v.error };

  // 关卡 3：确认这个账号现在仍然可用
  const { accounts } = await listAccounts(cfg);
  const acct = accounts.find((a) => a.id === accountId);
  if (!acct) return { ok: false, error: '找不到该账号（登录态可能已失效，刷新一下列表）' };
  if (!acct.canSend) return { ok: false, error: `该账号当前不能发言：${acct.note ?? '缺少 SESSDATA 或 bili_jct'}` };

  // 关卡 4：本地限速
  const last = lastSent.get(accountId) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) return { ok: false, error: `本地限速：请等 ${Math.ceil(wait / 1000)} 秒后再发（同一账号 ${MIN_INTERVAL_MS / 1000} 秒一条）` };

  // 关卡 5：现场重新读 cookie（不缓存）
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
    const r = await netFetch(
      SEND_URL,
      {
        method: 'POST',
        headers: {
          'user-agent': ACCOUNT_UA,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json, text/plain, */*',
          cookie: ck.cookieHeader,
          referer: `https://live.bilibili.com/${roomId}`,
          origin: 'https://live.bilibili.com',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      },
      { cfg, mode: 'direct' } // 与其它 bilibili 调用一致：直连才通，走代理会被风控
    );
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* 非 JSON 就下面统一处理 */
    }
    const code = j?.code ?? null;
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
  if (result.ok) log?.info(`弹幕已发送 / danmaku sent — ${acct.uname ?? acct.mid} → 房间 ${roomId}：${v.text}`);
  else log?.warn(`弹幕发送失败 / danmaku failed — code=${result.code ?? '-'} ${result.error ?? result.message ?? ''}`);

  return { ...result, auditLogged: logged, account: { mid: acct.mid, uname: acct.uname }, roomId, text: v.text };
}

export { MAX_LEN, MIN_INTERVAL_MS };
