// scheduler.js — built-in scheduler (does not depend on OS scheduled tasks)
//
// Supports several scheduled tasks: each one has a name, a mode (daily / merch / watch), a frequency
// (weekly / daily), a time and a catch-up flag. Besides "the next fire" it can preview the coming few
// and it keeps a run history.
// The old single-schedule shape (enabled/mode/dayOfWeek/time) is migrated into one task automatically when the config is read.
import fs from 'node:fs';
import path from 'node:path';
import { resolveDir } from './config.js';

const timers = new Map();
let lastFires = new Map();
let logRef = null;

const pad = (n) => String(n).padStart(2, '0');

export function parseTime(t, fallback = { h: 23, m: 30 }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''));
  if (!m) return fallback;
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

export function normalizeTask(t, i = 0) {
  const day = Number.isInteger(Number(t?.dayOfWeek)) ? Number(t.dayOfWeek) : 2;
  return {
    id: String(t?.id ?? `task-${i + 1}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60),
    name: String(t?.name ?? `任务 ${i + 1}`).slice(0, 80),
    enabled: t?.enabled !== false,
    mode: ['daily', 'merch', 'watch'].includes(t?.mode) ? t.mode : 'daily',
    freq: t?.freq === 'daily' ? 'daily' : 'weekly',
    dayOfWeek: Math.max(0, Math.min(6, day)),
    time: /^\d{1,2}:\d{2}$/.test(String(t?.time ?? '')) ? String(t.time) : '23:30',
    catchUp: t?.catchUp !== false,
  };
}

/** next fire time of one task */
export function computeTaskNextFire(task, from = new Date()) {
  if (!task?.enabled) return null;
  const { h, m } = parseTime(task.time);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(h, m, 0, 0);

  if (task.freq === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  const target = Number.isInteger(task.dayOfWeek) ? task.dayOfWeek : 2;
  let delta = (target - next.getDay() + 7) % 7;
  if (delta === 0 && next <= from) delta = 7;
  next.setDate(next.getDate() + delta);
  return next;
}

/** preview the next n fire times */
export function previewTask(task, n = 5, from = new Date()) {
  const out = [];
  let cursor = new Date(from);
  for (let i = 0; i < n; i++) {
    const next = computeTaskNextFire(task, cursor);
    if (!next) break;
    out.push(next.toISOString());
    cursor = new Date(next.getTime() + 60_000);
  }
  return out;
}

/** the soonest fire across every task */
export function nextFire() {
  let best = null;
  for (const d of lastFires.values()) {
    if (!best || d < best) best = d;
  }
  return best ? best.toISOString() : null;
}

export function nextFires() {
  return Object.fromEntries([...lastFires].map(([k, v]) => [k, v ? v.toISOString() : null]));
}

// ───────────────────────────────────────── run history

function historyPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'schedule-history.jsonl');
}

export function appendHistory(cfg, entry) {
  try {
    const f = historyPath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* an unwritable entry must not affect the run either */
  }
}

export function readHistory(cfg, limit = 50) {
  try {
    const f = historyPath(cfg);
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/** last fire per task id (used by the catch-up decision) */
function lastFireOf(cfg, taskId) {
  const h = readHistory(cfg, 200).find((x) => x.taskId === taskId && !x.catchUp);
  return h ? new Date(h.at) : null;
}

/**
 * Which "task + fire time" pairs have already been caught up.
 *
 * Why this is mandatory: scheduler.start() is called on **every config save** (inside onConfigChanged),
 * while the catch-up decision originally only looked at "last fire < previous due time", so:
 *   • every save rescheduled a catch-up — measured: typing 10 characters into the task-name box queued 10 catch-ups;
 *   • a brand-new task with no history at all was instantly judged "missed" and run right away.
 * Here dedup is keyed on "task + fire time", and a task must have actually run at least once.
 */
const catchUpDone = new Set();

/** for tests only: reset the dedup state */
export function resetCatchUpState() {
  catchUpDone.clear();
}

// ───────────────────────────────────────── lifecycle

export function stop() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

/**
 * Reschedule every task from the config.
 * @param {object} cfg
 * @param {(task:object, meta:{catchUp:boolean}) => Promise<any>} onFire
 */
export function start(cfg, onFire, log) {
  stop();
  logRef = log ?? logRef;
  const tasks = (cfg?.schedule?.tasks ?? []).filter((t) => t.enabled);
  lastFires = new Map();

  if (!tasks.length) {
    log?.info('scheduler disabled');
    return null;
  }

  const now = new Date();
  for (const task of tasks) {
    const next = computeTaskNextFire(task, now);
    if (!next) continue;
    lastFires.set(task.id, next);

    const delay = Math.max(1000, next.getTime() - Date.now());
    log?.info(`task "${task.name}" next run: ${next.toLocaleString()} (in ${Math.round(delay / 60000)} min)`);

    const timer = setTimeout(async () => {
      try {
        await onFire(task, { catchUp: false });
      } catch (err) {
        log?.error(`scheduled run failed — ${err.message}`);
      } finally {
        start(cfg, onFire, log);
      }
    }, delay);
    timer.unref?.();
    timers.set(task.id, timer);

    // Catch-up: the run was missed while the program was not running, so it is made up once after start.
    // Three gates (drop any one of them and this becomes "every config save runs things at random"):
    //   1. it must have **actually run at least once** — a newly created task has no history, so there is nothing to "miss";
    //   2. the same "task + fire time" is caught up only once — otherwise every config save reschedules it;
    //   3. only the last 7 days are caught up; anything older is not chased.
    if (task.catchUp) {
      const last = lastFireOf(cfg, task.id);
      const prevDue = previousFire(task, now);
      const key = `${task.id}|${prevDue ? prevDue.toISOString() : ''}`;
      if (!last) {
        log?.info(`task "${task.name}" has no run history yet, no catch-up (only the next fire is scheduled)`);
      } else if (catchUpDone.has(key)) {
        /* this fire time has been caught up already; saving the config must not catch it up a second time */
      } else if (prevDue && last < prevDue && now - prevDue < 7 * 24 * 3600 * 1000) {
        catchUpDone.add(key);
        log?.info(`task "${task.name}" missed ${prevDue.toLocaleString()}, catching up once after start`);
        setTimeout(async () => {
          try {
            await onFire(task, { catchUp: true });
          } catch (err) {
            log?.error(`catch-up failed — ${err.message}`);
          }
        }, 5000 + Math.random() * 2000).unref?.();
      }
    }
  }
  return nextFire();
}

/** the most recent due time of a task before from */
export function previousFire(task, from = new Date()) {
  const { h, m } = parseTime(task.time);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setHours(h, m, 0, 0);
  if (task.freq === 'daily') {
    if (t >= from) t.setDate(t.getDate() - 1);
    return t;
  }
  const target = Number.isInteger(task.dayOfWeek) ? task.dayOfWeek : 2;
  let back = (t.getDay() - target + 7) % 7;
  if (back === 0 && t >= from) back = 7;
  t.setDate(t.getDate() - back);
  return t;
}

export function runningTasks() {
  return [...timers.keys()];
}

export { pad };
