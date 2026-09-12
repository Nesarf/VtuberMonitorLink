// accounts.js — discover the bilibili logins available on this machine / discover available bilibili logins
//
// Why it is a module of its own: posting a danmaku **writes something out under the user's own
// identity**, which is a completely different animal from the "read-only scraping" that
// everything else in this project does. So:
//   - this step is **read-only**: enumerate browser profiles, read cookies, call nav once to ask "who am I";
//   - **cookie values are never handed back**, only the account name / mid / whether SESSDATA and bili_jct exist;
//   - sending lives in another module and requires explicit confirmation (see sendDanmaku).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { netFetch } from './net.js';
import { readBrowserCookies } from './cookies.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** userData roots of the common browsers (never hard-coded to one machine; all derived from env vars) */
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

/** Expand every profile directory under one userData root */
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

/** Ask bilibili "who is this cookie"; also confirms whether the login is still valid */
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
 * Enumerate every usable bilibili login on this machine.
 * @returns {Promise<{accounts:Array, scanned:number, errors:Array}>}
 */
export async function listAccounts(cfg) {
  const dirs = new Map(); // profile path -> label
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
      // No login state is the normal case (most profiles never signed in to bilibili),
      // so it is not worth flooding the errors with it
      continue;
    }
    const hasSession = (ck.names ?? []).includes('SESSDATA');
    const hasCsrf = (ck.names ?? []).includes('bili_jct');
    const me = hasSession ? await whoAmI(cfg, ck.cookieHeader) : { ok: true, isLogin: false };
    accounts.push({
      // id is a short hash of the profile path: no sensitive information beyond the path is handed back
      id: Buffer.from(dir).toString('base64url').slice(0, 16),
      profile: dir,
      browser,
      hasSession,
      hasCsrf,
      // Minimum requirement to post a danmaku: SESSDATA + bili_jct, plus nav confirming the login
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
