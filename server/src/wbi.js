// wbi.js — B 站 WBI 签名 / bilibili WBI request signing
//
// 背景（实测）：不带签名的 `x/v1/dm/getDanmuInfo` 稳定返回 **-352**（风控），
// 带着登录态也一样 —— 也就是说「有 cookie」并不够，**还得有签名**。
// 这就是弹幕功能一直卡住的原因。
//
// WBI 的算法是三段：
//   1) 从 nav 接口拿 img_url / sub_url，各取文件名（去掉扩展名）拼成 64 字符的原始 key
//   2) 按一张固定的 64 位置换表重排，取**前 32 位**作为 mixin key
//   3) 参数按 key 排序 → 过滤掉值里的 !'()* → 拼 query + mixin key → md5 = w_rid；
//      同时带上 wts（秒级时间戳）
//
// 三个容易写错的地方，这里都处理了：
//   · 排序必须按**参数名**的字典序（不是插入顺序）
//   · 过滤字符是 `!'()*` 这五个，不是「去掉所有标点」
//   · key 每天会换 —— 所以要有缓存 + 遇到签名类错误时**强制刷新重试一次**
import crypto from 'node:crypto';
import { netFetch } from './net.js';

/** 固定的 64 位置换表（公开且恒定） */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

/** 从 URL 里取 key（`.../7cd084941338484aae1ad9425b84077c.png` → `7cd084941338484aae1ad9425b84077c`） */
export function keyFromUrl(url) {
  const m = /([0-9a-fA-F]{32})\.(?:png|jpg|jpeg|webp)$/.exec(String(url ?? ''));
  return m ? m[1] : '';
}

/** 从 img_key + sub_key 推导 mixin key（前 32 位） */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  if (raw.length < 64) return '';
  let out = '';
  for (let i = 0; i < 32; i++) out += raw[MIXIN_KEY_ENC_TAB[i]];
  return out;
}

/** 值里要过滤掉的字符（官方实现如此，不是「去掉所有标点」） */
const FILTER = /[!'()*]/g;

/** 把参数签名后拼成 query string */
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

/** 给一个 URL 加上签名（保留原有 query） */
export function signUrl(url, mixin, wts) {
  const u = new URL(url);
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  const { query } = signQuery(params, mixin, wts);
  return `${u.origin}${u.pathname}?${query}`;
}

// ───────────────────────────────────────────── key 获取与缓存

const cache = { img: '', sub: '', mixin: '', at: 0 };
export const KEY_TTL_MS = 6 * 3600 * 1000; // key 每天轮换，缓存 6 小时足够

export function clearWbiCache() {
  cache.img = '';
  cache.sub = '';
  cache.mixin = '';
  cache.at = 0;
}

/**
 * 取 WBI key（带缓存）。
 * nav 接口**匿名也能拿到 wbi_img**，所以签名不依赖登录态 —— 这点很重要：
 * 它意味着签名能力可以先独立验证，不必先有账号。
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
    log?.info?.(`WBI key 已更新 / wbi keys refreshed (img=${img.slice(0, 8)}… sub=${sub.slice(0, 8)}…)`);
    return { ok: true, ...cache, cached: false };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message };
  }
}

/** 需要重新取 key 的错误码（风控 / 签名失效） */
export const SIGN_ERROR_CODES = new Set([-352, -403, -412]);

/**
 * 带签名的 POST（表单体）。
 *
 * 为什么要单独一个：B 站的很多写操作是 POST + 表单体，而签名要加在 **query** 上
 * （`w_rid`/`wts` 进 URL），体保持原样。把两者混在一起是很容易写错的地方 ——
 * 体里塞了签名参数，服务端反而会认为签名不对。
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
    let j = await res.json().catch(() => null);
    if (retry && j && SIGN_ERROR_CODES.has(Number(j.code))) {
      const fresh = await getWbiKeys(cfg, { force: true, log, headers });
      if (fresh.ok) {
        res = await doFetch(signUrl(u.toString(), fresh.mixin));
        j = await res.json().catch(() => null);
        return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j, retried: true };
      }
    }
    return { ok: res.ok && Number(j?.code) === 0, status: res.status, json: j };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, error: cause ? `${e.message}(${cause})` : e.message, stage: 'fetch' };
  }
}


/**
 * 带签名的请求：先签名，遇到签名类错误就**强制换 key 重试一次**。
 * 这是必须的 —— key 每天轮换，长期运行的程序一定会碰到「key 过期」这一刻。
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
      // key 可能已经轮换 → 强制刷新后再试一次
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
