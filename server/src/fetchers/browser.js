// fetchers/browser.js — 浏览器渲染抓取（Playwright）
// 关键点（都来自实战踩坑）：
//  1) 浏览器内核可配置：bundled（随包 Chromium）/ system（系统已装）/ custom（用户指定路径）
//  2) 复用登录态需要 profileDir；此时**该浏览器必须处于关闭状态**，否则 profile 被锁
//  3) SPA 页面会让 close() 卡住 —— 收尾限时 + 硬性看门狗，确保进程一定退出
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { playwrightProxy } from '../net.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 常见系统浏览器的安装路径候选 / candidate paths of common system browsers */
function candidates() {
  const home = os.homedir();
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  if (process.platform === 'win32') {
    return [
      ['Chrome', path.join(pf, 'Google/Chrome/Application/chrome.exe')],
      ['Chrome (x86)', path.join(pf86, 'Google/Chrome/Application/chrome.exe')],
      ['Edge', path.join(pf86, 'Microsoft/Edge/Application/msedge.exe')],
      ['Edge', path.join(pf, 'Microsoft/Edge/Application/msedge.exe')],
      ['Opera', path.join(home, 'AppData/Local/Programs/Opera/opera.exe')],
      ['Brave', path.join(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe')],
      ['Vivaldi', path.join(local, 'Vivaldi/Application/vivaldi.exe')],
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ];
  }
  return [
    ['Chrome', '/usr/bin/google-chrome'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Edge', '/usr/bin/microsoft-edge'],
  ];
}

/** 探测系统已装浏览器 / detect installed system browsers */
export function detectBrowsers() {
  return candidates()
    .filter(([, p]) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    })
    .map(([name, executablePath]) => ({ name, executablePath }));
}

/** 解析启动参数 / resolve launch options from config */
export function resolveLaunch(browserCfg = {}) {
  const opts = { headless: browserCfg.headless !== false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (browserCfg.mode === 'system' || browserCfg.mode === 'custom') {
    if (!browserCfg.executablePath) {
      throw new Error(
        browserCfg.mode === 'system'
          ? '未选择系统浏览器 / no system browser selected'
          : '未填写浏览器路径 / custom browser path is empty'
      );
    }
    if (!fs.existsSync(browserCfg.executablePath)) {
      throw new Error(`浏览器不存在 / browser not found: ${browserCfg.executablePath}`);
    }
    opts.executablePath = browserCfg.executablePath;
  }
  // mode === 'bundled' 时交给 Playwright 自带的 Chromium
  return opts;
}

/** 渲染一个 URL，返回正文文本 / render a URL and return its text */
export async function renderUrl(url, cfg, { log, waitMs, mode = 'text' } = {}) {
  const bcfg = cfg?.browser ?? {};
  const hardMs = bcfg.hardTimeoutMs ?? 90000;
  const watchdog = setTimeout(() => {
    log?.error(`hard timeout ${hardMs}ms — force exit / 硬性超时`);
    process.exitCode = 3;
  }, hardMs);

  let browser = null;
  let context = null;
  try {
    const launchOpts = resolveLaunch(bcfg);
    // 浏览器同样需要走代理（实测：直连被阻断的环境下浏览器也访问不到目标站）
    const proxy = playwrightProxy(cfg);
    if (bcfg.profileDir) {
      // 复用登录态：要求该浏览器已关闭
      if (!fs.existsSync(bcfg.profileDir)) throw new Error(`profileDir 不存在 / not found: ${bcfg.profileDir}`);
      context = await chromium.launchPersistentContext(bcfg.profileDir, {
        ...launchOpts,
        ...(proxy ? { proxy } : {}),
        viewport: { width: 1280, height: 900 },
      });
    } else {
      browser = await chromium.launch(launchOpts);
      context = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280, height: 900 },
        ...(proxy ? { proxy } : {}),
      });
    }

    const page = context.pages()?.[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(waitMs ?? bcfg.waitMs ?? 6000);
    const content =
      mode === 'html'
        ? await page.content()
        : await page.evaluate(() => (document.body ? document.body.innerText : ''));

    // 站点级错误识别（登录墙 / 反爬拦截），让上层能明确告知用户
    const blocked = /login|sign in|登录|安全验证|blocked by network security|verify you are human/i.test(
      content.slice(0, 400)
    );
    log?.info(`render ok ${content.length}B${blocked ? ' (possible wall/login page)' : ''} — ${url}`);
    return { ok: true, content, ext: mode === 'html' ? 'html' : 'txt', blocked, url };
  } catch (err) {
    log?.error(`render failed — ${url} :: ${err.message}`);
    return { ok: false, error: err.message, url };
  } finally {
    // 收尾限时：SPA 页面会让 close() 卡死，绝不无限等
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

export async function fetchBrowser(source, ctx) {
  return renderUrl(source.url, ctx.cfg, { log: ctx.log, waitMs: ctx.cfg?.browser?.waitMs });
}
