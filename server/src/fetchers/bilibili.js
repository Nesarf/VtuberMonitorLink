// fetchers/bilibili.js — bilibili dynamics fetching
//
// Measured conclusions (they are why this file is written the way it is):
//   - api.bilibili.com **works on a direct connection; going through a proxy is what gets you risk-controlled** (412 / -352).
//     So everything here uses net.js's direct mode, unless a source explicitly asks for a proxy.
//   - A bare request gets blocked with 412; you first have to fetch buvid3/buvid4 (finger/spi) and send them as cookies.
//   - x/polymer/web-dynamic/v1/feed/space (full dynamics with images) is risk-controlled extremely hard:
//     without a login it is reliably -352; only reusing a login state gets it.
//   - x/polymer/web-dynamic/v1/opus/feed/space (image + text dynamics) **needs no login and no wbi**,
//     reliably returns 20 entries with the body / like count / opus link -- this is the main path.
//   - Order for obtaining a login state: cookie carried by the source -> configured browser profile -> browser rendering as fallback.
import { netFetch, resolveProxyMode } from '../net.js';
import { wbiFetch } from '../wbi.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const API = 'https://api.bilibili.com';

/** buvid bootstrap result, cached per process so that every source does not have to hit spi */
let buvid = null;

function baseHeaders(uid) {
  return {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: uid ? `https://space.bilibili.com/${uid}/dynamic` : 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
  };
}

/** Fetch (and cache) buvid3/buvid4 -- without them even the public endpoints answer 412 */
export async function ensureBuvid(ctx) {
  if (buvid) return buvid;
  const r = await netFetch(`${API}/x/frontend/finger/spi`, { headers: baseHeaders(), signal: AbortSignal.timeout(20000) }, {
    cfg: ctx.cfg,
    mode: 'direct',
  });
  const j = await r.json().catch(() => null);
  const d = j?.data ?? {};
  buvid = { b3: d.b_3 ?? '', b4: d.b_4 ?? '' };
  ctx.log?.info(`bilibili buvid fetch ${buvid.b3 ? 'ok' : 'failed'}`);
  return buvid;
}

function cookieHeader(bv, extra) {
  const parts = [`buvid3=${bv.b3}`, `buvid4=${bv.b4}`, `b_nut=${Math.floor(Date.now() / 1000)}`];
  if (extra) parts.push(String(extra).trim().replace(/;\s*$/, ''));
  return parts.join('; ');
}

/** Normalize opus/feed/space entries into intel items */
function normalizeOpus(items, uid) {
  return items.map((it) => {
    const url = it.jump_url ? (it.jump_url.startsWith('//') ? `https:${it.jump_url}` : it.jump_url) : `https://www.bilibili.com/opus/${it.opus_id}`;
    return {
      id: `bili-opus-${it.opus_id}`,
      kind: 'bilibili-opus',
      sourceUid: String(uid),
      title: '',
      text: String(it.content ?? '').trim(),
      url,
      time: it.pub_time && it.pub_time !== '0' ? new Date(Number(it.pub_time) * 1000).toISOString() : '',
      images: it.cover ? [it.cover] : [],
      stats: { like: it.stat?.like ?? '', view: it.stat?.view ?? '' },
      badge: it.badge ?? null,
    };
  });
}

/**
 * Image + text dynamics (the main path, no login needed)
 * GET /x/polymer/web-dynamic/v1/opus/feed/space?host_mid=<uid>&page=1&type=all
 */
export async function fetchBilibiliOpus(source, ctx) {
  const uid = String(source.uid ?? '').trim();
  if (!uid) throw new Error('bilibili 来源缺少 uid / missing uid');
  const bv = await ensureBuvid(ctx);
  const page = Number(ctx.cfg?.bilibili?.pages ?? 1) || 1;
  const items = [];
  const errors = [];

  for (let p = 1; p <= page; p++) {
    const url = `${API}/x/polymer/web-dynamic/v1/opus/feed/space?host_mid=${encodeURIComponent(uid)}&page=${p}&type=all`;
    let j = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await netFetch(
        url,
        { headers: { ...baseHeaders(uid), cookie: cookieHeader(bv, source.cookie) }, signal: AbortSignal.timeout(25000) },
        { cfg: ctx.cfg, subject: source }
      );
      j = await r.json().catch(() => null);
      if (j?.code === 0) break;
      // -412 and -352 are both risk control; back off deliberately before retrying
      if (attempt < 3) await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
    if (j?.code !== 0) {
      errors.push(`page ${p}: code=${j?.code ?? 'bad-json'} ${j?.message ?? ''}`);
      break;
    }
    items.push(...normalizeOpus(j.data?.items ?? [], uid));
    if (!j.data?.has_more) break;
  }

  if (!items.length && errors.length) throw new Error(`B 站风控拦截 / blocked: ${errors.join('; ')}`);

  ctx.log?.info(`bilibili opus ${uid}: ${items.length} dynamics${errors.length ? ` (${errors[0]})` : ''}`);
  return {
    ok: true,
    ext: 'json',
    content: JSON.stringify({ kind: 'bilibili-opus', uid, items }, null, 1),
    items,
    note: errors.length ? errors.join('; ') : undefined,
    followers: await fetchFollowers(uid, ctx, bv).catch(() => null),
  };
}

/** Follower count (for tracking audience growth) / follower count for growth tracking */
export async function fetchFollowers(uid, ctx, bv) {
  const b = bv ?? (await ensureBuvid(ctx));
  const r = await netFetch(
    `${API}/x/relation/stat?vmid=${encodeURIComponent(uid)}`,
    { headers: { ...baseHeaders(uid), cookie: cookieHeader(b) }, signal: AbortSignal.timeout(20000) },
    { cfg: ctx.cfg, mode: 'direct' }
  );
  const j = await r.json().catch(() => null);
  if (j?.code !== 0) return null;
  return { follower: Number(j.data?.follower ?? 0), following: Number(j.data?.following ?? 0) };
}

/**
 * Get one usable login state.
 * Order: cookie carried by the source -> read-only extraction from the configured browser profile -> give up.
 * The extraction is the "copy the cookie store, then decrypt" route, so **it is fine for the browser to be open**.
 */
export async function resolveLogin(source, ctx) {
  if (source.cookie) return { cookie: source.cookie, via: 'inline' };
  const profileDir = source.profileDir || ctx.cfg?.browser?.profileDir;
  if (!profileDir) return { cookie: null, via: 'none', reason: '未配置浏览器 profileDir' };
  const { readBrowserCookies } = await import('../cookies.js');
  const r = await readBrowserCookies(profileDir, ['bilibili.com']);
  if (!r.ok) {
    ctx.log?.info(`bilibili login unavailable / no login: ${r.error}`);
    return { cookie: null, via: 'none', reason: r.error };
  }
  const hasSession = (r.names ?? []).includes('SESSDATA');
  ctx.log?.info(`bilibili login loaded (${r.names.length} cookies${hasSession ? ', with SESSDATA' : ', no SESSDATA'})`);
  return { cookie: r.cookieHeader, via: 'profile', hasSession, warning: r.warning, profile: r.profile };
}

/**
 * Normalize feed/space entries (images, relative time and video title included).
 *
 * Measured points:
 *   - features=itemOpusStyle is mandatory -- without it, a new-style image + text dynamic has major
 *     MAJOR_TYPE_DRAW with empty items and a null desc (the whole body is lost).
 *     With it the type becomes MAJOR_TYPE_OPUS, the body sits in major.opus.summary.text,
 *     and the **image count and URLs are completely unchanged** (verified by comparison).
 *   - major.type is the field that actually discriminates (it.type is sometimes unreliable).
 *   - For a forwarded dynamic (DYNAMIC_TYPE_FORWARD) the body lives in the forwarded orig and has to be picked up as well.
 */
function imagesOf(md) {
  const major = md?.major ?? {};
  return [
    ...(major.draw?.items ?? []).map((d) => d?.src).filter(Boolean),
    ...(major.opus?.pics ?? []).map((p) => p?.url).filter(Boolean),
  ];
}

function textOf(md) {
  if (!md) return '';
  const major = md.major ?? {};
  return String(md.desc?.text ?? major.opus?.summary?.text ?? major.draw?.title ?? '').trim();
}

function normalizeDynamic(items, uid) {
  return items.map((it) => {
    const md = it.modules?.module_dynamic ?? {};
    const major = md.major ?? {};
    const author = it.modules?.module_author ?? {};
    const stat = it.modules?.module_stat ?? {};

    const own = textOf(md);
    const origMd = it.orig?.modules?.module_dynamic;
    const origAuthor = it.orig?.modules?.module_author?.name ?? '';
    const origText = textOf(origMd);
    const text = [own, origText ? `//@${origAuthor}: ${origText}` : ''].filter(Boolean).join('\n').trim();

    const images = [...new Set([...imagesOf(md), ...imagesOf(origMd)])].slice(0, 12);

    const archive = major.archive ?? it.orig?.modules?.module_dynamic?.major?.archive;
    const jump = archive?.jump_url
      ? archive.jump_url.startsWith('//')
        ? `https:${archive.jump_url}`
        : archive.jump_url
      : '';
    const url = it.id_str ? `https://t.bilibili.com/${it.id_str}` : jump || `https://space.bilibili.com/${uid}/dynamic`;

    return {
      id: `bili-dyn-${it.id_str ?? Math.random().toString(36).slice(2)}`,
      kind: 'bilibili-dynamic',
      sourceUid: String(uid),
      title: archive?.title ?? '',
      text,
      url,
      time: author.pub_time ?? '',
      images,
      stats: { like: stat.like?.count ?? '', comment: stat.comment?.count ?? '', forward: stat.forward?.count ?? '' },
      extra: {
        type: it.type,
        majorType: major.type,
        author: author.name ?? '',
        forwarded: !!it.orig,
      },
    };
  });
}

/**
 * Full dynamics with a login state: call the JSON endpoint directly and get the body + images + publish time.
 * This is the preferred path -- the data is clean, and **the user's browser does not have to be closed**.
 * Only when no login state is available does it fall back to browser rendering.
 */
export async function fetchBilibiliDynamic(source, ctx) {
  const uid = String(source.uid ?? '').trim();
  if (!uid) throw new Error('bilibili 来源缺少 uid / missing uid');
  const login = await resolveLogin(source, ctx);

  if (login.cookie) {
    const bv = await ensureBuvid(ctx);
    // WBI signature: this endpoint is risk-controlled extremely hard (measured: without a signature it is
    // reliably -352), and "having a login state" is not enough -- the signature is what gets past risk
    // control. The signature is appended to the query.
    const url = `${API}/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}&timezone_offset=-480&platform=web&features=itemOpusStyle`;
    let j = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await wbiFetch(ctx.cfg, url, {
        headers: {
          ...baseHeaders(uid),
          cookie: cookieHeader(bv, login.cookie),
        },
        log: ctx.log ?? null,
      });
      j = r.json ?? null;
      if (j?.code === 0) break;
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1500));
    }
    if (j?.code === 0) {
      const items = normalizeDynamic(j.data?.items ?? [], uid);
      ctx.log?.info(`bilibili full dynamics ${uid}: ${items.length} entries (logged-in API)`);
      return {
        ok: true,
        ext: 'json',
        content: JSON.stringify({ kind: 'bilibili-dynamic', uid, via: 'cookie-api', items }, null, 1),
        items,
        note: login.warning,
        followers: await fetchFollowers(uid, ctx, bv).catch(() => null),
      };
    }
    ctx.log?.warn(`bilibili logged-in API returned code=${j?.code} ${j?.message ?? ''}, falling back to browser rendering`);
    if (login.via === 'inline') {
      throw new Error(`B 站接口拒绝 / code=${j?.code} ${j?.message ?? ''}（cookie 可能已失效）`);
    }
  } else {
    ctx.log?.warn(`bilibili has no login (${login.reason ?? 'unknown'}), going through browser rendering: ${source.profileDir || ctx.cfg?.browser?.profileDir ? '' : 'with no profile configured this will most likely raise a slider captcha'}`);
  }

  return fetchBilibiliDynamicRendered(source, ctx, login);
}

/** Fallback: render the dynamics page with Playwright (requires the target browser to be closed) */
export async function fetchBilibiliDynamicRendered(source, ctx, login = {}) {
  const uid = String(source.uid ?? '').trim();
  if (!uid) throw new Error('bilibili 来源缺少 uid / missing uid');
  const { chromium } = await import('playwright');
  const bcfg = ctx.cfg?.browser ?? {};
  const proxy = resolveProxyMode(ctx.cfg, source) === 'proxy' ? (ctx.cfg?.proxy?.url ?? '') : '';

  const launch = { headless: bcfg.headless !== false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (source.executablePath || bcfg.executablePath) launch.executablePath = source.executablePath || bcfg.executablePath;
  const profileDir = source.profileDir || bcfg.profileDir;

  let context = null;
  let browser = null;
  const watchdog = setTimeout(() => {
    ctx.log?.error('bilibili dynamic rendering: hard timeout');
    process.exitCode = 3;
  }, bcfg.hardTimeoutMs ?? 90000);

  try {
    if (profileDir) {
      context = await chromium.launchPersistentContext(profileDir, {
        ...launch,
        ...(proxy ? { proxy: { server: proxy } } : {}),
        viewport: { width: 1400, height: 1000 },
      });
    } else {
      browser = await chromium.launch(launch);
      context = await browser.newContext({
        userAgent: UA,
        locale: 'zh-CN',
        viewport: { width: 1400, height: 1000 },
        ...(proxy ? { proxy: { server: proxy } } : {}),
      });
    }
    const page = context.pages()?.[0] ?? (await context.newPage());
    await page.goto(`https://space.bilibili.com/${uid}/dynamic`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(bcfg.waitMs ?? 6000);

    const picked = await page.evaluate(() => {
      const out = [];
      const cards = document.querySelectorAll('.bili-dyn-list__item, .bili-dyn-item');
      for (const c of cards) {
        const text = (c.querySelector('.bili-rich-text__content, .bili-dyn-content, [class*=rich-text]')?.innerText ?? '').trim();
        const link = c.querySelector('a[href*="/opus/"], a[href*="t.bilibili.com"]')?.href ?? '';
        const time = c.querySelector('.bili-dyn-time')?.innerText?.trim() ?? '';
        const pics = [...c.querySelectorAll('img')]
          .map((i) => i.getAttribute('data-src') || i.src || '')
          .filter((s) => s && s.includes('hdslb.com') && !s.includes('/face/'));
        if (text || pics.length) out.push({ text, link, time, images: [...new Set(pics)].slice(0, 9) });
      }
      return {
        cards: out,
        captcha: /请在下图依次点击|滑动验证|安全验证/.test(document.body ? document.body.innerText : ''),
      };
    });

    if (!picked.cards.length && picked.captcha) {
      throw new Error('B 站要求验证码（未登录或登录态失效）/ captcha required — 请在「设置」里指定已登录 B 站的浏览器 profile');
    }

    const items = picked.cards.map((c, i) => ({
      id: `bili-dyn-${uid}-${i}-${c.link || c.text.slice(0, 12)}`,
      kind: 'bilibili-dynamic',
      sourceUid: uid,
      title: '',
      text: c.text,
      url: c.link || `https://space.bilibili.com/${uid}/dynamic`,
      time: c.time,
      images: c.images,
      stats: {},
    }));

    ctx.log?.info(`bilibili dynamic ${uid}: ${items.length} entries (browser rendering)`);
    return {
      ok: true,
      ext: 'json',
      content: JSON.stringify({ kind: 'bilibili-dynamic', uid, items }, null, 1),
      items,
      followers: await fetchFollowers(uid, ctx).catch(() => null),
    };
  } catch (err) {
    // Reusing a profile requires that browser to be closed; translate Playwright's raw error into plain words
    const m = String(err?.message ?? '');
    if (/ProcessSingleton|is already (running|in use)|SingletonLock|profile.*lock/i.test(m)) {
      throw new Error(
        '该浏览器正在运行，profile 被锁定 / the browser is running and its profile is locked —— 要么关掉它，' +
          '要么在「设置 → 浏览器」里把 profileDir 指向另一个已登录 B 站的浏览器（只读提取 cookie 不需要关浏览器）'
      );
    }
    throw err;
  } finally {
    await Promise.race([
      (async () => {
        try {
          await context?.close();
        } catch {}
        try {
          await browser?.close();
        } catch {}
      })(),
      new Promise((r) => setTimeout(r, 6000)),
    ]);
    clearTimeout(watchdog);
  }
}
