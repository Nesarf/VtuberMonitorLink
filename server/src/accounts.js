// accounts.js — 发现本机可用的 bilibili 登录账号 / discover available bilibili logins
//
// 为什么单独一个模块：发弹幕是**用使用者本人身份写东西出去**，跟本项目其它一切
// 「只读抓取」性质完全不同。所以：
//   • 这一步是**只读**的：枚举浏览器 profile、读 cookie、调一次 nav 问出「我是谁」；
//   • **绝不回传 cookie 值**，只回传账号名 / mid / 有没有 SESSDATA 与 bili_jct；
//   • 发送在另一个模块里，且必须显式确认（见 sendDanmaku）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { netFetch } from './net.js';
import { readBrowserCookies } from './cookies.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 常见浏览器的 userData 根目录（不写死某一台机器，都从环境变量推） */
export function browserRoots() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const list = [
    ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data')],
    ['Chrome Beta', path.join(local, 'Google', 'Chrome Beta', 'User Data')],
    ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Vivaldi', path.join(local, 'Vivaldi', 'User Data')],
    ['Opera', path.join(roaming, 'Opera Software', 'Opera Stable')],
    ['Opera GX', path.join(roaming, 'Opera Software', 'Opera GX Stable')],
    ['Chromium', path.join(local, 'Chromium', 'User Data')],
  ];
  return list.filter(([, p]) => fs.existsSync(p));
}

/** 展开一个 userData 根下的全部 profile 目录 */
export function profilesUnder(root) {
  const out = [];
  const hasCookies = (p) => fs.existsSync(path.join(p, 'Network', 'Cookies')) || fs.existsSync(path.join(p, 'Cookies'));
  if (hasCookies(root)) return [root];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (hasCookies(p)) out.push(p);
  }
  return out;
}

/** 问 B 站「这个 cookie 是谁」；顺便确认登录态是否还有效 */
export async function whoAmI(cfg, cookieHeader) {
  try {
    const r = await netFetch(
      'https://api.bilibili.com/x/web-interface/nav',
      {
        headers: { 'user-agent': UA, accept: 'application/json', cookie: cookieHeader, referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(15000),
      },
      { cfg, mode: 'direct' }
    );
    const j = await r.json().catch(() => null);
    if (j?.code !== 0 && j?.code !== -101) return { ok: false, error: `code=${j?.code} ${j?.message ?? ''}` };
    const d = j?.data ?? {};
    return { ok: true, isLogin: !!d.isLogin, mid: d.mid ? String(d.mid) : null, uname: d.uname ?? null, vip: d.vipStatus ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 枚举本机所有可用的 bilibili 登录。
 * @returns {Promise<{accounts:Array, scanned:number, errors:Array}>}
 */
export async function listAccounts(cfg) {
  const dirs = new Map(); // profile 路径 -> 标签
  const configured = String(cfg?.browser?.profileDir ?? '').trim();
  if (configured) dirs.set(path.resolve(configured), '（设置里指定的）');
  for (const [label, root] of browserRoots()) {
    for (const p of profilesUnder(root)) dirs.set(path.resolve(p), label);
  }

  const accounts = [];
  const errors = [];
  for (const [dir, browser] of dirs) {
    let ck;
    try {
      ck = await readBrowserCookies(dir, ['bilibili.com']);
    } catch (e) {
      errors.push({ profile: dir, browser, error: e.message });
      continue;
    }
    if (!ck.ok) {
      // 没有登录态是常态（大部分 profile 都没登过 B 站），不必当错误刷屏
      continue;
    }
    const hasSession = (ck.names ?? []).includes('SESSDATA');
    const hasCsrf = (ck.names ?? []).includes('bili_jct');
    const me = hasSession ? await whoAmI(cfg, ck.cookieHeader) : { ok: true, isLogin: false };
    accounts.push({
      // id 用 profile 路径的短哈希：不回传路径以外的任何敏感信息
      id: Buffer.from(dir).toString('base64url').slice(0, 16),
      profile: dir,
      browser,
      hasSession,
      hasCsrf,
      // 能发弹幕的最低条件：SESSDATA + bili_jct，且 nav 确认已登录
      canSend: !!(hasSession && hasCsrf && me.isLogin),
      mid: me.mid ?? null,
      uname: me.uname ?? null,
      note: me.ok ? null : me.error,
      warning: ck.warning ?? null,
    });
  }
  return { accounts, scanned: dirs.size, errors };
}

export { UA as ACCOUNT_UA };
