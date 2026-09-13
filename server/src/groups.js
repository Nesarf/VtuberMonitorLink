// groups.js — group view: aggregate "follow people" into "look at a whole agency"
//
// Why this is needed: a per-item intel stream suits "what is in the news today" but not "how is this agency doing right now".
// Judging the state of an agency means looking at the shape of **a group of people** over time:
//   · who is active and who stopped (absence is information too)
//   · whether they are active **at the same time** (several people active on the same day = a project/collab, not N unrelated news items)
//   · whether they stop **at the same time** (a whole agency going quiet = a signal worth a look)
//   · whether each person is off their **own** rhythm (a daily poster silent for 3 days vs a monthly poster silent for 3 days are really not the same thing)
//
// This module only aggregates, it does not judge: it turns those four things into structured data for a human to read.
// Pure functions (input byDay + people + a date axis), so the self-test can pin the shape down.
import { baselineOf, toleranceDays, SILENCE_DEFAULTS } from './silence.js';

const DAY_MS = 86400000;
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

/** Build a date axis (including today), ascending */
export function dayAxis(days, endDay = null) {
  const end = endDay ?? dayOf(new Date());
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(Date.parse(end + 'T00:00:00Z') - i * DAY_MS));
  return out;
}

/**
 * Aggregate the members of one agency into a single block.
 *
 * @param {object} o
 * @param {Array}  o.members   members (the people in people with the same agency)
 * @param {object} o.byDay     archive.peopleSeries().byDay: { personId: { day: n } }
 * @param {string[]} o.axis    date axis (ascending)
 * @param {object} o.rules     config.silence (reuses the same rhythm criteria)
 * @param {Date}   o.now
 */
export function agencyBlock({ agency, members = [], byDay = {}, axis = [], rules = {}, now = new Date() } = {}) {
  const r = { ...SILENCE_DEFAULTS, ...rules };
  const rows = members.map((p) => {
    const days = byDay[String(p.id)] ?? {};
    const baseline = baselineOf(days, { now, sampleDays: r.sampleDays });
    const tol = toleranceDays(baseline, r);
    const counts = axis.map((d) => Number(days[d] ?? 0));
    const active = counts.filter((n) => n > 0).length;
    const level = !tol || baseline.quietDays === null ? 'unknown' : baseline.quietDays >= tol * 2 ? 'high' : baseline.quietDays >= tol ? 'warn' : 'ok';
    return {
      id: String(p.id),
      name: p.name ?? String(p.id),
      aliases: p.aliases ?? [],
      tags: p.tags ?? [],
      counts, // per-day item counts aligned one-to-one with axis (used directly by the heatmap)
      activeDays: active,
      items: counts.reduce((a, b) => a + b, 0),
      lastDay: baseline.lastDay,
      quietDays: baseline.quietDays,
      gapDays: baseline.gapDays,
      toleranceDays: tol,
      level,
    };
  });

  // Daily totals (agency-level rhythm)
  const perDay = axis.map((_, i) => rows.reduce((a, row) => a + row.counts[i], 0));

  // Co-occurrence: >=2 people active on the same day -> most likely a project/collab, not N independent news items
  const coActive = [];
  let allActiveDays = 0;
  for (let i = 0; i < axis.length; i++) {
    const who = rows.filter((row) => row.counts[i] > 0).map((row) => row.name);
    if (who.length >= 2) coActive.push({ day: axis[i], members: who, count: who.length });
    if (rows.length >= 2 && who.length === rows.length) allActiveDays++;
  }

  // Shared silence: counting back from the end of the axis, how many consecutive days **not a single member was active**
  let quietStreak = 0;
  for (let i = axis.length - 1; i >= 0; i--) {
    if (perDay[i] > 0) break;
    quietStreak++;
  }

  const silent = rows.filter((row) => row.level === 'warn' || row.level === 'high').sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0));
  const activeLast7 = rows.filter((row) => row.counts.slice(-7).some((n) => n > 0)).length;

  // Agency-level signal: the whole agency is quiet (nobody was active), or most of its people are silent at once.
  // Both require >= minMembers -- treating "1~2 people" as an agency would fire the signal constantly,
  // which is noise rather than information (anyone who really cares about a duo can set minMembers to 2).
  const minMembers = Number(r.minMembers) || SILENCE_DEFAULTS.minMembers;
  const groupSignal =
    rows.length < minMembers
      ? null
      : quietStreak >= (Number(r.groupQuietDays) || SILENCE_DEFAULTS.groupQuietDays)
        ? { level: 'high', kind: 'all-quiet', days: quietStreak, reason: `整箱 ${rows.length} 人已经 ${quietStreak} 天没有任何动静` }
        : silent.length >= 2 && silent.length >= rows.length - 1
          ? { level: 'warn', kind: 'most-quiet', days: Math.min(...silent.map((s) => s.quietDays ?? 0)), reason: `${rows.length} 人里有 ${silent.length} 人同时安静` }
          : null;
  return {
    agency,
    members: rows.sort((a, b) => b.items - a.items || a.name.localeCompare(b.name)),
    perDay,
    totals: { items: rows.reduce((a, r2) => a + r2.items, 0), members: rows.length, activeMembers: rows.filter((r2) => r2.items > 0).length },
    activeLast7,
    coActiveDays: coActive.length,
    coActive: coActive.slice(-8).reverse(), // the most recent "several people active at once"
    fullHouseDays: allActiveDays,
    quietStreak,
    silent,
    // quietStreak stays a number: no "signal" is emitted when there are too few members, but the data still goes to the UI
    groupSignal,
  };
}

/**
 * Aggregate all followed people by agency.
 * People with no agency go into an explicit "ungrouped" block (never silently dropped).
 */
export function groupView({ byDay = {}, people = [], days = 30, rules = {}, now = new Date(), endDay = null } = {}) {
  const axis = dayAxis(days, endDay);
  const byAgency = new Map();
  const ungrouped = [];
  for (const p of people ?? []) {
    const a = String(p.agency ?? '').trim();
    if (!a) {
      ungrouped.push(p);
      continue;
    }
    if (!byAgency.has(a)) byAgency.set(a, []);
    byAgency.get(a).push(p);
  }
  const groups = [...byAgency.entries()]
    .map(([agency, members]) => agencyBlock({ agency, members, byDay, axis, rules, now }))
    .sort((a, b) => b.totals.items - a.totals.items || String(a.agency).localeCompare(String(b.agency)));

  return {
    from: axis[0],
    to: axis[axis.length - 1],
    days,
    axis,
    groups,
    ungrouped: ungrouped.length
      ? agencyBlock({ agency: null, members: ungrouped, byDay, axis, rules, now })
      : null,
    people: (people ?? []).length,
  };
}
