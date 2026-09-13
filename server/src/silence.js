// silence.js — silence/absence detection: **"nothing happened" is intelligence too**
//
// Why this is needed: every existing alert is about "the content changed" — how many bytes changed,
// which keyword was hit. But for "judging the true state of an agency", **absence** is often more
// informative than content: a daily poster suddenly stops, several people go quiet at once,
// a whole agency shows no activity for days (project over? group holiday? account trouble?).
// None of that is **visible** in the current alerting system: no items means no alert.
//
// The criteria come in two layers, both relative to **each one's own baseline** rather than a
// guessed fixed number of days:
//   1. Person: how many consecutive days someone has no items, reported only once that exceeds the
//      tolerance range of their own recent rhythm (a daily poster and a monthly poster should not
//      share one threshold); someone with no history at all is never reported (no baseline, no anomaly).
//   2. Agency-wide: members of the same agency go quiet **at the same time** — one person being quiet
//      is normal, a whole agency going quiet at once is suspicious.
//
// The result is an "alert", not a "conclusion": this module only puts the suspicious absences on the
// table, the judgement is left to a human (it may be a planned holiday, or it may be real trouble).
import { AGENCY_HOSTS, urlHost } from './observe.js';

/** How many days of silence are tolerated before alerting when a person had not a single item that day (by default inferred from their own rhythm; these are the fallback floor/ceiling) */
export const SILENCE_DEFAULTS = {
  enabled: true,
  sampleDays: 20, // how many recent **active days** to estimate the rhythm from
  minDays: 3, // at least this many silent days before it is worth reporting (so a normal gap is not treated as an anomaly)
  maxDays: 90, // fallback ceiling: however long the rhythm, nobody should have to wait a year for a report
  factor: 2.5, // tolerance range = mean gap x factor, then clamped between minDays / maxDays
  groupQuietDays: 5, // how many days of simultaneous silence across one agency counts as an agency-level signal
  minMembers: 3, // an "agency" with fewer members than this does not take part in agency-level judgement
};

const DAY_MS = 86400000;
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * From "person -> { day: item count }" compute their **rhythm** and last active time.
 *
 * Rhythm = the **mean gap** between the most recent active days (not "active days in window / window length").
 * A trap we already hit: the first version anchored the window on "the last active day", so for someone
 * who "posted three times in three months" the window held only their own single slot -> the gap came out
 * as 1 day -> they were treated as a daily poster, the tolerance range collapsed to 3 days, and a 5-day
 * break triggered a false alarm. The rhythm must be computed from the **spacing between consecutive
 * active days** for it to be comparable with "how long has it been quiet".
 *
 * @returns {{mean:number|null, gapDays:number|null, lastDay:string|null, quietDays:number|null, activeDays:number, items:number}}
 */
export function baselineOf(byDayForPerson, { now = new Date(), sampleDays = SILENCE_DEFAULTS.sampleDays } = {}) {
  const entries = Object.entries(byDayForPerson ?? {}).filter(([, n]) => Number(n) > 0);
  const items = entries.reduce((a, [, n]) => a + Number(n), 0);
  if (!entries.length) return { mean: null, gapDays: null, lastDay: null, quietDays: null, activeDays: 0, items: 0 };

  const days = entries.map(([d]) => d).sort();
  const lastDay = days.at(-1);
  const quietDays = Math.max(0, Math.round((Date.parse(dayOf(now)) - Date.parse(lastDay)) / DAY_MS));
  const recent = days.slice(-Math.max(2, Number(sampleDays) || SILENCE_DEFAULTS.sampleDays));

  let gapDays = null;
  if (recent.length >= 2) {
    const span = (Date.parse(recent.at(-1)) - Date.parse(recent[0])) / DAY_MS;
    gapDays = Number((span / (recent.length - 1)).toFixed(2));
  }

  return {
    mean: Number((items / days.length).toFixed(2)), // mean items per active day (display only)
    gapDays,
    lastDay,
    quietDays,
    activeDays: days.length,
    items,
  };
}

/** This person's tolerance range (days): baseline gap x factor, clamped between minDays and maxDays */
export function toleranceDays(baseline, rules = SILENCE_DEFAULTS) {
  const gap = baseline?.gapDays;
  if (!gap || !Number.isFinite(gap)) return null; // no usable baseline (only one active day on record) -> do not judge: reporting nothing beats reporting a false alarm
  const raw = gap * (Number(rules.factor) || SILENCE_DEFAULTS.factor);
  return Math.min(Number(rules.maxDays) || SILENCE_DEFAULTS.maxDays, Math.max(Number(rules.minDays) || SILENCE_DEFAULTS.minDays, raw));
}

/**
 * Detect silence.
 *
 * @param {object} o
 * @param {object} o.byDay     byDay from archive.peopleSeries(): { personId: { 'YYYY-MM-DD': n } }
 * @param {Array}  o.people    config.people (used to get names and agency)
 * @param {object} o.rules     config.silence
 * @param {Date}   o.now
 * @returns {{person:Array, group:Array, checked:number, skippedNoBaseline:number}}
 */
export function detectSilence({ byDay = {}, people = [], rules = {}, now = new Date() } = {}) {
  const r = { ...SILENCE_DEFAULTS, ...rules };
  const out = { person: [], group: [], checked: 0, skippedNoBaseline: 0 };
  if (!r.enabled) return out;

  const byId = new Map((people ?? []).map((p) => [String(p.id), p]));
  const rows = [];

  for (const [personId, days] of Object.entries(byDay)) {
    const baseline = baselineOf(days, { now, sampleDays: r.sampleDays });
    const tol = toleranceDays(baseline, r);
    if (!baseline.lastDay) continue;
    const person = byId.get(String(personId));
    const name = person?.name ?? personId;
    if (tol === null) {
      out.skippedNoBaseline++;
      continue;
    }
    out.checked++;
    if (baseline.quietDays >= tol) {
      out.person.push({
        kind: 'silence-person',
        personId,
        name,
        agency: person?.agency ?? null,
        quietDays: baseline.quietDays,
        toleranceDays: tol,
        baselineGapDays: baseline.gapDays,
        lastDay: baseline.lastDay,
        level: baseline.quietDays >= tol * 2 ? 'high' : 'warn',
        // Report-visible product copy: this string ends up in the daily report and in push
        // bodies, so it stays in the product's language (see docs/ENGLISH-LOGIC.md §1).
        reason: `${name} 已 ${baseline.quietDays} 天没有新条目（他自己的节奏约 ${baseline.gapDays} 天一条，容忍 ${tol} 天）`,
      });
    }
    rows.push({ personId, name, agency: person?.agency ?? null, quietDays: baseline.quietDays, lastDay: baseline.lastDay });
  }

  // Agency level: members of the same agency go quiet **at the same time**
  const byAgency = new Map();
  for (const row of rows) {
    if (!row.agency) continue;
    if (!byAgency.has(row.agency)) byAgency.set(row.agency, []);
    byAgency.get(row.agency).push(row);
  }
  for (const [agency, members] of byAgency) {
    if (members.length < (Number(r.minMembers) || SILENCE_DEFAULTS.minMembers)) continue;
    const quiet = members.filter((m) => m.quietDays >= (Number(r.groupQuietDays) || SILENCE_DEFAULTS.groupQuietDays));
    if (quiet.length >= 2 && quiet.length >= members.length - 1) {
      out.group.push({
        kind: 'silence-group',
        agency,
        quietDays: Math.min(...quiet.map((m) => m.quietDays)),
        members: quiet.map((m) => m.name),
        memberCount: members.length,
        level: quiet.length === members.length ? 'high' : 'warn',
        // Report-visible product copy (see the person-level reason above)
        reason: `${agency} 的 ${quiet.length}/${members.length} 位成员同时安静了 ${Math.min(...quiet.map((m) => m.quietDays))} 天以上 —— 单个人安静是常态，一箱人同时安静值得看一眼`,
      });
    }
  }

  out.person.sort((a, b) => b.quietDays - a.quietDays);
  out.group.sort((a, b) => b.quietDays - a.quietDays);
  return out;
}

/** Compress the silence detection result into a one-line summary (read by the logs and by /api/silence only; the UI does not render it — the `reason` fields are what reach the report and the push) */
export function silenceSummary(res) {
  const parts = [];
  if (res?.group?.length) parts.push(`agency-level quiet ${res.group.length}: ${res.group.map((g) => g.agency).join(', ')}`);
  if (res?.person?.length) parts.push(`personal silence ${res.person.length}: ${res.person.slice(0, 5).map((p) => p.name).join(', ')}`);
  if (!parts.length) return res?.checked ? `silence check: ${res.checked} people have a baseline, all within the normal range` : 'silence check: no baseline available to judge from';
  return parts.join('; ');
}

/** Member list of one agency; people with no agency set are treated as ungrouped */
export function membersOfAgency(people, agency) {
  return (people ?? []).filter((p) => String(p.agency ?? '') === String(agency));
}

/** Recover the agency name from an agency self-hosted domain (the official-* sources point at the agency's own domain) */
export function agencyFromSourceUrl(url) {
  const host = urlHost(url);
  const hit = AGENCY_HOSTS.find((h) => host === h || host.endsWith('.' + h));
  return hit ?? null;
}
