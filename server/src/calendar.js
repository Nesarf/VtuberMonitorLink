// calendar.js — 纪念日 / 生日 / 3D披露 / 周年 倒计时
//
// 为什么这块要单独写一模块而不是在界面里算：日期算术里有两个地方几乎一定会错，
// 而且错得很隐蔽：
//
//  1) **闰日**。2 月 29 日的生日，在平年该怎么算？业界做法是「顺延到 3 月 1 日」。
//     用 `new Date(y, 1, 29)` 会很自然地滚到 3 月 1 日 —— 看起来对，但它同时会让
//     「天数差」变成非整数天（因为本地时间偏移变化），于是排序和倒计时都会漂。
//
//  2) **时区与夏令时**。用 `(a - b) / 86400000` 算天数差，在有夏令时的时区会得到
//     23 小时或 25 小时的一天 → 差一天。正确做法是把两端的**日历日**取成
//     'YYYY-MM-DD' 字符串（用 Intl 在目标时区格式化），再按 UTC 解析回来相减，
//     这样「日期差」永远是整数天。
//
// 所以本模块只做两件事：把任意时刻规约成目标时区的日历日字符串；在日历日上做整数算术。

/** 把某个时刻在指定时区下的「日历日」取成 YYYY-MM-DD（en-CA 恰好就是这个格式） */
export function dayInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/** 'YYYY-MM-DD' → 用于整数天算术的 UTC 时间戳 */
function dayStamp(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 两个日历日之间相差多少天（整数，不受夏令时影响） */
export function daysBetween(fromDay, toDay) {
  return Math.round((dayStamp(toDay) - dayStamp(fromDay)) / 86400000);
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export const KINDS = ['birthday', 'debut', '3d', 'anniversary', 'event', 'other'];

/**
 * 算出某个条目「下一次」发生的日历日。
 *
 * 条目支持两种：
 *   { date: 'MM-DD' }            每年重复（生日、出道日、周年）
 *   { date: 'YYYY-MM-DD' }       只发生一次（3D 披露、演唱会）
 * 可选 `since: YYYY` 表示「从哪一年开始算」，用来算第几年。
 *
 * @param {object} entry
 * @param {string} today 目标时区下的今天 'YYYY-MM-DD'
 * @returns {{day:string, year:number, turns:number|null, leapAdjusted:boolean}|null}
 */
export function nextOccurrence(entry, today) {
  const raw = String(entry?.date ?? '').trim();
  const [tY, tM, tD] = today.split('-').map(Number);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const r = /^(\d{2})-(\d{2})$/.exec(raw);
  if (!m && !r) return null;

  // 一次性日期
  if (m) {
    const day = raw;
    const diff = daysBetween(today, day);
    if (diff < 0) return { day, year: Number(m[1]), turns: null, leapAdjusted: false, past: true };
    return { day, year: Number(m[1]), turns: null, leapAdjusted: false, past: false };
  }

  const mm = Number(r[1]);
  const dd = Number(r[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const since = Number(entry?.since) || null;

  // 从今年开始往后找第一个「还没过」的年份（最多看 8 年，防止异常数据死循环）
  for (let y = tY; y <= tY + 8; y++) {
    let useM = mm;
    let useD = dd;
    let leapAdjusted = false;
    if (mm === 2 && dd === 29 && !isLeapYear(y)) {
      // 闰日在平年顺延到 3 月 1 日（沿用惯例，并且明确标出来让界面能提示）
      useM = 3;
      useD = 1;
      leapAdjusted = true;
    }
    if (useD > daysInMonth(y, useM)) continue;
    const day = `${y}-${String(useM).padStart(2, '0')}-${String(useD).padStart(2, '0')}`;
    if (daysBetween(today, day) < 0) continue;
    return { day, year: y, turns: since ? y - since : null, leapAdjusted };
  }
  return null;
}

/**
 * 全部条目的倒计时视图。
 * @param {object} cfg
 * @param {{days?:number, now?:Date, weekStart?:number}} opts
 */
export function upcoming(cfg, opts = {}) {
  // 注意用 || 而不是 ??：配置里 timeZone 默认是**空字符串**，
  // 而 ?? 只认 null/undefined，空串会一路传下去，最后界面上的时区显示为空（踩过）。
  const tz = opts.timeZone || cfg?.calendar?.timeZone || undefined;
  const now = opts.now ?? new Date();
  // 不传时区时用系统时区：Intl 允许 timeZone 为 undefined
  const today = tz ? dayInTz(now, tz) : localDay(now);
  const entries = cfg?.calendar?.entries ?? [];
  const rows = [];

  for (const e of entries) {
    if (e && e.hidden === true) continue;
    const next = nextOccurrence(e, today);
    if (!next) continue;
    const days = daysBetween(today, next.day);
    rows.push({
      id: e.id,
      name: e.name ?? e.id,
      kind: KINDS.includes(e.kind) ? e.kind : 'other',
      date: e.date,
      day: next.day,
      days,
      turns: next.turns,
      leapAdjusted: next.leapAdjusted,
      past: !!next.past,
      note: e.note ?? '',
      url: e.url ?? '',
      sourceId: e.sourceId ?? null,
      remindDaysBefore: Number(e.remindDaysBefore ?? cfg?.calendar?.remindDaysBefore ?? 3),
    });
  }

  rows.sort((a, b) => a.days - b.days || String(a.name).localeCompare(String(b.name)));

  const within = Number(opts.days ?? 60);
  return {
    today,
    timeZone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: within,
    all: rows,
    due: rows.filter((r) => r.days >= 0 && r.days <= within),
    reminders: rows.filter((r) => r.days >= 0 && r.days <= r.remindDaysBefore),
  };
}

function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────
// 从情报里**本地**抽取纪念日线索（不联网、不用 LLM）
// ─────────────────────────────────────────────

/** 关键词 → 类型。中日英都有，因为情报源本来就是多语的。 */
const KIND_HINTS = [
  ['3d', /3D(披露|お披露目|おひろめ|debut|model|化)|3D化|three[- ]?d|３Ｄ/],
  ['birthday', /誕生日|诞生日|生日|バースデー|birthday|생일/],
  ['debut', /デビュー|出道|首播|debut|デビュー記念/],
  ['anniversary', /周年|記念日|anniversary|アニバーサリー/],
];

/** 日期形态：2026年3月5日 / 3月5日 / 3/5 / 2026-03-05 / 03-05 */
const DATE_PATTERNS = [
  /(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?/,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  /(?<![\d:.])(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?![\d:.])/,
];

/**
 * 从情报条目文本里找「可能的纪念日」。
 * 只做**线索**：日期 + 类型 + 原文片段，用来提示使用者确认，不自动落库。
 * 这样既不依赖 LLM，也不会因为误判污染日历。
 */
export function detectFromItems(items, { limit = 40 } = {}) {
  const found = [];
  const seen = new Set();
  for (const it of items ?? []) {
    const text = [it.title, it.summary, it.contentText, it.text].filter(Boolean).join(' ');
    if (!text) continue;
    const kind = KIND_HINTS.find(([, re]) => re.test(text))?.[0];
    if (!kind) continue;
    for (const re of DATE_PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      let date;
      if (m.length === 4) {
        date = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      } else {
        const mm = Number(m[1]);
        const dd = Number(m[2]);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
        date = `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      }
      const key = kind + '|' + date;
      if (seen.has(key)) break;
      seen.add(key);
      const at = Math.max(0, m.index - 24);
      found.push({
        kind,
        date,
        evidence: text.slice(at, at + 90).trim(),
        sourceId: it.sourceId ?? null,
        sourceName: it.sourceName ?? null,
        itemId: it.id ?? null,
        url: it.url ?? '',
      });
      break;
    }
    if (found.length >= limit) break;
  }
  return found;
}

/** 规范化一个日历条目（界面/接口来的数据都要过这里） */
export function sanitizeEntry(input, idGen = () => `cal-${Date.now().toString(36)}`) {
  const name = String(input?.name ?? '').trim().slice(0, 80);
  const date = String(input?.date ?? '').trim();
  const rec = /^(\d{2})-(\d{2})$/.exec(date);
  const once = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!name) return { error: 'name is required' };
  // 光校验格式不够：'13-45' 也符合 \d{2}-\d{2}，必须校验范围
  // （2/29 用闰年当基准来判断，这样它是合法输入，平年的顺延交给 nextOccurrence）
  if (rec) {
    const mm = Number(rec[1]);
    const dd = Number(rec[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(2000, mm)) return { error: `invalid month/day: ${date}` };
  } else if (once) {
    const y = Number(once[1]);
    const mm = Number(once[2]);
    const dd = Number(once[3]);
    if (y < 1900 || y > 2200 || mm < 1 || mm > 12 || dd < 1 || dd > daysInMonth(y, mm)) {
      return { error: `invalid date: ${date}` };
    }
  } else {
    return { error: 'date must be MM-DD (yearly) or YYYY-MM-DD (one-off)' };
  }
  const kind = KINDS.includes(input?.kind) ? input.kind : 'other';
  const since = Number(input?.since);
  return {
    entry: {
      id: String(input?.id ?? '').trim() || idGen(),
      name,
      kind,
      date,
      since: Number.isFinite(since) && since > 1900 && since < 2200 ? since : null,
      note: String(input?.note ?? '').trim().slice(0, 300),
      url: String(input?.url ?? '').trim().slice(0, 500),
      sourceId: input?.sourceId ? String(input.sourceId).slice(0, 80) : null,
      remindDaysBefore: Math.max(0, Math.min(60, Number(input?.remindDaysBefore ?? 3) || 0)),
      hidden: input?.hidden === true,
    },
  };
}

/**
 * 某个月的网格（用于界面上的月历）。
 * weekStart: 0=周日（美/日/韩/港台），1=周一（中/欧/俄）—— 直接吃地区的设置。
 */
export function monthGrid(year, month, weekStart = 1, { marks = {} } = {}) {
  const first = Date.UTC(year, month - 1, 1);
  const firstDay = new Date(first).getUTCDay();
  const lead = (firstDay - weekStart + 7) % 7;
  const total = daysInMonth(year, month);
  const cells = [];
  for (let i = 0; i < lead; i++) {
    const d = new Date(first - (lead - i) * 86400000);
    cells.push({ day: d.toISOString().slice(0, 10), inMonth: false, dayOfMonth: d.getUTCDate() });
  }
  for (let d = 1; d <= total; d++) {
    const day = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day, inMonth: true, dayOfMonth: d, marks: marks[day] ?? [] });
  }
  while (cells.length % 7 !== 0) {
    const last = new Date(dayStamp(cells.at(-1).day) + 86400000);
    cells.push({ day: last.toISOString().slice(0, 10), inMonth: false, dayOfMonth: last.getUTCDate() });
  }
  return { year, month, weekStart, cells };
}

/** 把条目按日历日索引起来（月历标点用） */
export function marksFor(cfg, year, month, opts = {}) {
  const entries = (cfg?.calendar?.entries ?? []).filter((e) => e && e.hidden !== true);
  const marks = {};
  const mm0 = String(month).padStart(2, '0');
  const prefix = `${year}-${mm0}-`;
  for (const e of entries) {
    const raw = String(e.date ?? '');
    const yearly = /^(\d{2})-(\d{2})$/.exec(raw);
    if (yearly) {
      let mm = Number(yearly[1]);
      let dd = Number(yearly[2]);
      if (mm === 2 && dd === 29 && !isLeapYear(year)) {
        mm = 3;
        dd = 1; // 与 nextOccurrence 保持一致
      }
      if (mm !== month) continue;
      const day = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      (marks[day] ??= []).push({ id: e.id, name: e.name, kind: e.kind });
    } else if (raw.startsWith(prefix)) {
      (marks[raw] ??= []).push({ id: e.id, name: e.name, kind: e.kind });
    }
  }
  void opts;
  return marks;
}
