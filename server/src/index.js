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

let cfg = loadConfig();
ensureDirs(cfg);
// 启动即按配置应用代理（直连被阻断的环境必须显式走代理）
await applyProxy(cfg);

const log = createLogger(path.join(resolveDir(cfg, 'logsDir'), 'server.log'));
log.info(`Vtuber's Monitor Link starting… (root: ${APP_ROOT})`);

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
    applyProxy(next).catch(() => {}); // 代理配置变更后立即生效
    scheduler.start(next, () => runOnce({ cfg, mode: 'daily' }), log); // 配置变更后重排定时
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
scheduler.start(cfg, () => runOnce({ cfg, mode: 'daily' }), log);

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`收到 ${sig}，退出中 / shutting down`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// 首次运行提示 / first-run hint
if (!fs.existsSync(path.join(APP_ROOT, 'config.json'))) {
  log.warn('未找到 config.json，已使用默认配置（请到网页里填写 LLM API Key）/ using defaults; set your LLM API key in the UI');
}
