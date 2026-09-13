// wbi.js — bilibili WBI request signing
//
// Background (measured): unsigned, `x/v1/dm/getDanmuInfo` reliably returns **-352** (risk control),
// and it does so even with a login session — that is, "having a cookie" is not enough,
// **a signature is also required**. This is why the danmaku feature was stuck for so long.
//
// The WBI algorithm has three parts:
//   1) take img_url / sub_url from the nav endpoint, keep each filename (minus extension) and
//      concatenate them into the 64-character raw key
//   2) reorder it through a fixed 64-slot permutation table and take the **first 32 characters**
//      as the mixin key
//   3) sort the parameters by key → filter !'()* out of the values → append the query to the
//      mixin key → md5 = w_rid; and carry wts (a second-resolution timestamp) along
//
// Three things that are easy to get wrong, all handled here:
//   · the sort must be lexicographic by **parameter name** (not insertion order)
//   · the filtered characters are exactly `!'()*`, it is not "strip all punctuation"
//   · the key rotates daily — hence the cache plus **one forced refresh-and-retry** on
//     signature-class errors
import crypto from 'node:crypto';
import { netFetch } from './net.js';

/** The fixed 64-slot permutation table (public and constant) */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

/** Take the key out of a URL (`.../7cd084941338484aae1ad9425b84077c.png` → `7cd084941338484aae1ad9425b84077c`) */
export function keyFromUrl(url) {
  const m = /([0-9a-fA-F]{32})\.(?:png|jpg|jpeg|webp)$/.exec(String(url ?? ''));
  return m ? m[1] : '';
}

/** Derive the mixin key from img_key + sub_key (first 32 characters) */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  if (raw.length < 64) return '';
  let out = '';
  for (let i = 0; i < 32; i++) out += raw[MIXIN_KEY_ENC_TAB[i]];
  return out;
}

/** Characters to filter out of the values (the official implementation does this; it is not "strip all punctuation") */
const FILTER = /[!'()*]/g;

/** Sign the parameters and assemble them into a query string */
export function signQuery(params, mixin, wts = Math.floor(Date.now() / 1000)) {
  const withWts = { ...params, wts: String(wts) };
  const sorted = Object.keys(withWts)
    .sort()
    .map((k) => {
      const v = String(withWts[k] ?? '').replace(FILTER, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(sorted + mixin).digest('hex');
  return { query: `${sorted}&w_rid=${wRid}`, w_rid: wRid, wts };
}

/** Add a signature to a URL (keeping the existing query) */
export function signUrl(url, mixin, wts) {
  const u = new URL(url);
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  const { query } = signQuery(params, mixin, wts);
  return `${u.origin}${u.pathname}?${query}`;
}

// ───────────────────────────────────────────── key acquisition and caching

const cache = { img: '', sub: '', mixin: '', at: 0 };
export const KEY_TTL_MS = 6 * 3600 * 1000; // the key rotates daily; a 6-hour cache is plenty

export function clearWbiCache() {
  cache.img = '';
  cache.sub = '';
  cache.mixin = '';
  cache.at = 0;
}

/**
 * Fetch the WBI key (with caching).
 * The nav endpoint **returns wbi_img even anonymously**, so signing does not depend on a login
 * session — and that matters: it means the signing capability can be verified on its own,
 * without an account first.
 */
export async function getWbiKeys(cfg, { force = false, log = null, headers = {} } = {}) {
  if (!force && cache.mixin && Date.now() - cache.at < KEY_TTL_MS) {
    return { ok: true, ...cache, cached: true };
  }
  try {
    const res = await netFetch(
      'https://api.bilibili.com/x/web-interface/nav',
      {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://www.bilibili.com/', ...headers },
        signal: AbortSignal.timeout(15000),
      },
      { cfg, mode: 'direct' }
    );
    const j = await res.json();
    const img = keyFromUrl(j?.data?.wbi_img?.img_url);
    const sub = keyFromUrl(j?.data?.wbi_img?.sub_url);
    if (!img || !sub) return { ok: false, error: 'nav 没有返回 wbi_img（接口结构变了？）', raw: j?.code };
    cache.img = img;
    cache.sub = sub;
    cache.mixin = mixinKey(img, sub);
    cache.at = Date.now();
    log?.info?.(`wbi keys refreshed (img=${img.slice(0, 8)}… sub=${sub.slice(0, 8)}…)`);
    return { ok: true, ...cache, cached: false };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}

/** Error codes that require re-fetching the key (risk control / invalid signature) */
export const SIGN_ERROR_CODES = new Set([-352, -403, -412]);

/**
 * Signed POST (form body).
 *
 * Why a separate one: many bilibili write operations are POST + form body, while the signature
 * belongs on the **query** (`w_rid`/`wts` go into the URL) and the body stays as it is.
 * Mixing the two is a very easy mistake to make — if signature parameters end up in the body,
 * the server treats the signature as invalid.
 */
export async function wbiPost(cfg, url, { params = {}, body = '', headers = {}, log = null, mode = 'direct', retry = true } = {}) {
  const k = await getWbiKeys(cfg, { log, headers });
  if (!k.ok) return { ok: false, error: k.error, stage: 'keys' };
  const u = new URL(url);
  for (const [kk, vv] of Object.entries(params)) u.searchParams.set(kk, String(vv));

  const doFetch = async (target) =>
    netFetch(
      target,
      {
        method: 'POST',
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://www.bilibili.com/', ...headers },
        body: typeof body === 'string' ? body : String(body ?? ''),
        signal: AbortSignal.timeout(20000),
      },
      { cfg, mode }
    );

  try {
    let res = await doFetch(signUrl(u.toString(), k.mixin));
    // Read the body once as text: `res.json()` alone throws away the raw reply, and the caller
    // (danmaku.js) wants it to show what the server actually said when it is not JSON at all.
    // It used to slice a `text` binding that never existed here, so a non-JSON reply surfaced as
    // the useless error "text is not defined" instead of the real body (BUGS #68).
    let text = await res.text().catch(() => '');
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch (e) {
      j = null;
    }
    if (retry && j && SIGN_ERROR_CODES.has(Number(j.code))) {
      const fresh = await getWbiKeys(cfg, { force: true, log, headers });
      if (fresh.ok) {
        res = await doFetch(signUrl(u.toString(), fresh.mixin));
        text = await res.text().catch(() => '');
        try {
          j = text ? JSON.parse(text) : null;
        } catch (e) {
          j = null;
        }
        return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j, text, retried: true };
      }
    }
    return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j, text };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message, stage: 'fetch' };
  }
}


/**
 * Signed request: sign first, and on a signature-class error **force a key refresh and retry once**.
 * This is mandatory: the key rotates daily, so a long-running process is guaranteed to hit an
 * expired key at some point.
 */
export async function wbiFetch(cfg, url, { params = {}, headers = {}, log = null, mode = 'direct', retry = true } = {}) {
  const k = await getWbiKeys(cfg, { log, headers });
  if (!k.ok) return { ok: false, error: k.error, stage: 'keys' };
  const u = new URL(url);
  for (const [kk, vv] of Object.entries(params)) u.searchParams.set(kk, String(vv));
  const signed = signUrl(u.toString(), k.mixin);

  const doFetch = async (target) =>
    netFetch(target, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://www.bilibili.com/', ...headers },
      signal: AbortSignal.timeout(20000),
    }, { cfg, mode });

  try {
    let res = await doFetch(signed);
    let j = await res.json().catch(() => null);
    if (retry && j && SIGN_ERROR_CODES.has(Number(j.code))) {
      // The key may already have rotated → force a refresh and try once more
      const fresh = await getWbiKeys(cfg, { force: true, log, headers });
      if (fresh.ok) {
        const retryUrl = signUrl(u.toString(), fresh.mixin);
        res = await doFetch(retryUrl);
        j = await res.json().catch(() => null);
        return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j, retried: true, signed: retryUrl };
      }
    }
    return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j, signed };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message, stage: 'fetch' };
  }
}
