// calendar.js — countdowns for anniversaries / birthdays / 3D reveals / anniversaries of debut
//
// Why this is a module of its own instead of arithmetic inside the UI: there are two places in date
// arithmetic where you are almost certain to go wrong, and the mistakes hide well:
//
//  1) **Leap day**. What is a February 29 birthday supposed to be in a common year? The industry
//     convention is "shift to March 1".
//     `new Date(y, 1, 29)` rolls to March 1 quite naturally — it looks right, but it also turns the
//     "difference in days" into a non-integer number of days (because the local time offset changed),
//     so both sorting and the countdown drift.
//
//  2) **Time zones and daylight saving**. Computing a day difference as `(a - b) / 86400000` yields a
//     23-hour or 25-hour day in a zone with DST → off by one. The correct way is to take the
//     **calendar day** at both ends as a 'YYYY-MM-DD' string (formatted with Intl in the target zone),
//     parse both back as UTC and subtract — then the "day difference" is always a whole number of days.
//
// So this module does exactly two things: reduce any moment to a calendar-day string in the target time
// zone, and do integer arithmetic on calendar days.

/** take the "calendar day" of a moment in the given time zone as YYYY-MM-DD (en-CA happens to use exactly that format) */
export function dayInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/** 'YYYY-MM-DD' → a UTC timestamp for integer-day arithmetic */
function dayStamp(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** how many days apart two calendar days are (an integer, unaffected by daylight saving) */
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
 * Work out the calendar day on which an entry "happens next".
 *
 * Two kinds of entry are supported:
 *   { date: 'MM-DD' }             repeats every year (birthday, debut day, anniversary)
 *   { date: 'YYYY-MM-DD' }        happens exactly once (3D reveal, concert)
 * The optional `since: YYYY` says "from which year to count", used to compute which anniversary it is.
 *
 * @param {object} entry
 * @param {string} today today in the target time zone, 'YYYY-MM-DD'
 * @returns {{day:string, year:number, turns:number|null, leapAdjusted:boolean}|null}
 */
export function nextOccurrence(entry, today) {
  const raw = String(entry?.date ?? '').trim();
  const [tY, tM, tD] = today.split('-').map(Number);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const r = /^(\d{2})-(\d{2})$/.exec(raw);
  if (!m && !r) return null;

  // a one-off date
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

  // starting from this year, walk forward to the first year that has not passed yet (look at 8 years at most, so malformed data cannot spin forever)
  for (let y = tY; y <= tY + 8; y++) {
    let useM = mm;
    let useD = dd;
    let leapAdjusted = false;
    if (mm === 2 && dd === 29 && !isLeapYear(y)) {
      // a leap day in a common year shifts to March 1 (following convention, and flagged explicitly so the UI can point it out)
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
 * The countdown view over every entry.
 * @param {object} cfg
 * @param {{days?:number, now?:Date, weekStart?:number}} opts
 */
export function upcoming(cfg, opts = {}) {
  // Note the || rather than ??: timeZone defaults to the **empty string** in the config,
  // and ?? only recognizes null/undefined, so the empty string travels all the way down and the time zone
  // shown in the UI ends up blank (hit this one).
  const tz = opts.timeZone || cfg?.calendar?.timeZone || undefined;
  const now = opts.now ?? new Date();
  // with no time zone passed, use the system one: Intl allows timeZone to be undefined
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
// Extract anniversary hints from the intel **locally** (no network, no LLM)
// ─────────────────────────────────────────────

/** keyword → kind. CJK and English both appear, because the intel sources are multilingual to begin with. */
const KIND_HINTS = [
  ['3d', /3D(披露|お披露目|おひろめ|debut|model|化)|3D化|three[- ]?d|３Ｄ/],
  ['birthday', /誕生日|诞生日|生日|バースデー|birthday|생일/],
  ['debut', /デビュー|出道|首播|debut|デビュー記念/],
  ['anniversary', /周年|記念日|anniversary|アニバーサリー/],
];

/** date shapes: 2026-03-05 / 03-05 / 3/5, plus the CJK year/month/day forms the first two patterns above accept */
const DATE_PATTERNS = [
  /(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?/,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  /(?<![\d:.])(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?![\d:.])/,
];

/**
 * Look for "possible anniversaries" in the text of intel items.
 * It only produces **hints**: a date + a kind + a snippet of the source text, meant to prompt the user to
 * confirm; nothing is written to the calendar automatically.
 * That way it depends on no LLM, and a misread cannot pollute the calendar.
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

/** normalize one calendar entry (data coming from the UI/API all passes through here) */
export function sanitizeEntry(input, idGen = () => `cal-${Date.now().toString(36)}`) {
  const name = String(input?.name ?? '').trim().slice(0, 80);
  const date = String(input?.date ?? '').trim();
  const rec = /^(\d{2})-(\d{2})$/.exec(date);
  const once = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!name) return { error: 'name is required' };
  // Checking the shape alone is not enough: '13-45' also matches \d{2}-\d{2}, so the range has to be checked too
  // (2/29 is judged against a leap year, which makes it a valid input; shifting it for common years is left to nextOccurrence)
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
 * The grid of one month (used by the month calendar in the UI).
 * weekStart: 0=Sunday (US/JP/KR/HK-TW), 1=Monday (CN/EU/RU) — taken straight from the region setting.
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

/** index the entries by calendar day (used for the month-calendar dots) */
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
        dd = 1; // keep in step with nextOccurrence
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
