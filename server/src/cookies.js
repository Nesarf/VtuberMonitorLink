// cookies.js — read logged-in cookies from a browser profile (read-only, no mutation, no locking)
//
// Why it's needed:
//   Reusing a login session with Playwright requires the target browser to be **fully closed**
//   (the profile is locked), and in practice we often only need a Cookie header to call the
//   site's JSON endpoint.
//   So this does something lighter: **copy** the cookie store out and read the copy,
//   which works with the browser open and never touches the profile the user is using.
//
// Measured (local Opera / Chromium engine 130+):
//   • store location: <userData>/<Profile>/Network/Cookies (older versions may be <Profile>/Cookies)
//   • value prefix v10 = AES-256-GCM, the key lives in <userData>/Local State as
//     os_crypt.encrypted_key (base64; after stripping the 5-byte "DPAPI" prefix it is
//     unwrapped by DPAPI into 32 bytes)
//   • the first 32 plaintext bytes are the **domain-binding hash** added by Chromium 130+;
//     they have to be stripped to get the real cookie value
//   • v20 prefix + app_bound_encrypted_key in Local State = App-Bound Encryption
//     (on by default since Chrome 127); those can't be read here, so the only fallback is
//     "close the browser + Playwright"
//
// Privacy boundary:
//   • read-only, only for the given domains; no logging, nothing written to disk, never emitted
//     in reports/feeds
//   • the copied temporary store is deleted as soon as it has been used
//   • the plaintext is only assembled into a Cookie header inside this process's memory and sent
//     straight to the matching site
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** browser userData root → the possible profile subdirectories */
const PROFILE_SUBDIRS = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4'];

export function isSupported() {
  return process.platform === 'win32';
}

/** Temp-file root: use the configured one if there is one, otherwise the system temp dir */
function tempRoot() {
  const dir = String(process.env.VML_TEMP_DIR ?? '').trim();
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // If the configured dir isn't writable, fall back to the system temp dir — a cleanup
      // policy must not take the feature down with it
    }
  }
  return os.tmpdir();
}

/** profileDir may be the userData root, or directly a Default — both are accepted */
function resolveProfile(profileDir) {
  const dir = path.resolve(profileDir);
  const hasCookies = (p) => fs.existsSync(path.join(p, 'Network', 'Cookies')) || fs.existsSync(path.join(p, 'Cookies'));
  if (hasCookies(dir)) return { root: path.dirname(dir), profile: dir };
  // What was passed in is the userData root: find the first profile that has a cookie store
  for (const sub of PROFILE_SUBDIRS) {
    const p = path.join(dir, sub);
    if (hasCookies(p)) return { root: dir, profile: p };
  }
  // A single subdirectory is accepted too
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

/** Copy -wal/-shm along with it so the SQLite view is consistent */
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

/** Unwrap the AES key with DPAPI. Node has no native DPAPI, so this goes through
 *  one PowerShell call (local, offline). */
function unprotectKey(encryptedKeyB64) {
  const raw = Buffer.from(encryptedKeyB64, 'base64');
  // Always preceded by the ASCII bytes "DPAPI"
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

/** v10: AES-256-GCM; the plaintext may carry a 32-byte domain-binding prefix */
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
 * Cookies whose **name** means "this browser is signed in".
 *
 * The names are generic session-cookie names rather than a per-site table, and the consumers use them as a
 * verdict about a verdict: a host whose own session cookie is not listed reports "cookies, but probably not
 * a login" instead of claiming a login it did not see, which is the conservative direction. A per-site name
 * used to be spelled out here (the platform the product no longer knows); the list is now about the shape of
 * a session cookie, which is not a fact about any one site.
 */
export const SESSION_COOKIE = /^(SUB|auth_token|sessionid|session|csrftoken|sid)$/i;

/** Whether a cookie store's names include something that looks like a login session */
export function hasSessionCookie(names) {
  return (Array.isArray(names) ? names : []).some((n) => SESSION_COOKIE.test(String(n)));
}

/**
 * Read the cookies for the given domains.
 * @param {string} profileDir the browser userData root, or one profile inside it
 * @param {string[]} domains  e.g. ['reddit.com', 'www.reddit.com']
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

  // Where the cookie-store copy lands: VML_TEMP_DIR first (written by index.js from
  // config.paths.tempDir, which is what enforces the hard rule of "no temp files on the C: drive"),
  // falling back to the system temp dir when unset.
  const tmpDir = fs.mkdtempSync(path.join(tempRoot(), 'vml-cookies-'));
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
        // Old format with no prefix: the value itself is plaintext
        value = buf.toString('utf8');
      }
    }
    if (!value) continue;
    // The same name may appear under several host_keys; prefer the one whose domain starts
    // with a dot (it applies to subdomains too)
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
