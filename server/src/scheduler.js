// scheduler.js — 内置调度器（不依赖系统计划任务）/ built-in scheduler
//
// 支持多个计划任务：每条有名称、模式（daily / merch / watch）、频率（weekly / daily）、
// 时间、是否补跑。除了「下一次」之外还能预览接下来几次，并记录执行历史。
// 旧版单条 schedule（enabled/mode/dayOfWeek/time）会在读取配置时自动迁移成一条任务。
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

/** 计算某条任务的下一次触发时间 / next fire time of one task */
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

/** 预览接下来 n 次 / preview the next n fire times */
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

/** 所有任务里最近的一次 / the soonest fire across every task */
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

// ───────────────────────────────────────── 执行历史 / run history

function historyPath(cfg) {
  return path.join(resolveDir(cfg, 'logsDir'), 'schedule-history.jsonl');
}

export function appendHistory(cfg, entry) {
  try {
    const f = historyPath(cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    /* 记不上也不该影响运行 */
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

/** 上次执行时间（用于补跑判断）/ last fire per task id */
function lastFireOf(cfg, taskId) {
  const h = readHistory(cfg, 200).find((x) => x.taskId === taskId && !x.catchUp);
  return h ? new Date(h.at) : null;
}

/**
 * 已经为「哪个任务、哪个时间点」补跑过。
 *
 * 为什么必须有这个：scheduler.start() 会在**每次保存配置**时被调用（onConfigChanged 里），
 * 而补跑判断原本只看「上次执行时间 < 上一个应触发时间」，于是：
 *   • 每保存一次就重排一次补跑 —— 实测在任务名输入框里敲 10 个字符就排了 10 次补跑；
 *   • 新建的任务没有任何历史，也会立刻被判为「错过」而马上跑一次。
 * 这里用「任务 + 时间点」去重，并且要求任务确实跑过至少一次。
 */
const catchUpDone = new Set();

/** 仅供测试：重置去重状态 */
export function resetCatchUpState() {
  catchUpDone.clear();
}

// ───────────────────────────────────────── 生命周期 / lifecycle

export function stop() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

/**
 * 按配置重排所有任务。
 * @param {object} cfg
 * @param {(task:object, meta:{catchUp:boolean}) => Promise<any>} onFire
 */
export function start(cfg, onFire, log) {
  stop();
  logRef = log ?? logRef;
  const tasks = (cfg?.schedule?.tasks ?? []).filter((t) => t.enabled);
  lastFires = new Map();

  if (!tasks.length) {
    log?.info('调度器未启用 / scheduler disabled');
    return null;
  }

  const now = new Date();
  for (const task of tasks) {
    const next = computeTaskNextFire(task, now);
    if (!next) continue;
    lastFires.set(task.id, next);

    const delay = Math.max(1000, next.getTime() - Date.now());
    log?.info(`任务「${task.name}」下次运行 / next run: ${next.toLocaleString()}（${Math.round(delay / 60000)} 分钟后）`);

    const timer = setTimeout(async () => {
      try {
        await onFire(task, { catchUp: false });
      } catch (err) {
        log?.error(`调度触发失败 / scheduled run failed — ${err.message}`);
      } finally {
        start(cfg, onFire, log);
      }
    }, delay);
    timer.unref?.();
    timers.set(task.id, timer);

    // 补跑：程序没开的时候错过了，启动后补一次。
    // 三道闸门（缺一条就会变成「一存配置就乱跑」）：
    //   1. 必须**确实跑过至少一次** —— 新建的任务没有历史，谈不上「错过」；
    //   2. 同一个「任务 + 时间点」只补一次 —— 否则每次保存配置都会重排；
    //   3. 只补最近 7 天内的，再久就不追了。
    if (task.catchUp) {
      const last = lastFireOf(cfg, task.id);
      const prevDue = previousFire(task, now);
      const key = `${task.id}|${prevDue ? prevDue.toISOString() : ''}`;
      if (!last) {
        log?.info(`任务「${task.name}」还没有执行记录，不做补跑（只排下一次）/ no history, no catch-up`);
      } else if (catchUpDone.has(key)) {
        /* 这个时间点已经补过了，保存配置不该再补一次 */
      } else if (prevDue && last < prevDue && now - prevDue < 7 * 24 * 3600 * 1000) {
        catchUpDone.add(key);
        log?.info(`任务「${task.name}」错过 ${prevDue.toLocaleString()}，启动后补跑一次 / catching up`);
        setTimeout(async () => {
          try {
            await onFire(task, { catchUp: true });
          } catch (err) {
            log?.error(`补跑失败 / catch-up failed — ${err.message}`);
          }
        }, 5000 + Math.random() * 2000).unref?.();
      }
    }
  }
  return nextFire();
}

/** 某任务在 from 之前最近的一次应触发时间 */
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
