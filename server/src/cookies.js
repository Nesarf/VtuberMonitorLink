// cookies.js — read logged-in cookies from a **Firefox** profile (read-only, no mutation, no locking)
//
// Why it's needed:
//   Reusing a login session with Playwright requires the target browser to be **fully closed**
//   (the profile is locked), and in practice we often only need a Cookie header to call the
//   site's JSON endpoint.
//   So this does something lighter: **copy** the cookie store out and read the copy,
//   which works with the browser open and never touches the profile the user is using.
//
// This half got **simpler** when the engine became Firefox, and that is worth stating rather than
// leaving to be discovered — the whole encryption story is gone, not disabled:
//   • Firefox keeps its cookies in <profile>/cookies.sqlite, table `moz_cookies`, and the value is
//     **plaintext**. There is no key to find, so the Chromium reader's `Local State` /
//     `os_crypt.encrypted_key` lookup, its DPAPI round-trip through a PowerShell subprocess, the
//     `v10` AES-256-GCM envelope, the 32-byte domain-binding prefix and the whole
//     **App-Bound Encryption** (`v20`) dead end have all been deleted rather than disabled.
//     Measured (Playwright's firefox-1543 / Firefox 155.0, and a stock Firefox profile has the same
//     shape): the table carries `id, originAttributes, name, value, host, path, expiry, …`, and
//     `host` is Chromium's `host_key` — including its leading-dot convention for a domain cookie,
//     which is why the pick-below still prefers the dotted row when a name appears twice.
//   • and there is no platform gate any more: the old `isSupported()` existed because only Windows
//     had DPAPI. Reading a SQLite file has no such requirement.
//
// Privacy boundary (unchanged):
//   • read-only, only for the given domains; no logging, nothing written to disk, never emitted
//     in reports/feeds
//   • the copied temporary store is deleted as soon as it has been used
//   • the plaintext is only assembled into a Cookie header inside this process's memory and sent
//     straight to the matching site
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFirefoxProfileDir, profilesUnder } from './browser-target.js';

/** The cookie store of one Firefox profile (Firefox keeps it at the profile root, with no per-profile subdir) */
const COOKIE_FILE = 'cookies.sqlite';

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

/** Whether this directory is a Firefox profile that has a cookie store */
function hasStore(p) {
  // Through the shared predicate, not `existsSync`: a real Firefox root carries a **zero-byte**
  // cookies.sqlite (this machine's %APPDATA%\Mozilla\Firefox has one), and an existence test would read that
  // placeholder instead of the profile inside the root.
  return isFirefoxProfileDir(p);
}

/**
 * profileDir may be:
 *   • a Firefox **profile** directory (what the picker writes), or
 *   • a Firefox install root — `%APPDATA%\Mozilla\Firefox`, the directory `profiles.ini` lives in, or
 *   • any directory whose immediate children are profiles.
 *
 * The expansion is `profilesUnder()` from server/src/browser-target.js rather than a second copy of the
 * profiles.ini parsing: the picker that *offers* these directories and this reader that *opens* one have
 * to agree about what a Firefox profile is, and two parsers would drift on the first change.
 */
function resolveProfile(profileDir) {
  const dir = path.resolve(profileDir);
  if (hasStore(dir)) return { root: path.dirname(dir), profile: dir };
  const candidates = profilesUnder(dir) ?? [];
  // Prefer a profile that really has a cookie store: the ini may also name a profile that has never
  // been opened, and answering from one of those would report "no cookies" about a store that is there.
  const withStore = candidates.find((p) => hasStore(p));
  if (withStore) return { root: dir, profile: withStore };
  if (candidates.length) return { root: dir, profile: candidates[0] };
  return { root: dir, profile: null };
}

/** Copy -wal/-shm along with it so the SQLite view is consistent */
function copyFamily(src, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, COOKIE_FILE);
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
 * @param {string} profileDir a Firefox profile dir, or a Firefox root carrying profiles.ini
 * @param {string[]} domains  e.g. ['reddit.com', 'www.reddit.com']
 * @returns {Promise<{ok:boolean, error?:string, warning?:string, cookieHeader?:string, names?:string[], profile?:string}>}
 */
export async function readBrowserCookies(profileDir, domains) {
  if (!profileDir) return { ok: false, error: '未配置浏览器 profileDir / profileDir is empty' };

  const { profile } = resolveProfile(profileDir);
  if (!profile) {
    return {
      ok: false,
      error: `找不到 Firefox cookie 库 / no Firefox cookie store (${COOKIE_FILE}) under ${profileDir}`,
      // Named as a distinguishable state rather than folded into "no cookies": a Chromium profile dir
      // (or any other directory) is a different fact from "this profile is not signed in", and the
      // caller can say which one it is.
      reason: 'no-firefox-profile',
    };
  }

  const db = path.join(profile, COOKIE_FILE);
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return { ok: false, error: '需要 Node 22.5+ 的 node:sqlite / needs Node 22.5+', profile };

  // Where the cookie-store copy lands: VML_TEMP_DIR first (written by index.js from
  // config.paths.tempDir, which is what enforces the hard rule of "no temp files on the C: drive"),
  // falling back to the system temp dir when unset.
  const tmpDir = fs.mkdtempSync(path.join(tempRoot(), 'vml-cookies-'));
  let rows = [];
  try {
    const copied = copyFamily(db, tmpDir);
    const conn = new DatabaseSync(copied, { readOnly: true });
    try {
      const where = domains.map(() => 'host LIKE ?').join(' OR ');
      rows = conn
        .prepare(`SELECT host, name, value FROM moz_cookies WHERE ${where}`)
        .all(...domains.map((d) => `%${d}%`));
    } finally {
      conn.close();
    }
  } catch (e) {
    return { ok: false, error: `读 cookie 库失败 / cannot read cookie store: ${e.message}`, profile };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!rows.length) {
    return { ok: false, error: '该 profile 里没有目标域名的 cookie（可能没登录）', profile };
  }

  const byName = new Map();
  for (const r of rows) {
    const value = r.value === null || r.value === undefined ? '' : String(r.value);
    if (!value) continue;
    // The same name may appear under several hosts; prefer the one whose host starts with a dot (it
    // applies to subdomains too)
    const prev = byName.get(r.name);
    if (!prev || (String(r.host).startsWith('.') && !prev.host.startsWith('.'))) {
      byName.set(r.name, { value, host: String(r.host) });
    }
  }

  if (!byName.size) return { ok: false, error: '目标域名的 cookie 都是空值 / every matching cookie had an empty value', profile };

  const names = [...byName.keys()];
  return {
    ok: true,
    profile,
    names,
    cookieHeader: names.map((n) => `${n}=${byName.get(n).value}`).join('; '),
  };
}
