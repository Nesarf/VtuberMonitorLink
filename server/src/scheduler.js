// scheduler.js — 内置调度器（不依赖系统计划任务）/ built-in scheduler
// 支持 weekly（每周某天某时刻）与 daily；另有 merchEveryDays 控制通贩扫描节奏。
let timer = null;
let nextFireAt = null;

const pad = (n) => String(n).padStart(2, '0');

/** 解析 "HH:MM" / parse "HH:MM" */
function parseTime(t, fallback = { h: 23, m: 30 }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ''));
  if (!m) return fallback;
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

/** 计算下一次触发时间 / compute the next fire time */
export function computeNextFire(schedule, from = new Date()) {
  if (!schedule?.enabled) return null;
  const { h, m } = parseTime(schedule.time);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(h, m, 0, 0);

  if (schedule.mode === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  const target = Number.isInteger(schedule.dayOfWeek) ? schedule.dayOfWeek : 2;
  let delta = (target - next.getDay() + 7) % 7;
  if (delta === 0 && next <= from) delta = 7;
  next.setDate(next.getDate() + delta);
  return next;
}

export function start(cfg, onFire, log) {
  stop();
  const schedule = cfg?.schedule ?? {};
  if (!schedule.enabled) {
    nextFireAt = null;
    log?.info('调度器未启用 / scheduler disabled');
    return null;
  }
  nextFireAt = computeNextFire(schedule);
  if (!nextFireAt) return null;

  const delay = Math.max(1000, nextFireAt.getTime() - Date.now());
  log?.info(
    `下次运行 / next run: ${nextFireAt.toLocaleString()} (in ${Math.round(delay / 60000)} min)`
  );
  timer = setTimeout(async () => {
    try {
      await onFire();
    } catch (err) {
      log?.error(`调度触发失败 / scheduled run failed — ${err.message}`);
    } finally {
      start(cfg, onFire, log); // 重新排下一次
    }
  }, delay);
  timer.unref?.();
  return nextFireAt;
}

export function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextFireAt = null;
}

export function nextFire() {
  return nextFireAt ? nextFireAt.toISOString() : null;
}
