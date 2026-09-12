// dormant.js — objects that stopped being active (graduated / long hiatus): list their latest content at the end of the daily report
//
// Why this is needed: the daily report answers "what is new today", so **anyone who stopped never shows up in it** --
// even if they posted something yesterday (their only post in half a year, and precisely the one that most deserves to be seen).
// Conversely, someone quiet for half a year who suddenly moves should be visible at a glance in the daily report.
//
// So the rule is: list everyone who has "been inactive past the threshold (6 months by default)" together at the **end** of the
// daily report, each with their latest one or two items and dates. That way the report stays continuous about *people*:
// active people on top (today's activity), dormant people below (their most recent one), and any sudden movement is obvious.
//
// The criterion looks at **facts** only (how long since the last activity); it does not guess "did they graduate":
// graduation, hiatus and platform switches all look like the same thing in the data -- "no new items for a long time".
import { baselineOf } from './silence.js';

export const DORMANT_DEFAULTS = {
  enabled: true,
  months: 6, // the threshold the user asked for: half a year
  maxPeople: 12, // how many people to list at most in one run (more than that becomes noise)
  maxItems: 2, // how many items per person at most
  comebackDays: 3, // "comeback" criterion: after being dormant this long, there is movement again in the last few days
};

const DAY_MS = 86400000;
const dayOf = (v) => new Date(v).toISOString().slice(0, 10);

/** Days since today (day granularity) */
export function daysSince(day, now = new Date()) {
  if (!day) return null;
  const d = Date.parse(String(day).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.round((Date.parse(dayOf(now)) - d) / DAY_MS));
}

/**
 * Does this person count as "no longer active".
 * months uses 30.44 days/month (not 30: half a year differs by more than a day, which makes boundaries inconsistent).
 */
export function isDormant({ lastDay, now = new Date(), months = DORMANT_DEFAULTS.months } = {}) {
  const days = daysSince(lastDay, now);
  if (days === null) return { dormant: false, days: null };
  const threshold = Math.round(Number(months) * 30.44);
  return { dormant: days >= threshold, days, thresholdDays: threshold };
}

/**
 * Build the block at the end of the daily report.
 *
 * @param {object} o
 * @param {Array}  o.people       followed people
 * @param {object} o.byDay        archive.peopleSeries().byDay (used to compute the last active day)
 * @param {object} o.latestItems  { personId: [{title, day, url}] } -- looked up from the archive
 * @param {object} o.todayPeople  set of personIds with items today (used to detect a "comeback")
 * @param {object} o.rules
 * @returns {{dormant:Array, returnees:Array, markdown:string, skipped:number}}
 */
export function dormantBlock({ people = [], byDay = {}, latestItems = {}, todayPeople = [], rules = {}, now = new Date() } = {}) {
  const r = { ...DORMANT_DEFAULTS, ...rules };
  const out = { dormant: [], returnees: [], markdown: '', skipped: 0 };
  if (!r.enabled || !people.length) return out;

  const today = new Set(todayPeople);
  const candidates = [];

  for (const p of people) {
    const days = byDay[String(p.id)] ?? {};
    const baseline = baselineOf(days, { now });
    if (baseline.lastDay === null) {
      // Never seen at all: this is not "stopped being active", it is "not seen yet" -- do not list (listing it is noise)
      out.skipped++;
      continue;
    }
    const activeDays = Object.keys(days)
      .filter((d) => Number(days[d]) > 0)
      .sort();
    // A comeback has to be read like this: there is movement in the last few days, and **before that** the person had
    // already been silent for at least a full threshold --
    // looking only at the "last active day" misses it (a returning person's last active day is today, so they look healthy).
    const recentActive = daysSince(activeDays.at(-1), now) <= (Number(r.comebackDays) || DORMANT_DEFAULTS.comebackDays);
    const prevDay = activeDays.length >= 2 ? activeDays.at(-2) : null;
    const gapBeforeRecent = prevDay ? daysSince(prevDay, now) : null;
    const thresholdDays = Math.round(Number(r.months ?? DORMANT_DEFAULTS.months) * 30.44);
    const comeback = recentActive && gapBeforeRecent !== null && gapBeforeRecent >= thresholdDays;

    const st = isDormant({ lastDay: baseline.lastDay, now, months: r.months });
    if (!st.dormant && !comeback) continue;
    const items = (latestItems[String(p.id)] ?? []).slice(0, Math.max(1, Number(r.maxItems) || 1));
    const quietDays = st.dormant ? st.days : gapBeforeRecent;
    const rec = {
      id: String(p.id),
      name: p.name ?? String(p.id),
      agency: p.agency ?? null,
      lastDay: baseline.lastDay,
      quietDays,
      months: Number((quietDays / 30.44).toFixed(1)),
      items,
      comeback,
    };
    if (rec.comeback) out.returnees.push(rec);
    else candidates.push(rec);
  }

  // Returnees first (those are what most deserves to be seen), the rest by "who had movement most recently"
  out.returnees.sort((a, b) => a.quietDays - b.quietDays);
  candidates.sort((a, b) => (b.lastDay ?? '').localeCompare(a.lastDay ?? ''));
  const picked = [...out.returnees, ...candidates].slice(0, Math.max(1, Number(r.maxPeople) || DORMANT_DEFAULTS.maxPeople));
  out.dormant = picked;
  out.hidden = Math.max(0, out.returnees.length + candidates.length - picked.length);

  const lines = [];
  if (out.returnees.length) {
    lines.push(`**🟢 可能有动静了**（原本已休眠 ≥${r.months} 个月）：`);
    for (const p of out.returnees) {
      lines.push(`- **${p.name}**${p.agency ? `（${p.agency}）` : ''} —— 上次活动 ${p.lastDay}（停了约 ${p.months} 个月）`);
      for (const it of p.items) lines.push(`    - ${it.day ?? ''} ${String(it.title ?? '').slice(0, 90)}${it.url ? ` — ${it.url}` : ''}`);
    }
  }
  if (candidates.length) {
    lines.push('');
    lines.push(`**⏳ 已停止活动 ≥${r.months} 个月**（${candidates.length} 人，下面是他们各自最新的内容）：`);
    for (const p of candidates.slice(0, Math.max(0, (Number(r.maxPeople) || DORMANT_DEFAULTS.maxPeople) - out.returnees.length))) {
      lines.push(`- **${p.name}**${p.agency ? `（${p.agency}）` : ''} —— 最后 ${p.lastDay}（约 ${p.months} 个月前）`);
      for (const it of p.items) lines.push(`    - ${it.day ?? ''} ${String(it.title ?? '').slice(0, 90)}${it.url ? ` — ${it.url}` : ''}`);
    }
    if (out.hidden) lines.push(`- …另有 ${out.hidden} 位同样处于停止活动状态（超过每次上限）`);
  }
  out.markdown = lines.length ? `## 🌙 停止活动 / 毕业（≥${r.months} 个月无动静）\n\n${lines.join('\n')}` : '';
  return out;
}
