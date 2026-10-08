// index.js — entry point
// Start the local server -> open the browser automatically -> start the built-in scheduler
import { spawn } from 'node:child_process';
import { configHealthSnapshot, loadConfig, saveConfig, setConfigHealthLogger, resolveDir, APP_ROOT } from './config.js';
import { setBaselineHealthLogger } from './watch.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';
import { runOnce } from './runner.js';
import * as scheduler from './scheduler.js';
import { ensureDirs } from './reports.js';
import { applyProxy } from './net.js';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 43110);
const HOST = '127.0.0.1';

/**
 * The exit code for "an exception escaped every boundary and the process is going down".
 *
 * It is deliberately not 1: 1 is what the launcher and the traversals already read as "the port could
 * not be bound / the process failed to start", and a run that dies *while serving* is a different
 * event from one that never started — the log line says which, and the code lets a script tell them
 * apart without parsing it.
 */
const EXIT_UNCAUGHT = 70;

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
// The durability state is recorded by config.js during `loadConfig()` above, before this logger
// existed. Hand the logger over now so every later write and every retry of a standing condition is
// logged where the user will see it, and state the load result once here — the startup line is the
// one place a first-run and a damaged file must not look the same.
setConfigHealthLogger(log);
// The watch baselines get the same treatment, and for the same reason (see the block in server/src/watch.js):
// a damaged baseline is a condition with a preserved file and a route that reports it, and the logger is what
// makes the standing condition visible while it stands rather than only at the moment it was found. Injected
// here — after this logger exists — exactly like the config one.
setBaselineHealthLogger(log);
{
  const h = configHealthSnapshot();
  if (h.state === 'corrupt' || h.state === 'unreadable') {
    const what = h.events.at(-1) ?? {};
    log.error(
      `config file is ${h.state}${what.code ? ` (${what.code})` : ''}: ${what.error ?? 'see /api/config/health'}`
    );
    log.error(
      what.movedTo
        ? `the damaged file was kept as ${path.basename(what.movedTo)}; running on defaults, and nothing will be written over it until you save or call POST /api/config/recover (${h.backupExists ? 'a .bak copy is available' : 'no .bak copy exists'})`
        : `running on defaults; the damaged file was left untouched at ${h.path} — fix or move it, then restart`
    );
  } else if (h.state === 'fresh') {
    log.warn(`no config file yet (${h.path}), starting from defaults; set your LLM API key in the UI, and the first save creates the file`);
  }
}
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

/**
 * The ordered shutdown, used by every path that ends this process.
 *
 * The order is the whole content of it: stop the timers (no new scheduled work is started), close the
 * HTTP server (no new connections are accepted, in-flight ones are allowed to finish), then exit. The
 * log is already on disk by the time this runs — logger.js writes with `appendFileSync`, so "flush the
 * log" is satisfied by writing the last line *before* any of this, not by a flush step at the end.
 *
 * The 3s timer is the floor under the polite half: a hanging socket or a stuck SPA connection would
 * otherwise keep `server.close()`'s callback from ever firing, and the process would be the one thing
 * a shutdown must not be — still alive. It is `unref`'d so it never itself holds the process open.
 */
function shutdown(exitCode, why) {
  log.info(`${why}; shutting down (exit ${exitCode})`);
  scheduler.stop();
  const forced = setTimeout(() => process.exit(exitCode), 3000);
  forced.unref();
  server.close(() => process.exit(exitCode));
}

// graceful shutdown on a signal: the exit code is 0 because a requested stop is a normal end
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0, `received ${sig}`));
}

// ── Safety net, and the two ideas that used to be one ─────────────────────
//
// Lesson learned the hard way: Express 4 does **not** catch a throw or a rejection inside an *async*
// route, so a ReferenceError in one route handler once ended the whole process and blanked every page
// with it. Two different things were then conflated in the fix, and they have to stay apart:
//
//   • A **failed request** is a normal, contained event. It already has an owner one layer down: the
//     JSON error fallback in server/src/server.js (the `app.use((err, req, res, _next) => …)` at the
//     end of `createApp`) answers 500 with the route's name and the process keeps serving. That
//     handler is the boundary, and it is *kept* — nothing here may turn a route error into an exit.
//   • An **uncaught** exception is a different statement. It means a throw reached the top of the
//     stack: some async callback, timer or promise nobody awaited. The stack that unwound through it
//     is not the stack we would have written, and whatever that code was in the middle of may be half
//     done. Continuing from there is serving from a state nobody can vouch for — the process *looks*
//     alive (the port answers, the dashboard reloads) while the invariant behind it is broken, which
//     is a worse failure than being down, because being down is visible.
//
// So an uncaught exception is logged and then followed by the ordered shutdown above, with a non-zero
// code. The cost is explicit and accepted: a bug that would previously have produced a few 500s now
// ends this process, and `launcher/launch.cjs` (which starts the app and reports the child's code) and
// the traversals (which spawn it) will see that exit — that is the intended, visible outcome, and it
// is why the log line is written first and the exit code is distinct from "failed to start".
//
// `unhandledRejection` stays log-only, and that is a decision rather than an oversight: the rejection
// paths this project actually has (a failed fetch, a refused write) are awaited or `.catch()`ed at the
// site, so an escaped one is usually a *forgotten* `.catch()` on a promise whose failure the code
// already treats as "this one operation did not work" — turning that into a process exit would take
// the site down over one dead source. What it does *not* share with an uncaught exception is silence:
// it is logged, loudly, with the stack.
let shuttingDown = false;
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection — ${reason?.stack ?? reason}`);
});
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException — ${err?.stack ?? err}`);
  // A second throw while the shutdown is already in flight is reported and then ignored: re-entering
  // the teardown is how a shutdown ends up hanging instead of finishing.
  if (shuttingDown) {
    log.error('a second uncaught exception arrived while shutting down; the exit already in progress stands');
    return;
  }
  shuttingDown = true;
  shutdown(EXIT_UNCAUGHT, 'the process state can no longer be vouched for');
});

// The first-run hint that used to live here is gone: it tested `!fs.existsSync(config.json)` on its
// own, which is true both on a genuine first run and after a damaged file had been moved aside -- so
// the one line meant to explain "start here" also fired in the state that must not look like a fresh
// install. The load state is reported once, from the single record kept by config.js, above.
