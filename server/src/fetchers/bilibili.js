// fetchers/bilibili.js — B 站动态抓取
//
// 实测结论（决定了本文件为什么要写成这样）：
//   • api.bilibili.com **直连可用，走代理反而被风控**（412 / -352）。
//     所以这里一律用 net.js 的 direct 模式，除非来源显式要求走代理。
//   • 裸请求会被 412 拦，必须先取一次 buvid3/buvid4（finger/spi）当 cookie。
//   • x/polymer/web-dynamic/v1/feed/space（带配图的完整动态）风控极严，
//     未登录基本稳定 -352；只有复用登录态才拿得到。
//   • x/polymer/web-dynamic/v1/opus/feed/space（图文动态）**无需登录、无需 wbi**，
//     稳定返回 20 条，含正文 / 点赞数 / opus 链接 —— 这是主力路径。
//   • 登录态的取值顺序：来源自带 cookie → 配置的浏览器 profile → 浏览器渲染兜底。
import { netFetch, resolveProxyMode } from '../net.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const API = 'https://api.bilibili.com';

/** buvid 引导结果按进程缓存，避免每个来源都打一次 spi */
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

/** 取（并缓存）buvid3/buvid4 —— 没有它连公开接口都会被 412 */
export async function ensureBuvid(ctx) {
  if (buvid) return buvid;
  const r = await netFetch(`${API}/x/frontend/finger/spi`, { headers: baseHeaders(), signal: AbortSignal.timeout(20000) }, {
    cfg: ctx.cfg,
    mode: 'direct',
  });
  const j = await r.json().catch(() => null);
  const d = j?.data ?? {};
  buvid = { b3: d.b_3 ?? '', b4: d.b_4 ?? '' };
  ctx.log?.info(`bilibili buvid 获取 ${buvid.b3 ? 'ok' : '失败'}`);
  return buvid;
}

function cookieHeader(bv, extra) {
  const parts = [`buvid3=${bv.b3}`, `buvid4=${bv.b4}`, `b_nut=${Math.floor(Date.now() / 1000)}`];
  if (extra) parts.push(String(extra).trim().replace(/;\s*$/, ''));
  return parts.join('; ');
}

/** 把 opus/feed/space 的条目规范化成情报条目 */
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
 * 图文动态（免登录主力路径）
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
      // -412 / -352 都是风控，主动退让再试
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

  ctx.log?.info(`bilibili opus ${uid}: ${items.length} 条动态${errors.length ? `（${errors[0]}）` : ''}`);
  return {
    ok: true,
    ext: 'json',
    content: JSON.stringify({ kind: 'bilibili-opus', uid, items }, null, 1),
    items,
    note: errors.length ? errors.join('; ') : undefined,
    followers: await fetchFollowers(uid, ctx, bv).catch(() => null),
  };
}

/** 粉丝数（用于关注量增长追踪）/ follower count for growth tracking */
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
 * 拿一份可用的登录态。
 * 顺序：来源自带 cookie → 从配置的浏览器 profile 只读提取 → 没有就算了。
 * 提取是「复制 cookie 库再解密」的路子，所以**浏览器开着也没关系**。
 */
export async function resolveLogin(source, ctx) {
  if (source.cookie) return { cookie: source.cookie, via: 'inline' };
  const profileDir = source.profileDir || ctx.cfg?.browser?.profileDir;
  if (!profileDir) return { cookie: null, via: 'none', reason: '未配置浏览器 profileDir' };
  const { readBrowserCookies } = await import('../cookies.js');
  const r = await readBrowserCookies(profileDir, ['bilibili.com']);
  if (!r.ok) {
    ctx.log?.info(`bilibili 登录态不可用 / no login: ${r.error}`);
    return { cookie: null, via: 'none', reason: r.error };
  }
  const hasSession = (r.names ?? []).includes('SESSDATA');
  ctx.log?.info(`bilibili 登录态已载入（${r.names.length} 个 cookie${hasSession ? '，含 SESSDATA' : '，无 SESSDATA'}）`);
  return { cookie: r.cookieHeader, via: 'profile', hasSession, warning: r.warning, profile: r.profile };
}

/**
 * 把 feed/space 的条目规范化（含配图、相对时间、视频标题）。
 *
 * 实测要点：
 *   • 必须带 features=itemOpusStyle —— 否则新版图文动态的 major 是
 *     MAJOR_TYPE_DRAW 且 items 为空、desc 为 null（正文全丢）。
 *     带上之后变成 MAJOR_TYPE_OPUS，正文在 major.opus.summary.text，
 *     而**配图数量与 URL 完全不变**（已对比验证）。
 *   • major.type 才是判别字段（it.type 有时不可靠）。
 *   • 转发动态（DYNAMIC_TYPE_FORWARD）正文在被转发的 orig 里，要一并取出来。
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
 * 登录态下的完整动态：直接调 JSON 接口，拿到正文 + 配图 + 发布时间。
 * 这是首选路径 —— 数据干净，而且**不需要关掉用户的浏览器**。
 * 拿不到登录态时才退回浏览器渲染。
 */
export async function fetchBilibiliDynamic(source, ctx) {
  const uid = String(source.uid ?? '').trim();
  if (!uid) throw new Error('bilibili 来源缺少 uid / missing uid');
  const login = await resolveLogin(source, ctx);

  if (login.cookie) {
    const bv = await ensureBuvid(ctx);
    const url = `${API}/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}&timezone_offset=-480&platform=web&features=itemOpusStyle`;
    let j = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await netFetch(
        url,
        {
          headers: {
            ...baseHeaders(uid),
            cookie: cookieHeader(bv, login.cookie),
          },
          signal: AbortSignal.timeout(25000),
        },
        { cfg: ctx.cfg, subject: source }
      );
      j = await r.json().catch(() => null);
      if (j?.code === 0) break;
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1500));
    }
    if (j?.code === 0) {
      const items = normalizeDynamic(j.data?.items ?? [], uid);
      ctx.log?.info(`bilibili 完整动态 ${uid}: ${items.length} 条（登录态接口）`);
      return {
        ok: true,
        ext: 'json',
        content: JSON.stringify({ kind: 'bilibili-dynamic', uid, via: 'cookie-api', items }, null, 1),
        items,
        note: login.warning,
        followers: await fetchFollowers(uid, ctx, bv).catch(() => null),
      };
    }
    ctx.log?.warn(`bilibili 登录态接口返回 code=${j?.code} ${j?.message ?? ''}，退回浏览器渲染`);
    if (login.via === 'inline') {
      throw new Error(`B 站接口拒绝 / code=${j?.code} ${j?.message ?? ''}（cookie 可能已失效）`);
    }
  } else {
    ctx.log?.warn(`bilibili 无登录态（${login.reason ?? 'unknown'}），走浏览器渲染：${source.profileDir || ctx.cfg?.browser?.profileDir ? '' : '未配置 profile 时多半会弹滑块验证'}`);
  }

  return fetchBilibiliDynamicRendered(source, ctx, login);
}

/** 兜底：用 Playwright 渲染动态页（需要目标浏览器处于关闭状态） */
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
    ctx.log?.error('bilibili 动态渲染硬超时 / hard timeout');
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

    ctx.log?.info(`bilibili dynamic ${uid}: ${items.length} 条（浏览器渲染）`);
    return {
      ok: true,
      ext: 'json',
      content: JSON.stringify({ kind: 'bilibili-dynamic', uid, items }, null, 1),
      items,
      followers: await fetchFollowers(uid, ctx).catch(() => null),
    };
  } catch (err) {
    // 复用 profile 要求该浏览器已关闭，把 Playwright 的原始报错翻译成人话
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
