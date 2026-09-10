// cookies.js — 从浏览器 profile 读取登录态 cookie（只读、不改动、不锁定）
//
// 为什么需要它：
//   用 Playwright 复用登录态要求目标浏览器**完全关闭**（profile 被锁），
//   而实际上我们往往只需要一个 Cookie 头去调站点的 JSON 接口。
//   于是这里做一件更轻的事：把 cookie 库**复制一份**出来读，
//   浏览器开着也无所谓，不会碰用户正在用的 profile。
//
// 实测（本机 Opera / Chromium 内核 130+）：
//   • 库位置：<userData>/<Profile>/Network/Cookies（老版本可能是 <Profile>/Cookies）
//   • 值的前缀 v10 = AES-256-GCM，密钥在 <userData>/Local State 的
//     os_crypt.encrypted_key（base64，去掉 5 字节 "DPAPI" 前缀后由 DPAPI 解出，32 字节）
//   • 明文前 32 字节是 Chromium 130+ 加的**域名绑定哈希**，要剥掉才是真正的 cookie 值
//   • v20 前缀 + Local State 里的 app_bound_encrypted_key = App-Bound Encryption
//     （Chrome 127+ 默认开启），这种读不出来，只能退回「关掉浏览器 + Playwright」
//
// 隐私边界：
//   • 只读，只取指定域名；不写日志、不落盘、不随报告/feeds 输出
//   • 复制出来的临时库用完即删
//   • 明文只在本进程内存里拼成 Cookie 头，直接发给对应站点
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 浏览器 userData 根目录 → 可能的 profile 子目录 */
const PROFILE_SUBDIRS = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4'];

export function isSupported() {
  return process.platform === 'win32';
}

/** profileDir 可能是 userData 根，也可能直接是 Default，两种都认 */
function resolveProfile(profileDir) {
  const dir = path.resolve(profileDir);
  const hasCookies = (p) => fs.existsSync(path.join(p, 'Network', 'Cookies')) || fs.existsSync(path.join(p, 'Cookies'));
  if (hasCookies(dir)) return { root: path.dirname(dir), profile: dir };
  // 传进来的是 userData 根：找第一个存在 cookie 库的 profile
  for (const sub of PROFILE_SUBDIRS) {
    const p = path.join(dir, sub);
    if (hasCookies(p)) return { root: dir, profile: p };
  }
  // 只有一个子目录时也认
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name);
      if (hasCookies(p)) return { root: dir, profile: p };
    }
  } catch {
    /* ignore */
  }
  return { root: dir, profile: null };
}

function cookieDbPath(profile) {
  for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
    const p = path.join(profile, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 连 -wal/-shm 一起复制，保证 SQLite 视图一致 */
function copyFamily(src, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, 'Cookies');
  for (const suffix of ['', '-wal', '-shm']) {
    if (!fs.existsSync(src + suffix)) continue;
    fs.copyFileSync(src + suffix, dst + suffix);
  }
  return dst;
}

async function loadSqlite() {
  try {
    const mod = await import('node:sqlite');
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

/** DPAPI 解出 AES 密钥。Node 没有原生 DPAPI，走一次 PowerShell（本机、离线）。 */
function unprotectKey(encryptedKeyB64) {
  const raw = Buffer.from(encryptedKeyB64, 'base64');
  // 前面固定是 ASCII "DPAPI"
  if (raw.subarray(0, 5).toString('ascii') !== 'DPAPI') throw new Error('unexpected key prefix');
  const payload = raw.subarray(5);
  const script = [
    '$ErrorActionPreference="Stop"',
    'Add-Type -AssemblyName System.Security',
    '$in=[Convert]::FromBase64String($env:VML_DPAPI_IN)',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    'Write-Output ([Convert]::ToBase64String($p))',
  ].join('; ');
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env: { ...process.env, VML_DPAPI_IN: payload.toString('base64') }, encoding: 'utf8', timeout: 20000, windowsHide: true }
  );
  const key = Buffer.from(String(out).trim(), 'base64');
  if (key.length !== 32) throw new Error(`unexpected key length ${key.length}`);
  return key;
}

function isPrintable(buf) {
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return true;
}

/** v10：AES-256-GCM；明文可能带 32 字节域名绑定前缀 */
function decryptV10(key, buf) {
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  let plain = Buffer.concat([d.update(ct), d.final()]);
  if (plain.length > 32 && !isPrintable(plain.subarray(0, 32))) plain = plain.subarray(32);
  return plain.toString('utf8');
}

/**
 * 读取指定域名下的 cookie。
 * @param {string} profileDir 浏览器 userData 根，或其中的某个 profile
 * @param {string[]} domains  例如 ['bilibili.com']
 * @returns {Promise<{ok:boolean, error?:string, warning?:string, cookieHeader?:string, names?:string[], profile?:string}>}
 */
export async function readBrowserCookies(profileDir, domains) {
  if (!profileDir) return { ok: false, error: '未配置浏览器 profileDir / profileDir is empty' };
  if (!isSupported()) return { ok: false, error: '仅支持 Windows（需要 DPAPI）/ Windows only' };

  const { root, profile } = resolveProfile(profileDir);
  if (!profile) return { ok: false, error: `找不到 cookie 库 / no cookie store under ${profileDir}` };

  const db = cookieDbPath(profile);
  const statePath = path.join(root, 'Local State');
  if (!fs.existsSync(statePath)) return { ok: false, error: `找不到 Local State / missing ${statePath}` };

  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return { ok: false, error: '需要 Node 22.5+ 的 node:sqlite / needs Node 22.5+' };

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Local State 读不了 / cannot read Local State: ${e.message}` };
  }
  const osCrypt = state?.os_crypt ?? {};
  const appBound = !!osCrypt.app_bound_encrypted_key;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-cookies-'));
  let rows = [];
  try {
    const copied = copyFamily(db, tmpDir);
    const conn = new DatabaseSync(copied, { readOnly: true });
    try {
      const where = domains.map(() => 'host_key LIKE ?').join(' OR ');
      rows = conn
        .prepare(
          `SELECT host_key, name, encrypted_value, length(encrypted_value) AS n FROM cookies WHERE ${where}`
        )
        .all(...domains.map((d) => `%${d}%`));
    } finally {
      conn.close();
    }
  } catch (e) {
    return { ok: false, error: `读 cookie 库失败 / cannot read cookie store: ${e.message}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!rows.length) {
    return { ok: false, error: '该 profile 里没有目标域名的 cookie（可能没登录）', profile };
  }

  let key = null;
  let keyError = '';
  if (osCrypt.encrypted_key) {
    try {
      key = unprotectKey(osCrypt.encrypted_key);
    } catch (e) {
      keyError = e.message;
    }
  }

  const byName = new Map();
  let v20 = 0;
  let failed = 0;
  for (const r of rows) {
    let value = null;
    if (r.n > 0 && key) {
      const buf = Buffer.from(r.encrypted_value);
      const prefix = buf.subarray(0, 3).toString('ascii');
      if (prefix === 'v10') {
        try {
          value = decryptV10(key, buf);
        } catch {
          failed++;
        }
      } else if (prefix === 'v20') {
        v20++;
      } else {
        // 没有前缀的老格式：值本身就是明文
        value = buf.toString('utf8');
      }
    }
    if (!value) continue;
    // 同名可能出现在多个 host_key 上，优先取域名以点开头的（对子域都生效）
    const prev = byName.get(r.name);
    if (!prev || (r.host_key.startsWith('.') && !prev.host.startsWith('.'))) {
      byName.set(r.name, { value, host: r.host_key });
    }
  }

  if (!byName.size) {
    const why = appBound || v20
      ? '该浏览器启用了 App-Bound Encryption（Chrome 127+ 默认开启），cookie 无法在外部解密；请改用「关掉浏览器 + Playwright 复用 profile」的方式'
      : keyError || `解密失败（${failed} 条）`;
    return { ok: false, error: why, warning: appBound ? 'app-bound-encryption' : undefined, profile };
  }

  const names = [...byName.keys()];
  const warning = appBound || v20 ? `部分 cookie 受 App-Bound Encryption 保护，已跳过 ${v20} 条` : undefined;
  return {
    ok: true,
    profile,
    names,
    cookieHeader: names.map((n) => `${n}=${byName.get(n).value}`).join('; '),
    warning,
  };
}
