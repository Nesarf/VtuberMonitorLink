// thumbs.js — 站点缩略图 / site thumbnails
//
// 输入一个站点地址，按优先级取一张能代表它的图：
//   1. og:image / twitter:image（最能代表页面内容）
//   2. apple-touch-icon / <link rel="icon" sizes="…">（站点图标，通常比 favicon.ico 好看）
//   3. /favicon.ico（兜底）
//   4. 可选：用浏览器截图（最准，但重 —— 只在网页上点「截图」时才做）
//
// 抓到之后就缓存在本机 thumbs/ 目录，网页通过 /api/thumb 读本地缓存，
// 既不会再打站点、也绕开了防盗链与跨域。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { netFetch } from './net.js';
import { resolveDir } from './config.js';

const MAX_IMAGE_BYTES = 768 * 1024;
const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

export function thumbsDir(cfg) {
  const dir = path.join(resolveDir(cfg, 'feedsDir'), '..', 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function key(url, mode) {
  return crypto.createHash('sha1').update(`${mode}|${url}`).digest('hex').slice(0, 20);
}

/** 从各种地址推出「站点首页」：api.php / 带一堆查询参数的都归到 origin */
export function homepageOf(url) {
  try {
    const u = new URL(url);
    if (/api\.php$/i.test(u.pathname) || /api\.php$/i.test(url.split('?')[0])) return u.origin + '/';
    if (/\.(xml|json|rss|atom)$/i.test(u.pathname)) return u.origin + '/';
    // 动态页之类保留一层路径更有代表性
    if (u.pathname && u.pathname !== '/') return `${u.origin}${u.pathname.replace(/\/[^/]*$/, '/')}`;
    return u.origin + '/';
  } catch {
    return null;
  }
}

function parseHead(html, baseUrl) {
  const abs = (u) => {
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return null;
    }
  };
  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
      'i'
    );
    const m = re.exec(html);
    return m ? abs(m[1] ?? m[2]) : null;
  };
  const og = meta('og:image') ?? meta('twitter:image') ?? meta('og:image:url');
  if (og) return { url: og, kind: 'og-image' };

  // 图标：挑 sizes 最大的那个
  const icons = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)].map((m) => m[0]);
  const pick = icons
    .map((tag) => {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      const sizes = /sizes=["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
      const n = Number((/(\d+)x\d+/.exec(sizes) ?? [])[1] ?? 0);
      return href ? { url: abs(href), n, apple: /apple-touch/i.test(tag) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.n - a.n || Number(b.apple) - Number(a.apple));
  if (pick[0]?.url) return { url: pick[0].url, kind: pick[0].apple ? 'apple-touch-icon' : 'icon' };
  return null;
}

async function fetchImage(url, cfg, subject) {
  const res = await netFetch(
    url,
    {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    },
    { cfg, subject }
  );
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type];
  if (!ext) {
    // 有些站点 favicon 的 content-type 是 text/plain 或 octet-stream，按扩展名兜底
    const guess = (path.extname(new URL(url).pathname) || '.ico').slice(1).toLowerCase();
    if (!['ico', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(guess)) {
      return { ok: false, error: `不是图片 / not an image (${type || 'unknown'})` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片过大或为空' };
    return { ok: true, buf, ext: guess === 'jpeg' ? 'jpg' : guess, type };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, error: '空文件' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: `图片太大 ${buf.length}B` };
  return { ok: true, buf, ext, type };
}

/**
 * 取（并缓存）站点缩略图。
 * @param {string} siteUrl 站点地址（可以是 api.php、动态页、RSS 等）
 * @param {{cfg:object, subject?:object, refresh?:boolean, mode?:'auto'|'icon'|'screenshot', log?:object}} opts
 */
export async function getThumbnail(siteUrl, opts = {}) {
  const { cfg, subject } = opts;
  const mode = opts.mode === 'icon' || opts.mode === 'screenshot' ? opts.mode : 'auto';
  const home = homepageOf(siteUrl);
  if (!home) return { ok: false, error: `地址不合法 / bad URL: ${siteUrl}` };

  const dir = thumbsDir(cfg);
  const stem = key(siteUrl, mode);
  const metaPath = path.join(dir, `${stem}.json`);

  if (!opts.refresh) {
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.file && fs.existsSync(path.join(dir, meta.file))) {
          return { ...meta, cached: true };
        }
      }
    } catch {
      /* 缓存坏了就重取 */
    }
  }

  const save = (buf, ext, kind, sourceUrl) => {
    const file = `${stem}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    const meta = {
      ok: true,
      site: siteUrl,
      home,
      kind,
      sourceUrl,
      file,
      bytes: buf.length,
      at: new Date().toISOString(),
      cached: false,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1), 'utf8');
    return meta;
  };

  // ── 截图模式：最准，但最重
  if (mode === 'screenshot') {
    try {
      const png = await screenshot(cfg, subject, home, opts.log);
      return save(png, 'png', 'screenshot', home);
    } catch (e) {
      opts.log?.warn(`截图失败，退回图标 / screenshot failed: ${e.message}`);
    }
  }

  // ── og:image / icon：先看首页 <head>
  try {
    const res = await netFetch(
      home,
      {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      },
      { cfg, subject }
    );
    const type = String(res.headers.get('content-type') ?? '');
    if (res.ok && /html/i.test(type)) {
      const html = (await res.text()).slice(0, 300_000);
      const hit = mode === 'icon' ? null : parseHead(html, home);
      const iconOnly = hit ?? parseHead(html.replace(/og:image/gi, 'x-og-image'), home);
      const candidate = hit ?? (mode === 'icon' ? iconOnly : null);
      if (candidate?.url) {
        const img = await fetchImage(candidate.url, cfg, subject).catch((e) => ({ ok: false, error: e.message }));
        if (img.ok) return save(img.buf, img.ext, candidate.kind, candidate.url);
      }
      // og:image 拿不到时，退回 head 里的 icon
      if (mode !== 'icon') {
        const onlyIcon = parseHead(html.replace(/og:image|twitter:image|og:image:url/gi, 'x-none'), home);
        if (onlyIcon?.url) {
          const img = await fetchImage(onlyIcon.url, cfg, subject).catch((e) => ({ ok: false, error: e.message }));
          if (img.ok) return save(img.buf, img.ext, onlyIcon.kind, onlyIcon.url);
        }
      }
    } else {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    opts.log?.info(`首页取不到，试 favicon / homepage failed: ${e.message}`);
  }

  // ── 兜底：/favicon.ico
  try {
    const fav = new URL('/favicon.ico', home).href;
    const img = await fetchImage(fav, cfg, subject);
    if (img.ok) return save(img.buf, img.ext, 'favicon', fav);
    return { ok: false, error: img.error, site: siteUrl, home };
  } catch (e) {
    return { ok: false, error: e.message, site: siteUrl, home };
  }
}

/** 用 Playwright 截一张小图（只在用户主动要的时候才走这条路） */
export async function screenshot(cfg, subject, url, log) {
  const { chromium } = await import('playwright');
  const bcfg = cfg?.browser ?? {};
  const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const exe = subject?.executablePath || bcfg.executablePath;
  if (exe) launch.executablePath = exe;
  const proxyUrl = cfg?.proxy?.enabled && subject?.proxy !== 'direct' ? cfg.proxy.url : '';
  const browser = await chromium.launch(launch);
  const watchdog = setTimeout(() => {
    log?.error('截图硬超时 / screenshot hard timeout');
  }, bcfg.hardTimeoutMs ?? 60000);
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(bcfg.waitMs ?? 4000);
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 640 } });
    await ctx.close().catch(() => {});
    return Buffer.from(buf);
  } finally {
    clearTimeout(watchdog);
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  }
}

/** 读缓存里的图片（给 /api/thumb 用）/ read a cached thumbnail file */
export function readThumb(cfg, file) {
  const safe = path.basename(file);
  const p = path.join(thumbsDir(cfg), safe);
  if (!fs.existsSync(p)) return null;
  const ext = path.extname(safe).slice(1).toLowerCase();
  const type =
    Object.entries(EXT_BY_TYPE).find(([, e]) => e === ext)?.[0] ?? (ext === 'jpg' ? 'image/jpeg' : 'application/octet-stream');
  return { buf: fs.readFileSync(p), type };
}

export function listThumbs(cfg) {
  const dir = thumbsDir(cfg);
  return fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith('.json'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, mtime: st.mtime.toISOString() };
    });
}
