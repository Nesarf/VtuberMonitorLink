// day.js — the one definition of "which calendar day does this instant belong to"
//
// Why this module exists (v1.0.5 defect): the archive derived an item's day with
// `new Date(t).toISOString().slice(0, 10)` — a **UTC** calendar day — while the Calendar feature
// (calendar.js) works in the user's **configured/local** time zone. The same event therefore belonged
// to different days depending on which part of the product you asked, and everything that buckets by
// day disagreed: the daily table, the trend series, per-person daily activity, and the
// silence/dormant baselines. Measured on the owner's archive (feeds/archive.db, 2026-10-08):
// 126 of 221 items carried their own timestamp and **62 of those 126 fall on a different day**
// under Asia/Shanghai than the stored UTC day — almost half the history was mislabelled.
//
// The owner's decision: unify on the **local/configured** time zone (the rule the interface already
// uses), so the archive side changes and the calendar side does not. This module is that one rule.
//
// Three things it has to be, or the fix becomes a second invention:
//   1. **One implementation.** `dayInTz` is the only place a timestamp is reduced to a day string.
//      `calendar.js` re-exports it rather than keeping its own copy, so there is nothing to drift.
//   2. **Explicit or configured, never implicit.** The time zone is either passed in (tests, a query
//      layer asking for a specific zone) or resolved from the single configured source
//      (`cfg.calendar.timeZone`, the field the Calendar tab already owns) — and when that is empty,
//      from the system zone, exactly as `calendar.upcoming()` already does.
//   3. **Usable when writing a bucket and when reading one.** `dayRule(...)` produces the
//      discriminator that is stored beside a bucket, and `ruleOf`/`isRule` recognise it again — a
//      day written under the old UTC rule and one written under the local rule are different numbers
//      and a later reader has to be able to tell which it is looking at.
//
// What is deliberately NOT this rule (see DAY_KEY_CALLERS below): sub-day bucketing
// (archive.recentSeries labels buckets by absolute minute, not by calendar day), pure day-string
// arithmetic on 'YYYY-MM-DD' values that are already days, and filename stamps. The inventory below
// is read by tools/integrity-check.mjs §5m, so a new module cannot start deriving a day key without
// appearing in it — the same shape as URL_POLICY_CALLERS in remote-url.js.

/** the 'YYYY-MM-DD' shape everything downstream expects (also what the daily/items tables store) */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86400000;

/**
 * Does this string end in an explicit UTC designator or numeric offset?
 *
 * This is the difference between "the source told us the instant" and "the source told us a wall
 * clock". `Date.parse('2026-09-15T23:30:00')` silently reads a zone-less string **in the machine's
 * zone**, which is a third answer that is neither the configured zone nor UTC — the exact shape of
 * bug this module exists to remove, so it is detected rather than trusted.
 */
export function hasZone(s) {
  const t = String(s).trim();
  return /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(t);
}

/** 'YYYY-MM-DD' + 'HH:mm:ss' -> the wall-clock fields, or null when it is not a zone-less ISO local time */
function naiveFields(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(String(s).trim());
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] ?? 0),
    ms: Number(String(m[7] ?? '0').padEnd(3, '0')),
  };
}

/** How far the given zone is from UTC at the given instant, in milliseconds (DST included, because it is measured) */
export function zoneOffsetMs(instant, timeZone) {
  // formatToParts rather than a parsed string: 'en-US' prints the same fields whatever the platform's
  // locale data looks like, and hourCycle h23 avoids the "24:00" midnight that h24 can produce.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  // Intl truncates to whole seconds, so compare against the instant truncated the same way
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A zone-less source timestamp read as a wall clock **in the target zone**.
 *
 * Why this and not `Date.parse`: for `2026-09-15T23:30:00` the configured zone and the machine's zone
 * are different answers, and the machine's zone is the one nobody asked for. A feed that prints local
 * times means its own local time; combined with the configured zone that is a single answer. Two
 * passes: the zone's offset itself depends on the instant, so the first guess is refined once (which
 * is what makes a DST boundary resolve correctly rather than by an hour).
 *
 * A wall clock that does not exist (the hour a spring-forward skips) still resolves — to the instant
 * the zone actually jumps to. The day is what is derived from this, and a skipped hour cannot move a
 * day; a repeated hour (fall-back) resolves to its first occurrence, same reasoning.
 */
export function instantFromNaive(s, timeZone) {
  const f = naiveFields(s);
  if (!f) return null;
  const guess = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s, f.ms);
  const first = new Date(guess - zoneOffsetMs(new Date(guess), timeZone));
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

/**
 * Any timestamp shape the product actually sees -> an absolute instant, or null when there is none.
 *
 * Accepted: Date; a finite number (epoch ms); an ISO string with Z or an offset; a zone-less ISO local
 * time (read in `timeZone`, see instantFromNaive). Anything else — '', 'not a time', a day-only string
 * with no time — is **null**, which callers treat as "this item carries no timestamp of its own"
 * rather than as midnight. That distinction is what keeps the archive's fallback honest.
 */
export function toInstant(value, timeZone) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  const s = String(value).trim();
  if (!s) return null;
  if (hasZone(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return instantFromNaive(s, timeZone);
}

/**
 * The calendar day of an instant in a zone.
 *
 * This is the whole rule. It is exported from here and re-exported (not reimplemented) by
 * calendar.js, and it is what archive.js calls both when it writes `items.day` and when it derives
 * the day axis a reader walks. `en-CA` happens to format as exactly YYYY-MM-DD.
 *
 * Returns null for an unusable instant — a caller with a fallback (the ingest day) applies it itself,
 * so that "no timestamp" and "a timestamp that lands on this day" never become the same value here.
 */
export function dayOfInstant(value, timeZone) {
  const at = toInstant(value, timeZone);
  if (!at) return null;
  // Without a zone the system zone is the answer, and Intl accepts `undefined` for exactly that.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** An already-computed day string passes through; used where a caller may hand us either a day or an instant */
export function asDay(value) {
  const s = String(value ?? '').trim();
  return DAY_RE.test(s) ? s : null;
}

/**
 * The name calendar.js has always used for this rule, kept as an alias.
 *
 * Renaming it would be tidier and would also break every existing caller and test for no behavioural
 * gain; the point of this change is that there is **one implementation**, not that it has one spelling.
 */
export const dayInTz = dayOfInstant;

/** 'YYYY-MM-DD' -> the UTC timestamp of that calendar day, for integer-day arithmetic only */
export function dayStamp(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Days between two calendar days: an integer, and deliberately **not** a duration.
 *
 * `(a - b) / 86400000` is the shape that goes wrong on a 23- or 25-hour day; taking both ends as
 * calendar days first makes the difference whole by construction. This is what the silence and
 * dormant baselines measure "how long has this person been quiet" with.
 */
export function daysBetweenDays(fromDay, toDay) {
  const a = asDay(fromDay);
  const b = asDay(toDay);
  if (!a || !b) return null;
  return Math.round((dayStamp(b) - dayStamp(a)) / DAY_MS);
}
/** A day list, ascending, ending at endDay (or today in the zone) — the date axis a bucketed view walks */
export function dayAxisOf(count, { endDay = null, timeZone = undefined, now = new Date() } = {}) {
  const end = asDay(endDay) ?? dayOfInstant(now, timeZone);
  const n = Math.max(1, Number(count) || 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(dayOfInstant(dayStamp(end) - (n - 1 - i) * DAY_MS, 'UTC'));
  return out;
}

// ───────────────────────────────────────────── the one configured source

/**
 * The zone the product works in, resolved from the single configured field — not a new setting.
 *
 * `cfg.calendar.timeZone` is where the interface's "today" already comes from (calendar.js:113), and
 * the Calendar tab is where the user sets it. An archive that invented its own key would be the
 * second definition this change removes, so this resolves that same field; empty means the system
 * zone, which is also what empty means for the calendar. `opts.timeZone` wins when a caller asks for
 * a specific zone on purpose (a query layer pinning a range, a test).
 */
export function effectiveTimeZone(cfg, explicit = undefined) {
  const z = explicit || cfg?.calendar?.timeZone || '';
  if (z) return z;
  // The system zone is the floor. `resolvedOptions()` can be unavailable in a stripped runtime, and the
  // callers here cannot do anything useful with a throw, so the floor is UTC rather than an exception.
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The configured zone's day for "now" — the answer three modules asked for with a `?? UTC-slice` fallback */
export function todayIn(cfg, now = new Date()) {
  return dayOfInstant(now, effectiveTimeZone(cfg));
}

// ───────────────────────────────────────────── the rule that produced a bucket

export const RULE_UTC_V1 = 'utc-v1';
export const RULE_LOCAL_PREFIX = 'local@';

/** The rule marker for a zone. 'utc-v1' is reserved for buckets the old UTC rule produced. */
export function ruleFor(timeZone) {
  const z = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return RULE_LOCAL_PREFIX + z;
}

/** Is this the old UTC rule (the one the release before this one wrote)? */
export function isUtcRule(rule) {
  return String(rule ?? '') === RULE_UTC_V1;
}

/**
 * The zone a stored rule names, or null when it is not a local rule ('utc-v1' included).
 * A reader that wants to re-derive a bucket it is looking at needs this: the marker is what makes a
 * UTC-era day readable as a UTC-era day instead of as a local day that is off by one.
 */
export function zoneOfRule(rule) {
  const s = String(rule ?? '');
  return s.startsWith(RULE_LOCAL_PREFIX) ? s.slice(RULE_LOCAL_PREFIX.length) || null : null;
}

/** Is this rule marker usable as a stored bucket key (either the old one or a well-formed local one)? */
export function isRule(rule) {
  const s = String(rule ?? '');
  return isUtcRule(s) || (s.startsWith(RULE_LOCAL_PREFIX) && s.length > RULE_LOCAL_PREFIX.length);
}

// ───────────────────────────────────────────── the inventory the structural check reads

/**
 * Every module that turns a timestamp into a calendar day, and how.
 *
 * This is an **inventory, not documentation**: tools/integrity-check.mjs §5m reads it and asserts that
 * (a) each row is true of the file it names, and (b) no file under server/src derives a day key while
 * appearing in neither this list nor DAY_KEY_EXEMPT. That is the same shape as URL_POLICY_CALLERS in
 * remote-url.js, and for the same reason: after this change the rule is single-sourced, and the way
 * that stops being true is a new module quietly doing `toISOString().slice(0, 10)` again. A rule
 * nobody can enumerate is a rule that will be re-invented.
 *
 * `via` values:
 *   · 'day.js'   — the module imports the rule from day.js and derives every day key with it
 *   · 'strings'  — it treats days as opaque strings it received (arithmetic on a day, or passing one
 *                  through); it never derives a day from an instant itself
 *   · 'sub-day'  — it buckets by absolute minutes/hours, not by calendar day
 */
export const DAY_KEY_CALLERS = [
  // The rule itself, named here so the inventory is complete about where the rule lives.
  { file: 'server/src/day.js', via: 'day.js' },
  { file: 'server/src/archive.js', via: 'day.js' },
  { file: 'server/src/calendar.js', via: 'day.js' },
  { file: 'server/src/cluster.js', via: 'day.js' },
  { file: 'server/src/cost.js', via: 'day.js' },
  { file: 'server/src/dormant.js', via: 'day.js' },
  { file: 'server/src/groups.js', via: 'day.js' },
  { file: 'server/src/reports.js', via: 'day.js' },
  { file: 'server/src/runner.js', via: 'day.js' },
  { file: 'server/src/server.js', via: 'day.js' },
  // A `strings` row is a stronger claim than it looks: it says the file treats a day as an opaque value
  // it received and never derives one. integrity-check.mjs §5m checks exactly that (a `strings` file
  // containing a derivation is a problem), which is why these are not simply listed as exempt.
  { file: 'server/src/silence.js', via: 'strings', note: 'consumes the day keys it is handed and compares them with day.js day arithmetic; it derives none' },
  { file: 'server/src/notify.js', via: 'strings', note: 'quiet hours are a wall clock in a zone (Intl), not a calendar-day bucket' },
];

/**
 * Files that mention a day shape without deriving a bucket, with the reason.
 *
 * Kept separate from the caller list so that "this module does not use the rule" is a statement someone
 * made on purpose, rather than a row that was never added. Every entry needs a note.
 */
export const DAY_KEY_EXEMPT = [
  { file: 'server/src/share.js', note: 'the bundle header repeats the content date it was given; it derives nothing' },
  { file: 'server/src/vdb.js', note: 'formats a generatedAt stamp for a status line; no bucket is keyed by it' },
];

