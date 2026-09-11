// index.js — 入口 / entry point
// 起本机服务 → 自动打开浏览器 → 启动内置调度器
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, resolveDir, APP_ROOT } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';
import { runOnce } from './runner.js';
import * as scheduler from './scheduler.js';
import { ensureDirs } from './reports.js';
import { applyProxy } from './net.js';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 43110);
const HOST = '127.0.0.1';

/**
 * 把配置里的路径写进进程环境变量，供子模块/第三方库读取。
 * - VML_TEMP_DIR：cookie 库副本等临时文件的落地目录（可避开 C 盘）
 * - PLAYWRIGHT_BROWSERS_PATH：浏览器内核位置（默认在 Windows 上是 C 盘的 %LOCALAPPDATA%）
 * 两个都留空时保持系统默认，便携发行版因此不会绑死任何机器路径。
 */
function applyPathEnv(c) {
  const temp = String(c?.paths?.tempDir ?? '').trim();
  if (temp) process.env.VML_TEMP_DIR = temp;
  const browsers = String(c?.paths?.browsersDir ?? '').trim();
  if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
}

let cfg = loadConfig();
ensureDirs(cfg);
applyPathEnv(cfg);
// 启动即按配置应用代理（直连被阻断的环境必须显式走代理）
await applyProxy(cfg);

const log = createLogger(path.join(resolveDir(cfg, 'logsDir'), 'server.log'));
log.info(`Vtuber's Monitor Link starting… (root: ${APP_ROOT})`);

/** 计划任务触发 → 跑一次并记历史 */
async function runScheduled(task, meta = {}) {
  const r = await runOnce({ cfg, mode: task.mode, task, catchUp: !!meta.catchUp });
  scheduler.appendHistory(cfg, {
    taskId: task.id,
    name: task.name,
    mode: task.mode,
    catchUp: !!meta.catchUp,
    ok: !!r?.ok,
    error: r?.error ?? null,
    items: r?.summary?.items ?? null,
    alerts: r?.summary?.alerts ?? null,
    file: r?.file ? path.basename(r.file) : null,
  });
  return r;
}

function openBrowser(url) {
  try {
    const cmd =
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    log.info(`已请求打开浏览器 / requested to open: ${url}`);
  } catch (err) {
    log.warn(`打开浏览器失败 / could not open browser: ${err.message}`);
  }
}

const app = createApp({
  getConfig: () => cfg,
  setConfig: (next) => {
    cfg = saveConfig(next);
    return cfg;
  },
  log,
  onConfigChanged: (next) => {
    ensureDirs(next);
    applyPathEnv(next);
    applyProxy(next).catch(() => {}); // 代理配置变更后立即生效
    scheduler.start(next, runScheduled, log); // 配置变更后重排定时
  },
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log.info(`服务已就绪 / listening on ${url}`);
  console.log(`\n  Vtuber's Monitor Link  →  ${url}\n`);
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`端口被占用 / port ${PORT} in use —— 可用环境变量 PORT 换一个端口`);
  } else {
    log.error(`服务启动失败 / server error — ${err.message}`);
  }
  process.exit(1);
});

// 内置调度器
scheduler.start(cfg, runScheduled, log);

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`收到 ${sig}，退出中 / shutting down`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ── 兜底：别因为一处写错就整站死掉 ────────────────────────────────
// 教训：Express 4 **不会**捕获 async 路由里的抛错，一次 ReferenceError
// （features.js 里一个写错的变量名）就让整个进程退出，连带网页全白。
// 这里把未捕获的异常/拒绝记成日志并继续运行 —— 对本地工具来说，
// 「某个接口 500」远比「整个服务没了」可接受。
process.on('unhandledRejection', (reason) => {
  log.error(`未处理的 Promise 拒绝 / unhandledRejection — ${reason?.stack ?? reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`未捕获异常 / uncaughtException — ${err?.stack ?? err}`);
  if (/EADDRINUSE/.test(String(err?.code ?? ''))) process.exit(1);
});

// 首次运行提示 / first-run hint
if (!fs.existsSync(path.join(APP_ROOT, 'config.json'))) {
  log.warn('未找到 config.json，已使用默认配置（请到网页里填写 LLM API Key）/ using defaults; set your LLM API key in the UI');
}
