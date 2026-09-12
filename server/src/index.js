// index.js — entry point
// Start the local server -> open the browser automatically -> start the built-in scheduler
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
 * Write the paths from the config into the process environment, for submodules/third-party
 * libraries to read.
 * - VML_TEMP_DIR: where temporary files such as the cookie-jar copy land (can avoid the C: drive)
 * - PLAYWRIGHT_BROWSERS_PATH: browser engine location (on Windows this defaults to
 *   %LOCALAPPDATA% on the C: drive)
 * When both are left empty the system defaults stand, so the portable release never hard-codes
 * a machine path.
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
// Apply the proxy from the config at startup (an environment where direct connections are
// blocked must go through a proxy explicitly)
await applyProxy(cfg);

const log = createLogger(path.join(resolveDir(cfg, 'logsDir'), 'server.log'));
log.info(`Vtuber's Monitor Link starting… (root: ${APP_ROOT})`);

/** A scheduled task fired -> run once and record the history */
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
    log.info(`requested to open: ${url}`);
  } catch (err) {
    log.warn(`could not open browser: ${err.message}`);
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
    applyProxy(next).catch(() => {}); // take effect immediately after the proxy config changes
    scheduler.start(next, runScheduled, log); // reschedule the timers after a config change
  },
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log.info(`listening on ${url}`);
  console.log(`\n  Vtuber's Monitor Link  →  ${url}\n`);
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port ${PORT} in use — set the PORT environment variable to pick another port`);
  } else {
    log.error(`server error — ${err.message}`);
  }
  process.exit(1);
});

// built-in scheduler
scheduler.start(cfg, runScheduled, log);

// graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`received ${sig}, shutting down`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ── Safety net: one typo must not take the whole site down ────────────────
// Lesson learned: Express 4 does **not** catch a throw inside an async route, so a single
// ReferenceError (a misspelled variable name in features.js) exited the whole process and
// blanked every page along with it.
// Here uncaught exceptions/rejections are logged and the process keeps running — for a local
// tool, "some endpoint returns 500" is far more acceptable than "the whole service is gone".
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection — ${reason?.stack ?? reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException — ${err?.stack ?? err}`);
  if (/EADDRINUSE/.test(String(err?.code ?? ''))) process.exit(1);
});

// first-run hint
if (!fs.existsSync(path.join(APP_ROOT, 'config.json'))) {
  log.warn('config.json not found, using defaults; set your LLM API key in the UI');
}
