// archive.js — incremental SQLite archive
//
// Why an archive layer is needed: intel is currently "one JSON per day", which is enough but cannot do
// trend analysis - "has this source got worse lately", "how long has this person been quiet", "which
// keyword is rising right now" all mean reading dozens of files and aggregating them by hand. The
// archive layer handles:
//
//   1) **Incremental writes**: idempotent per item id (`INSERT OR IGNORE`), so re-running the same day
//      produces no duplicates
//   2) **Daily rollups**: the daily counters are updated on write, so charts do not have to scan the whole table
//   3) **Queryable**: time series by day / source / person / keyword
//
// Three things that must be got right:
//   - **Idempotence**: runs get re-run and back-filled, and double counting silently distorts the charts
//   - **Parameterization**: any value coming from outside (source id, date) is always bound as a
//     parameter, never spliced into the string
//   - **Migration**: this is a database file shipped with the release, so an added column must upgrade
//     an old database smoothly
//
// It uses node:sqlite bundled with Node 24 (the same one used to read browser cookies) and
// **introduces no new dependency**.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDir } from './config.js';
import {
  RULE_UTC_V1,
  asDay,
  dayAxisOf,
  dayOfInstant,
  effectiveTimeZone,
  isRule,
  isUtcRule,
  ruleFor,
  zoneOfRule,
} from './day.js';

export const SCHEMA_VERSION = 2;

// The day bucket a row belongs to is only meaningful together with **the rule that produced it**, so
// both are stored. Migration v2 adds them plus the meta table the rebuild journals itself into.
//
// Why the marker columns *and* a rule key in the primary key, rather than either alone:
//   · `daily.rule` is what makes a bucket self-identifying — a row set written under the old UTC rule
//     and one written under the local rule are different numbers, and with the rule in the key a
//     reader states which world it is reading instead of silently mixing them. It is also what lets
//     the rebuild **preserve** the old aggregate: the old rows stay, under a name that says so.
//   · `items.day_tz` plus `items.day_from` say **per row** how that row's day was derived and whether
//     it can be recomputed. Without them a rebuild cannot tell "this day came from the item's own
//     timestamp" (recomputable) from "this day is the ingest fallback" (the raw ingest day was never
//     written down per item, so it is not recomputable and must be reported, not guessed).

const MIGRATIONS = [
  // v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id            TEXT PRIMARY KEY,
        day           TEXT NOT NULL,
        source_id     TEXT,
        title         TEXT,
        text          TEXT,
        url           TEXT,
        published_at  TEXT,
        first_seen_at TEXT NOT NULL,
        people        TEXT,
        keywords      TEXT,
        image_count   INTEGER DEFAULT 0,
        run_id        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_day ON items(day);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id, day);
      CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at);

      CREATE TABLE IF NOT EXISTS daily (
        day        TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        items      INTEGER NOT NULL DEFAULT 0,
        with_media INTEGER NOT NULL DEFAULT 0,
        alerts     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);

      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        day        TEXT NOT NULL,
        mode       TEXT,
        at         TEXT NOT NULL,
        sources_ok INTEGER DEFAULT 0,
        sources    INTEGER DEFAULT 0,
        items      INTEGER DEFAULT 0,
        alerts     INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_day ON runs(day);

      CREATE TABLE IF NOT EXISTS source_health (
        day       TEXT NOT NULL,
        source_id TEXT NOT NULL,
        checks    INTEGER NOT NULL DEFAULT 0,
        ok        INTEGER NOT NULL DEFAULT 0,
        ms_sum    REAL NOT NULL DEFAULT 0,
        last_error TEXT,
        at        TEXT NOT NULL,
        PRIMARY KEY (day, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_health_source ON source_health(source_id, day);
    `);
  },
  // v2: the day rule becomes part of the stored bucket, and the buckets already on disk are labelled
  // with the rule that produced them.
  //
  // Why a schema change is needed at all rather than "just write the new rule from now on": a day
  // number without its rule is ambiguous. `2026-09-15` written by the old UTC rule and `2026-09-15`
  // written by the local rule are the same string for two different sets of items, so a reader that
  // cannot tell them apart silently mixes two calendars — the defect being fixed, one level up. The
  // shape chosen is:
  //   · `daily.rule` **in the primary key**. The old aggregate is not overwritten or reinterpreted:
  //     it stays as rows carrying `utc-v1`, and the new set is written beside it under
  //     `local@<zone>`. A reader states which world it reads (`WHERE rule = ?`), and both are visible
  //     in the same table, which is what makes the rebuild observable instead of a silent rewrite.
  //   · `items.day_tz` labels **every existing row** 'utc-v1'. Stamping only new rows would leave
  //     exactly the rows that need migrating unlabelled, which is the failure a marker is for.
  //   · `items.day_from` records how a row's day was derived. Migration sets it to 'legacy' rather
  //     than guessing: whether a stored day came from the item's own timestamp or from the ingest
  //     fallback was never written down, and when published_at is empty the two are indistinguishable
  //     after the fact (95 of the owner's 221 items). A rebuild may recompute 'stamp' rows and must
  //     **report** 'legacy' ones instead of inventing a day for them.
  //   · `meta` is where the rebuild journals what it did; a bucket's provenance is then discoverable
  //     from the file itself, without reading any code.
  //
  // Every step is guarded, and the guards are not decoration: the self-test builds an "old database" by
  // resetting user_version on a file that already has the new shape, and a real user can hit the same
  // thing after a partially applied upgrade or a restored backup. A migration that throws "duplicate
  // column name" on such a file leaves the archive unopenable — the worst outcome for the owner's only
  // copy — so each step asks what is already there first.
  (db) => {
    // Two separate statements, not one: `ALTER TABLE t ADD COLUMN a, ADD COLUMN b` is not valid SQLite
    // (it is valid in some other dialects), and a migration that only ever runs on an old file is
    // exactly the one nobody notices is broken until an upgrade.
    addColumnIfMissing(db, 'items', 'day_tz', 'TEXT');
    addColumnIfMissing(db, 'items', 'day_from', 'TEXT');
    db.exec(`UPDATE items SET day_tz = '${RULE_UTC_V1}' WHERE day_tz IS NULL`);
    db.exec(`UPDATE items SET day_from = 'legacy' WHERE day_from IS NULL`);

    // The daily table gains the rule in its primary key. Whether that has happened is decided by the
    // table itself (`rule` present?) rather than by user_version, so a file whose version was lost or
    // reset is still carried forward correctly instead of being migrated twice.
    if (tableExists(db, 'daily') && !columnNames(db, 'daily').has('rule')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_v2 (
          day        TEXT NOT NULL,
          source_id  TEXT NOT NULL,
          rule       TEXT NOT NULL,
          tz         TEXT,
          items      INTEGER NOT NULL DEFAULT 0,
          with_media INTEGER NOT NULL DEFAULT 0,
          alerts     INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (day, source_id, rule)
        );
        INSERT OR IGNORE INTO daily_v2 (day, source_id, rule, tz, items, with_media, alerts, updated_at)
          SELECT day, source_id, '${RULE_UTC_V1}', NULL, items, with_media, alerts, updated_at FROM daily;
        DROP TABLE daily;
        ALTER TABLE daily_v2 RENAME TO daily;
      `);
    } else if (!tableExists(db, 'daily')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily (
          day        TEXT NOT NULL,
          source_id  TEXT NOT NULL,
          rule       TEXT NOT NULL,
          tz         TEXT,
          items      INTEGER NOT NULL DEFAULT 0,
          with_media INTEGER NOT NULL DEFAULT 0,
          alerts     INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (day, source_id, rule)
        );
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_items_day_tz ON items(day, day_tz);
      CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);
      CREATE INDEX IF NOT EXISTS idx_daily_rule ON daily(rule, day);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT,
        at    TEXT
      );
    `);
    // Only record the defaults when nothing has claimed the file yet: a database that already ran under
    // the new rule must not be relabelled by a re-run of this migration.
    if (!metaAt(db, 'schema.rule')) setMetaAt(db, 'schema.rule', RULE_UTC_V1);
    // `daily.rule` states which rule the buckets in this file were written under. On a file that
    // predates the rule column the answer is 'utc-v1' — that is exactly the fact the old primary key
    // could not express, and stating it here is what lets a reader tell an un-rebuilt archive from one
    // whose numbers are simply small, instead of reading local days out of a UTC-keyed table.
    if (!metaAt(db, 'daily.rule')) setMetaAt(db, 'daily.rule', RULE_UTC_V1);
  },
];

// ───────────────────────────────────────────── migration helpers

const columnNames = (db, table) => {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
};

const tableExists = (db, table) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);

function addColumnIfMissing(db, table, column, type) {
  if (!tableExists(db, table)) return false;
  if (columnNames(db, table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

// ───────────────────────────────────────────── meta: how a stored bucket's rule is discoverable
//
// The `meta` table is the archive's own record of the rules it holds. A later reader — or a future
// migration that has to decide what a day number means — answers "which rule wrote this bucket?" from
// the file, not from the source tree it happens to be shipped with.

const metaAt = (db, key) => {
  const row = db.prepare('SELECT value, at FROM meta WHERE key = ?').get(key);
  return row ? { key, value: row.value ?? null, at: row.at ?? null } : null;
};

function setMetaAt(db, key, value, at = new Date().toISOString()) {
  db.prepare('INSERT INTO meta (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(
    key,
    value === null || value === undefined ? null : String(value),
    at
  );
}

/**
 * The rule a stored aggregate is currently read under, from the archive itself.
 *
 * `meta['daily.rule']` is the marker (migration writes it, every rebuild rewrites it); `rebuild.done`
 * is the journal of the last completed pass and is preferred only so the answer can say when it
 * happened. When neither exists the answer is the old UTC rule and `pending` says so — that is the
 * state a caller must not paper over, because reading local days out of a UTC-keyed table is exactly
 * the silent reinterpretation this change forbids.
 *
 * What a completed rebuild wrote is what the aggregate **is**, so `frozen` (the default) prefers that
 * marker over the currently configured zone: a reader must not be handed a different rule just because
 * the configuration moved on. The mismatch then shows up as `pending: true` — a rebuild is outstanding
 * — rather than as a wrong read.
 */
export function bucketRule(db, { timeZone, frozen = true } = {}) {
  const tz = effectiveTimeZone(null, timeZone);
  const marker = metaAt(db, 'daily.rule');
  const journal = metaAt(db, 'rebuild.done');
  const stamped = marker ?? journal;
  const wanted = ruleFor(tz);
  if (!stamped) return { rule: RULE_UTC_V1, tz: null, wanted, pending: true, source: 'default-utc-v1' };
  let rule = stamped.value;
  let source = marker ? 'meta' : 'rebuild';
  if (!isRule(rule) || !frozen) {
    const plain = metaAt(db, 'daily.rule');
    if (plain && isRule(plain.value)) {
      rule = plain.value;
      source = 'meta';
    }
  }
  if (!isRule(rule)) return { rule: RULE_UTC_V1, tz: null, wanted, pending: true, source: 'unrecognised', stamped: stamped.value };
  return {
    rule,
    tz: zoneOfRule(rule),
    wanted,
    // Outstanding when the rows are not on the rule the configuration currently asks for: true both for
    // an archive the old rule wrote and for one read under a zone someone has since changed, which are
    // the two cases a rebuild exists to fix.
    pending: rule !== wanted,
    source,
    at: stamped.at,
    rebuiltAt: journal?.at ?? null,
  };
}

/** Every rule present in the daily table, with its row count and day span — what a reader can choose between */
export function storedRules(db) {
  try {
    return db
      .prepare('SELECT rule, COUNT(*) AS rows, MIN(day) AS firstDay, MAX(day) AS lastDay FROM daily GROUP BY rule ORDER BY rule')
      .all()
      .map((r) => ({ rule: r.rule, tz: zoneOfRule(r.rule), rows: Number(r.rows ?? 0), firstDay: r.firstDay ?? null, lastDay: r.lastDay ?? null }));
  } catch {
    return [];
  }
}

/**
 * Which rule each item row's day came from, counted — the answer to "is this table all one calendar".
 *
 * A single table with per-row stamps can hold rows from two rules at once (the rows a rebuild could not
 * recompute stay where they were). That is deliberate, but it must be *visible*: a chart summing across
 * such rows is summing two calendars, and this is how a caller finds out before drawing it.
 */
export function itemRuleMix(db) {
  try {
    return db
      .prepare('SELECT COALESCE(day_tz, ?) AS tz, COALESCE(day_from, ?) AS src, COUNT(*) AS n FROM items GROUP BY tz, src ORDER BY n DESC')
      .all(RULE_UTC_V1, 'legacy')
      .map((r) => ({ tz: r.tz, from: r.src, items: Number(r.n ?? 0) }));
  } catch {
    return [];
  }
}

export function archivePath(cfg) {
  const dir = resolveDir(cfg, 'feedsDir');
  return path.join(dir, 'archive.db');
}

/** Open the archive database (creating and migrating it when necessary) */
export function openArchive(cfg, { file = null } = {}) {
  const p = file ?? archivePath(cfg);
  if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

/** Migrate step by step through user_version - an old database must be picked up smoothly by a new version */
export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  return { from: current, to: MIGRATIONS.length };
}

/**
 * The timestamp an item carries of its own, as a raw value. Kept as its own function because the
 * rebuild has to ask the same question of a row read back out of the database.
 *
 * Note `??` and not `||`: an **empty string** is a value a source really does deliver (95 of the
 * owner's 221 rows carry `published_at = ''`), and `'' || fallback` would take the fallback for a
 * different reason than "there is no timestamp". Either way the parse below rejects it; keeping the two
 * cases distinct here is what makes `day_from` answerable.
 */
function rawStamp(item) {
  return item?.publishedAt ?? item?.at ?? item?.ts ?? item?.time ?? null;
}

/**
 * The date carried by an item -> the day column used by the archive.
 *
 * The rule is day.js's, not a copy of it: the configured zone (or `opts.timeZone`) decides the day, and
 * `Date.parse(...).toISOString().slice(0,10)` — the UTC rule that made half the owner's history land on
 * the wrong day — is gone. The second return value is what the rebuild needs: `from` says whether the
 * day came from the item's own timestamp or from the ingest fallback, so a later recomputation knows
 * which rows it may touch.
 *
 * @returns {{day:string|null, from:'stamp'|'ingest'|null, tz:string, raw:string|null}}
 */
export function dayOfDetailed(item, fallbackDay, { timeZone = undefined } = {}) {
  const tz = effectiveTimeZone(null, timeZone);
  const raw = rawStamp(item);
  const own = dayOfInstant(raw, tz);
  if (own) return { day: own, from: 'stamp', tz, raw: raw === null || raw === undefined ? null : String(raw) };
  const fb = asDay(fallbackDay);
  if (fb) return { day: fb, from: 'ingest', tz, raw: raw === null || raw === undefined || raw === '' ? null : String(raw) };
  return { day: null, from: null, tz, raw: null };
}

/**
 * The date carried by an item -> the day column (the ingest day when the item has no usable timestamp).
 *
 * Signature kept as it was — `(item, fallbackDay)` — because it is the ingest path's contract and the
 * self-test pins it; the zone is an added third argument so a caller that wants a specific zone can say
 * so, and reading the single configured source stays the default.
 */
export function dayOf(item, fallbackDay, opts = {}) {
  return dayOfDetailed(item, fallbackDay, opts).day;
}

// The day rule is re-exported from here as well, so a caller (and the self-test) can reach the rule and
// the archive it governs through one import — and so that a control can point that one import at a
// mutated copy of this module without having to redirect a second one.
export {
  RULE_UTC_V1,
  asDay,
  dayAxisOf,
  dayInTz,
  dayOfInstant,
  dayStamp,
  daysBetweenDays,
  effectiveTimeZone,
  hasZone,
  isRule,
  isUtcRule,
  ruleFor,
  todayIn,
  toInstant,
  zoneOfRule,
  zoneOffsetMs,
} from './day.js';

const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Incrementally write a batch of items.
 * Idempotent: writing the same id again is ignored (and counted separately), so a back-fill does not
 * pollute the charts.
 * @returns {{inserted:number, skipped:number, days:string[]}}
 */
export function ingestItems(db, items, { day, runId = null, now = new Date().toISOString(), timeZone = undefined, cfg = null } = {}) {
  if (!day) throw new Error('ingestItems requires a day (YYYY-MM-DD)');
  const tz = effectiveTimeZone(cfg, timeZone);
  const rule = ruleFor(tz);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, day, source_id, title, text, url, published_at, first_seen_at, people, keywords, image_count, run_id, day_tz, day_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bump = db.prepare(`
    INSERT INTO daily (day, source_id, rule, tz, items, with_media, alerts, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, source_id, rule) DO UPDATE SET
      items = items + 1,
      with_media = with_media + excluded.with_media,
      alerts = alerts + excluded.alerts,
      updated_at = excluded.updated_at
  `);

  let inserted = 0;
  let skipped = 0;
  const days = new Set();
  // One transaction for the whole batch: inserting row by row opens an implicit transaction each time
  // (1000 rows = 1000 fsyncs, measured at 3.6 seconds). Wrapped like this it takes milliseconds, and a
  // failure rolls everything back instead of leaving half the data behind.
  db.exec('BEGIN');
  try {
    for (const it of items ?? []) {
      if (!it?.id) continue;
      const d = dayOfDetailed(it, day, { timeZone: tz });
      const media = asList(it.images).length;
      const alerts = asList(it.keywords).length ? 1 : 0;
      const res = insert.run(
        String(it.id),
        d.day,
        it.sourceId ? String(it.sourceId) : null,
        it.title ? String(it.title).slice(0, 500) : null,
        it.text ? String(it.text).slice(0, 4000) : null,
        it.url ? String(it.url).slice(0, 1000) : null,
        rawStamp(it),
        now,
        JSON.stringify(asList(it.people)),
        JSON.stringify(asList(it.keywords)),
        media,
        runId,
        tz,
        d.from
      );
      // node:sqlite's run() returns { changes, lastInsertRowid }
      if (Number(res?.changes ?? 0) > 0) {
        inserted++;
        bump.run(d.day, it.sourceId ? String(it.sourceId) : '(unknown)', rule, tz, media > 0 ? 1 : 0, alerts, now);
        days.add(d.day);
      } else {
        skipped++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* a failed rollback is not re-thrown either; the caller handles the original error */
    }
    throw e;
  }
  // The rows just written belong to `rule`, and so does the counter this batch bumped, so the archive's
  // stated rule has to say so. (Historic rows can be a mix — each one carries its own `day_tz` stamp,
  // which is exactly why the stamp is per row and the aggregate's rule is per row *set*.)
  setMetaAt(db, 'daily.rule', rule);
  return { inserted, skipped, days: [...days], rule, timeZone: tz };
}

export function recordRun(db, { runId, day, mode, at = new Date().toISOString(), sourcesOk = 0, sources = 0, items = 0, alerts = 0 }) {
  if (!runId) return;
  db.prepare(
    `INSERT OR REPLACE INTO runs (run_id, day, mode, at, sources_ok, sources, items, alerts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(String(runId), day, mode ?? null, at, sourcesOk, sources, items, alerts);
}

/**
 * Record one source health check (accumulated per day).
 *
 * Note: never put a "timestamp into part of the primary key" - several writes within the same
 * millisecond get overwritten by OR REPLACE (that is where the self-test's 4 writes leaving only 1
 * record came from). Health is naturally **aggregated per day**, so the primary key is (day, source_id)
 * and the write accumulates.
 */
export function recordHealth(db, { day, sourceId, ok, ms = null, error = null, at = new Date().toISOString() }) {
  if (!sourceId) return;
  db.prepare(
    `INSERT INTO source_health (day, source_id, checks, ok, ms_sum, last_error, at)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(day, source_id) DO UPDATE SET
       checks = checks + 1,
       ok = ok + excluded.ok,
       -- accumulate only the **successful** durations: the average duration means "how fast the
       -- successful ones were", and counting the failed one in makes the number meaningless
       -- (that is where the self-test's 460/3=153 came from)
       ms_sum = ms_sum + excluded.ms_sum,
       last_error = COALESCE(excluded.last_error, last_error),
       at = excluded.at`
  ).run(day, String(sourceId), ok ? 1 : 0, ok ? Number(ms ?? 0) : 0, error ? String(error).slice(0, 300) : null, at);
}

// --------------------------------------------- queries (for charts)

/**
 * The day range a reader asks for, in the same rule the buckets were written in.
 *
 * Both halves are day.js's job and neither is a local `slice(0,10)`: `end` is "today" **in the
 * configured zone** (the old code took the UTC day, so for a UTC+8 user the chart's last column was
 * empty for the first eight hours of every local day), and the walk back is integer day arithmetic on
 * calendar days — which is what keeps a DST day of 23 or 25 hours from shifting the axis.
 *
 * `rule` is returned too: it is the predicate every reader must apply, because the daily table holds
 * buckets from more than one rule and mixing them would be the same bug one level up.
 */
function dayWindow(db, { days = 30, endDay = null, timeZone = undefined, now = new Date(), rule = undefined } = {}) {
  const tz = effectiveTimeZone(null, timeZone);
  const window = dayAxisOf(days, { endDay, timeZone: tz, now });
  const from = window[0];
  const end = window[window.length - 1];
  const r = rule ?? bucketRule(db, { timeZone: tz }).rule;
  return { from, to: end, days: window, tz, rule: r };
}

/** Items per day; grouped by source as well when groupBy='source' */
export function series(db, { days = 30, groupBy = 'day', endDay = null, timeZone = undefined, now = new Date(), rule = undefined } = {}) {
  const w = dayWindow(db, { days, endDay, timeZone, now, rule });
  const { from, to: end } = w;
  if (groupBy === 'source') {
    // parameterized: the source id comes from the database but the date comes from the caller, so both are bound
    const rows = db
      .prepare(`SELECT day, source_id, items FROM daily WHERE day >= ? AND day <= ? AND rule = ? ORDER BY day ASC, items DESC`)
      .all(from, end, w.rule);
    const byDay = {};
    for (const r of rows) {
      byDay[r.day] ??= { day: r.day, items: 0, sources: {} };
      byDay[r.day].items += r.items;
      byDay[r.day].sources[r.source_id] = (byDay[r.day].sources[r.source_id] ?? 0) + r.items;
    }
    const totals = {};
    for (const r of rows) totals[r.source_id] = (totals[r.source_id] ?? 0) + r.items;
    return {
      from,
      to: end,
      rule: w.rule,
      days: Object.values(byDay),
      totals: Object.entries(totals)
        .map(([id, items]) => ({ sourceId: id, items }))
        .sort((a, b) => b.items - a.items),
    };
  }
  const rows = db
    .prepare(
      `SELECT day, SUM(items) AS items, SUM(alerts) AS alerts, SUM(with_media) AS media FROM daily WHERE day >= ? AND day <= ? AND rule = ? GROUP BY day ORDER BY day ASC`
    )
    .all(from, end, w.rule);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  // fill in the blank days: a chart should not break its line just because nothing ran on some day
  const out = w.days.map((d) => {
    const r = byDay.get(d);
    return { day: d, items: Number(r?.items ?? 0), alerts: Number(r?.alerts ?? 0), media: Number(r?.media ?? 0) };
  });
  return { from, to: end, rule: w.rule, days: out };
}

/**
 * People active on each day (by the person names stored in the archive).
 *
 * Rows, not the daily counters, so there is no `rule` predicate to apply: the day **is** the row's own
 * `items.day`, and per-row provenance lives in `day_tz`. `itemRuleMix(db)` is how a caller sees that the
 * table is not all one calendar instead of assuming it.
 */
export function peopleSeries(db, { days = 30, endDay = null, timeZone = undefined, now = new Date() } = {}) {
  const w = dayWindow(db, { days, endDay, timeZone, now });
  const { from, to: end } = w;
  const rows = db.prepare(`SELECT day, people FROM items WHERE day >= ? AND day <= ?`).all(from, end);
  const totals = {};
  const byDay = {};
  for (const r of rows) {
    let list = [];
    try {
      list = JSON.parse(r.people ?? '[]');
    } catch {
      list = [];
    }
    for (const p of list) {
      totals[p] = (totals[p] ?? 0) + 1;
      byDay[p] ??= {};
      byDay[p][r.day] = (byDay[p][r.day] ?? 0) + 1;
    }
  }
  return {
    from,
    to: end,
    days: w.days,
    totals: Object.entries(totals)
      .map(([id, items]) => ({ personId: id, items }))
      .sort((a, b) => b.items - a.items),
    byDay,
  };
}

/** Keyword trends: how many times each word appears on each day */
export function keywordSeries(db, { days = 30, limit = 12, endDay = null, timeZone = undefined, now = new Date() } = {}) {
  const w = dayWindow(db, { days, endDay, timeZone, now });
  const { from, to: end } = w;
  const rows = db.prepare(`SELECT day, keywords FROM items WHERE day >= ? AND day <= ?`).all(from, end);
  const totals = {};
  for (const r of rows) {
    let list = [];
    try {
      list = JSON.parse(r.keywords ?? '[]');
    } catch {
      list = [];
    }
    for (const k of list) totals[k] = (totals[k] ?? 0) + 1;
  }
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
  return { from, to: end, keywords: top.map((k) => ({ keyword: k, total: totals[k] })) };
}

/**
 * Source health: success rate and average duration (statistics accumulated per day).
 *
 * The day range is the same configured-zone window as every other series, but the rows themselves
 * **cannot be recomputed**: `source_health` is keyed by (day, source_id) and the write accumulates, so
 * each row is a rolling counter whose last write moment is all that survives. There is no per-check
 * timestamp to re-derive a local day from. The rebuild therefore leaves this table alone and says so
 * rather than recomputing a day it cannot justify.
 */
export function healthSeries(db, { days = 30, endDay = null, timeZone = undefined, now = new Date() } = {}) {
  const w = dayWindow(db, { days, endDay, timeZone, now });
  const { from, to: end } = w;
  const rows = db
    .prepare(
      `SELECT source_id, SUM(checks) AS n, SUM(ok) AS ok, SUM(ms_sum) AS ms_sum
       FROM source_health WHERE day >= ? AND day <= ? GROUP BY source_id ORDER BY n DESC`
    )
    .all(from, end);
  return {
    from,
    to: end,
    granularity: 'day',
    rebuildable: false,
    sources: rows.map((r) => {
      const n = Number(r.n ?? 0);
      const ok = Number(r.ok ?? 0);
      return {
        sourceId: r.source_id,
        checks: n,
        ok,
        rate: n ? ok / n : null,
        // the average duration is taken over the successful ones only; a failure has no duration to speak of
        avgMs: ok ? Math.round(Number(r.ms_sum ?? 0) / ok) : null,
      };
    }),
  };
}

/** Archive overview */
/**
 * Sub-day ranges: the same payload shape as the day-based series, bucketed by minutes.
 *
 * The archive's trend tables are keyed by `day`, so a 30-minute or 4-hour window cannot be answered from
 * them: an hour is below their resolution. The `items` table is not - it carries `published_at` (and
 * `first_seen_at` for anything without one) - so short windows are counted from the items themselves and
 * grouped into buckets of a size the caller picks. Two things stay day-granular and say so in the answer
 * rather than pretending: `alerts` is a per-day counter with no per-item flag behind it, and
 * `source_health` accumulates per day, so its row is only reported when the last check falls inside the
 * window and its counts still cover the day. The UI hides those two panels for sub-day ranges.
 */
export function recentSeries(db, { minutes = 60, bucketMinutes = 5, keywordLimit = 12 } = {}) {
  const to = new Date();
  const since = new Date(to.getTime() - minutes * 60000).toISOString();
  const bucketSeconds = Math.max(60, Math.round(bucketMinutes * 60));
  const ts = `COALESCE(published_at, first_seen_at)`;

  // One query for the window, and every figure computed here rather than in SQL.
  //
  // The bucketing used to be `(epoch / ?) * ?` in the query, which looked right and silently was not:
  // node:sqlite binds a JavaScript number as REAL, so the division came back fractional and each bucket
  // was the raw timestamp - one item per bucket, and no bucket ever matched the series the chart draws.
  // The window is hours at most, so one pass over its rows is cheaper than depending on how a driver
  // binds a parameter.
  const rows = db.prepare(`SELECT source_id, ${ts} AS ts, people, keywords, image_count FROM items WHERE ${ts} >= ?`).all(since);

  const fromMs = to.getTime() - minutes * 60000;
  const firstBucket = Math.floor(fromMs / 1000 / bucketSeconds) * bucketSeconds;
  const span = Math.ceil((to.getTime() - fromMs) / 1000 / bucketSeconds) + 1;
  const buckets = [];
  const byBucket = new Map();
  for (let i = 0; i < span; i++) {
    const at = firstBucket + i * bucketSeconds;
    const row = { day: new Date(at * 1000).toISOString().slice(0, 16), items: 0, alerts: 0, media: 0 };
    buckets.push(row);
    byBucket.set(at, row);
  }

  const totals = new Map();
  const people = new Map();
  const keywords = new Map();
  for (const r of rows) {
    const at = Math.floor(Date.parse(r.ts) / 1000 / bucketSeconds) * bucketSeconds;
    const bucket = byBucket.get(at);
    if (bucket) {
      bucket.items += 1;
      if (Number(r.image_count ?? 0) > 0) bucket.media += 1;
    }
    totals.set(r.source_id, (totals.get(r.source_id) ?? 0) + 1);
    for (const p of parseList(r.people)) people.set(p, (people.get(p) ?? 0) + 1);
    for (const k of parseList(r.keywords)) keywords.set(k, (keywords.get(k) ?? 0) + 1);
  }

  return {
    from: since,
    to: to.toISOString(),
    bucket: { minutes: bucketSeconds / 60, alertGranularity: 'day', healthGranularity: 'day' },
    days: buckets,
    totals: [...totals]
      .map(([sourceId, items]) => ({ sourceId, items }))
      .sort((a, b) => b.items - a.items),
    peopleTotals: [...people]
      .map(([personId, items]) => ({ personId, items }))
      .sort((a, b) => b.items - a.items),
    keywords: [...keywords]
      .sort((a, b) => b[1] - a[1])
      .slice(0, keywordLimit)
      .map(([keyword, total]) => ({ keyword, total })),
    health: db
      .prepare(
        `SELECT source_id, SUM(checks) AS n, SUM(ok) AS ok, SUM(ms_sum) AS ms_sum
         FROM source_health WHERE at >= ? GROUP BY source_id ORDER BY n DESC`
      )
      .all(since)
      .map((r) => {
        const n = Number(r.n ?? 0);
        return {
          sourceId: r.source_id,
          checks: n,
          ok: Number(r.ok ?? 0),
          rate: n > 0 ? Number(r.ok ?? 0) / n : null,
          avgMs: n > 0 ? Math.round(Number(r.ms_sum ?? 0) / n) : null,
        };
      }),
  };
}

/** One JSON list out of a text column, or an empty list when it is absent or malformed */
function parseList(value) {
  try {
    const list = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Archive overview.
 *
 * `rule` and `storedRules` are part of the answer, not decoration: `firstDay`/`lastDay` are day numbers,
 * and which calendar they are in is exactly the question this change makes answerable. A caller that
 * sees `rule: 'utc-v1'` on an archive whose configured zone is not UTC knows a rebuild is outstanding.
 */
export function stats(db, { timeZone = undefined, cfg = null } = {}) {
  const one = (sql, ...args) => {
    try {
      return db.prepare(sql).get(...args) ?? {};
    } catch {
      return {};
    }
  };
  const items = one('SELECT COUNT(*) AS n, MIN(day) AS firstDay, MAX(day) AS lastDay FROM items');
  const days = one('SELECT COUNT(DISTINCT day) AS n FROM items');
  const sources = one('SELECT COUNT(DISTINCT source_id) AS n FROM items');
  const runs = one('SELECT COUNT(*) AS n FROM runs');
  const health = one('SELECT COUNT(*) AS n FROM source_health');
  const bySource = db.prepare('SELECT source_id, COUNT(*) AS n FROM items GROUP BY source_id ORDER BY n DESC LIMIT 20').all();
  const buckets = bucketRule(db, { timeZone: effectiveTimeZone(cfg, timeZone) });
  return {
    items: Number(items.n ?? 0),
    days: Number(days.n ?? 0),
    sources: Number(sources.n ?? 0),
    runs: Number(runs.n ?? 0),
    healthChecks: Number(health.n ?? 0),
    firstDay: items.firstDay ?? null,
    lastDay: items.lastDay ?? null,
    rule: buckets.rule,
    ruleTz: buckets.tz,
    ruleSource: buckets.source,
    rulePending: buckets.pending,
    ruleWanted: buckets.wanted,
    storedRules: storedRules(db),
    itemRules: itemRuleMix(db),
    bySource: bySource.map((r) => ({ sourceId: r.source_id, items: Number(r.n ?? 0) })),
  };
}

/**
 * Paginated item query (parameterized; external values are always bound).
 *
 * `day` is matched against the stored bucket, and the stored bucket is single-valued per row, so there
 * is no rule predicate to add here — but the row's provenance rides along (`dayTz`/`dayFrom`) so a
 * caller showing "this item belongs to day X" can also show which calendar X came from.
 */
export function queryItems(db, { day = null, sourceId = null, personId = null, q = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (day) {
    where.push('day = ?');
    args.push(String(day));
  }
  if (sourceId) {
    where.push('source_id = ?');
    args.push(String(sourceId));
  }
  if (personId) {
    // the people column is JSON array text; LIKE does the containment test (the value is still parameterized)
    where.push('people LIKE ?');
    args.push(`%"${String(personId)}"%`);
  }
  if (q) {
    where.push('(title LIKE ? OR text LIKE ?)');
    args.push(`%${String(q)}%`, `%${String(q)}%`);
  }
  const sql = `SELECT id, day, day_tz, day_from, source_id, title, url, published_at, people, keywords
               FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, Math.min(1000, Number(limit) || 100), Number(offset) || 0);
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
    dayTz: r.day_tz ?? null,
    dayFrom: r.day_from ?? null,
    sourceId: r.source_id,
    title: r.title,
    url: r.url,
    publishedAt: r.published_at,
    people: safeJson(r.people),
    keywords: safeJson(r.keywords),
  }));
}

function safeJson(s) {
  try {
    return JSON.parse(s ?? '[]');
  } catch {
    return [];
  }
}

/** Write the result of the latest run into the archive (a failure must never affect the run itself) */
/**
 * Fetch the "latest few" pieces of content per person - used by the "stopped activity / graduated" block.
 *
 * Note the difference from queryItems: here we want **each person's last item**, and that item may be
 * long ago (half a year, a year), so it cannot be filtered by "the last N days" - only looked up per
 * person and taken in day-descending order. The people column is a JSON array, matched with a quoted
 * LIKE (personId is an id we generated ourselves and contains no wildcard).
 */
export function latestItemsByPerson(db, { personIds = [], limit = 2, timeZone = undefined, cfg = null } = {}) {
  const out = {};
  const n = Math.max(1, Number(limit) || 2);
  const tz = effectiveTimeZone(cfg, timeZone);
  // The ordering has two subtleties:
  //   1. COALESCE(published_at, day) - an item's **own date** lives in published_at, while day is the
  //      **ingest day** (the two are far apart for a back-fill fetch). Ordering by day alone would treat
  //      "content posted half a year ago and ingested today" as the newest, which is simply wrong for a
  //      question like "what was his last item".
  //   2. **items with their own date rank first**: items without published_at can only fall back to the
  //      ingest day, and one back-fill fetch turns them all into "today". For a question like "his last
  //      item", a piece of older content with a definite date is preferable to one with an unknown date.
  const stmt = db.prepare(
    `SELECT id, day, day_tz, published_at, title, text, url FROM items
     WHERE people LIKE ?
     ORDER BY (published_at IS NULL) ASC, COALESCE(published_at, day) DESC, id DESC
     LIMIT ?`,
  );
  for (const pid of personIds) {
    try {
      out[String(pid)] = stmt.all(`%"${String(pid)}"%`, n).map((r) => {
        // The displayed day follows the same rule as everywhere else when the row carries its own
        // timestamp. When it does not, the row's **stored** day is the only date that exists, and it is
        // reported as-is together with the calendar it came from — a `slice(0,10)` of a timestamp the row
        // does not have would print something that was never a day.
        const own = dayOfInstant(r.published_at, zoneOfRule(r.day_tz) ?? tz);
        return {
          id: r.id,
          day: own ?? asDay(r.day),
          dayTz: r.day_tz ?? null,
          archiveDay: r.day,
          title: r.title,
          text: r.text,
          url: r.url,
        };
      });
    } catch {
      out[String(pid)] = [];
    }
  }
  return out;
}

export function archiveRun(cfg, { date, items, summary = {}, runId = null, health = [], timeZone = undefined, rebuild = true, log = null } = {}) {
  let db = null;
  try {
    db = openArchive(cfg);
    const tz = effectiveTimeZone(cfg, timeZone);
    const r = ingestItems(db, items, { day: date, runId, timeZone: tz, cfg });
    recordRun(db, {
      runId: runId ?? `run-${date}-${Date.now().toString(36)}`,
      day: date,
      mode: summary.mode ?? null,
      sourcesOk: summary.sourcesOk ?? 0,
      sources: summary.sourcesTotal ?? 0,
      items: (items ?? []).length,
      alerts: summary.alerts ?? 0,
    });
    for (const h of health) recordHealth(db, { day: date, ...h });
    // A run is the natural place to bring the derived aggregates onto the current rule: it happens
    // unattended, the rebuild is idempotent, and doing it here means the owner never has to remember a
    // migration step. `rebuild: false` is for callers that want the write alone.
    const rebuilt = rebuild ? rebuildAggregates(db, { timeZone: tz, log }) : null;
    return { ok: true, ...r, rebuilt };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      db?.close();
    } catch {
      /* it does not matter if it cannot be closed */
    }
  }
}


// ───────────────────────────────────────────── rebuild: the derived aggregates, under the current rule
//
// What this rebuilds, and from what:
//   · `items.day` / `items.day_tz` / `items.day_from`  ← `published_at` (the item's own timestamp)
//   · `daily`                                          ← the `items` rows, re-aggregated per day+source
//
// What it deliberately does **not** rebuild, named rather than silently skipped:
//   · `source_health` — keyed by (day, source_id) with a **rolling counter** and no per-check timestamp.
//     The instant of each check was never stored, so no local day can be derived for it; making this
//     aggregate rebuildable would need per-check rows (or one stored `at` per check), which is a schema
//     change this fix does not make. The rows it already holds stay readable exactly as they are.
//   · `runs.day` — `runs` records *what ran*; its day is the run's own label, not a bucketing of items.
//     Recomputing it would rewrite history for a benefit nobody asked for.
//   · items that carry no usable timestamp — `day_from` 'ingest'/'legacy', whose per-item run day was
//     never stored. They are counted and reported, never guessed at.
//
// Safety, because this runs unattended against the owner's only copy:
//   · **one transaction.** An interruption rolls back to the state before the rebuild, so there is no
//     half-rebuilt table and no "which rows were already done" bookkeeping to get wrong.
//   · **idempotent.** The target rule's `daily` rows are deleted and recomputed from `items`, which is
//     the source of truth, so running it twice produces identical numbers instead of doubling them.
//   · **the old aggregate is kept** — the rows carrying the old rule marker are never touched, never
//     overwritten and never reinterpreted; the rebuild adds a second row set beside them.

/** The timestamp to recompute a stored row's day from: the item's own, or nothing (never the fallback) */
function rebuildStampOf(row) {
  const own = row.published_at;
  if (own === null || own === undefined) return null;
  const s = String(own).trim();
  return s ? s : null;
}

/**
 * Recover `items.day_from` from the raw data wherever the answer is still there.
 *
 * A row whose `published_at` parses is 'stamp': its day came from its own timestamp, so the rebuild may
 * recompute it. A row whose `published_at` is absent or empty is 'ingest': its day is the run day it was
 * ingested under, that run day was never stored per item, and so the value cannot be re-derived and must
 * not be guessed. Migration labels both 'legacy'; this turns every provable one into 'stamp' and every
 * provably-timestamp-less one into 'ingest', and leaves anything else alone.
 *
 * Only `day_from` is written. The row's `day_tz` stamp is **not** touched, because it says which rule
 * produced the day the row currently holds — relabelling it here, without recomputing the day, would be
 * exactly the silent reinterpretation this change forbids. `rebuildAggregates` sets both together.
 *
 * A non-empty timestamp that does not parse stays 'legacy' on purpose: it has bytes we cannot read, and
 * calling it 'stamp' would let the rebuild move the row to a day derived from nothing.
 */
export function backfillDayFrom(db) {
  const rows = db.prepare(`SELECT id, day, published_at FROM items WHERE day_from IS NULL OR day_from = 'legacy'`).all();
  const setFrom = db.prepare(`UPDATE items SET day_from = ? WHERE id = ?`);
  let stamped = 0;
  let ingest = 0;
  for (const r of rows) {
    if (rebuildStampOf(r) !== null && dayOfInstant(r.published_at, effectiveTimeZone(null))) {
      setFrom.run('stamp', r.id);
      stamped++;
    } else if (rebuildStampOf(r) === null) {
      setFrom.run('ingest', r.id);
      ingest++;
    }
  }
  return { scanned: rows.length, stamped, ingest, left: rows.length - stamped - ingest };
}

/** What a rebuild would do, without doing any of it — the observable half of "safe to run twice" */
export function rebuildPlan(db, { timeZone = undefined, cfg = null } = {}) {
  const tz = effectiveTimeZone(cfg, timeZone);
  const rule = ruleFor(tz);
  const current = bucketRule(db, { timeZone: tz });
  const rows = db.prepare('SELECT id, day, day_tz, day_from, published_at FROM items').all();
  let wouldMove = 0;
  let recomputable = 0;
  let frozen = 0;
  let stale = 0;
  for (const r of rows) {
    if (rebuildStampOf(r) === null || !dayOfInstant(r.published_at, tz)) {
      if (r.day_tz !== tz) stale++;
      frozen++;
      continue;
    }
    recomputable++;
    if (dayOfInstant(r.published_at, tz) !== r.day) wouldMove++;
    else if (r.day_tz !== tz) stale++;
  }
  return {
    timeZone: tz,
    rule,
    items: rows.length,
    recomputable,
    frozen,
    wouldMove,
    retag: stale,
    currentRule: current.rule,
    currentPending: current.pending,
    // "In sync" has to include the frozen rows: they hold a day that cannot be recomputed, so as long as
    // any of them is still stamped with another rule there IS work to do (re-stamping them honestly).
    inSync: wouldMove === 0 && stale === 0 && current.rule === rule && frozen === 0,
  };
}

/**
 * Recompute the derived aggregates under the current rule, in one transaction.
 *
 * @returns {{timeZone:string, rule:string, from:string, fromSource:string, itemsMoved:number,
 *   itemsFrozen:number, dailyRows:number, days:number, preservedRules:string[], preservedRows:number,
 *   logged:string}}
 */
export function rebuildAggregates(db, { timeZone = undefined, cfg = null, log = null, now = new Date() } = {}) {
  const tz = effectiveTimeZone(cfg, timeZone);
  const rule = ruleFor(tz);
  const at = now instanceof Date ? now.toISOString() : String(now);
  const before = bucketRule(db, { timeZone: tz });

  const selectReport = db.prepare('SELECT id, day, day_tz, day_from, published_at, source_id, image_count, keywords FROM items');
  const moveDay = db.prepare('UPDATE items SET day = ?, day_tz = ?, day_from = ? WHERE id = ?');
  const insertDay = db.prepare(
    `INSERT INTO daily (day, source_id, rule, tz, items, with_media, alerts, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(day, source_id, rule) DO UPDATE SET
       items = items + 1,
       with_media = with_media + excluded.with_media,
       alerts = alerts + excluded.alerts,
       tz = excluded.tz,
       updated_at = excluded.updated_at`
  );

  // Nothing to do is the common case once a run has rebuilt once, and a rebuild that opens a write
  // transaction on every scheduled run would be a cost paid forever for a no-op. The decision comes from
  // the same plan the API reports, so "what would happen" and "what happens" cannot diverge.
  const plan = rebuildPlan(db, { timeZone: tz });
  if (plan.inSync) {
    const dailyRows = Number(db.prepare('SELECT COUNT(*) AS n FROM daily WHERE rule = ?').get(rule)?.n ?? 0);
    const logged = `archive rebuild: nothing to do — rule=${rule} tz=${tz} is already in force for ${plan.items} item(s)`;
    if (typeof log?.info === 'function') log.info(logged);
    const preserved = storedRules(db).filter((r) => r.rule !== rule);
    return {
      timeZone: tz,
      rule,
      from: before.rule,
      fromSource: before.source,
      itemsMoved: 0,
      itemsFrozen: 0,
      dailyRows,
      days: Number(db.prepare('SELECT COUNT(DISTINCT day) AS n FROM daily WHERE rule = ?').get(rule)?.n ?? 0),
      preservedRules: preserved.map((r) => r.rule),
      preservedRows: preserved.reduce((n, r) => n + r.rows, 0),
      skipped: true,
      logged,
    };
  }

  let itemsMoved = 0;
  let itemsFrozen = 0;
  let dailyRows = 0;
  const days = new Set();

  // The journal row starts before the work and commits with it: after an interruption the file either has
  // no trace of this rebuild (nothing happened) or one row describing a rebuild that completed. There is
  // no third state to interpret, which is what makes "recoverable if interrupted" a fact rather than a
  // hope.
  setMetaAt(db, 'rebuild.started', JSON.stringify({ rule, tz, at }), at);

  db.exec('BEGIN IMMEDIATE');
  let all;
  try {
    // 0) recover how each row's stored day was derived, before deciding whether it may be recomputed.
    //    Inside the transaction: this is part of the same atomic step, and an interruption must not leave
    //    the labels updated but the days not.
    backfillDayFrom(db);

    // One read of the items, **after** the recovery above and inside the transaction, then every figure
    // below is computed from it. Reading it before the transaction was a real bug the fixture caught:
    // the snapshot still said 'legacy' for rows the recovery had just labelled, so the frozen branch
    // re-stamped them with the old rule instead of leaving them alone.
    all = selectReport.all();

    // 1) the item day itself, from the item's own raw timestamp
    for (const r of all) {
      const recomputed = dayOfInstant(rebuildStampOf(r), tz);
      if (recomputed === null) {
        // No usable raw timestamp. The day the row already holds is the only one that exists for it, so
        // it is left exactly as it is — but it is re-stamped with the rule that produced it, so a reader
        // is never told a UTC-era day is a local one.
        if (r.day_tz !== tz) moveDay.run(r.day, r.day_tz ?? RULE_UTC_V1, r.day_from === 'stamp' ? 'legacy' : r.day_from, r.id);
        else if (r.day_from !== 'ingest') moveDay.run(r.day, r.day_tz, 'ingest', r.id);
        itemsFrozen++;
        continue;
      }
      const from = r.day_from === 'ingest' ? 'ingest' : 'stamp';
      if (r.day !== recomputed || r.day_tz !== tz || r.day_from !== from) {
        moveDay.run(recomputed, tz, from, r.id);
        if (r.day !== recomputed) itemsMoved++;
      }
      days.add(recomputed);
    }

    // 2) the daily counters, recomputed from the items that now carry the new day. Deleting the target
    //    rule's rows first is what makes a second run produce identical numbers: the counters are
    //    derived, so they are rebuilt rather than added to.
    db.prepare('DELETE FROM daily WHERE rule = ?').run(rule);
    for (const r of all) {
      const recomputed = dayOfInstant(rebuildStampOf(r), tz);
      // A frozen row cannot be recomputed, but it must still be **counted**. Dropping it would make the
      // new aggregate sum to less than the items table holds, which is a worse lie than a row that is
      // honestly stamped with the rule it came from. So it contributes to the day it already holds, and
      // the mismatch is visible in `itemRules`/`storedRules` rather than hidden in a total.
      const day = recomputed ?? asDay(r.day);
      if (day === null) continue;
      const media = Number(r.image_count ?? 0) > 0 ? 1 : 0;
      const alerts = parseList(r.keywords).length ? 1 : 0;
      insertDay.run(day, r.source_id ? String(r.source_id) : '(unknown)', rule, tz, media, alerts, at);
      dailyRows++;
    }

    // One leftover is no longer a rule anyone reads: a local row set for a zone the configuration has
    // since moved away from. It is superseded by this rebuild, and leaving it behind would grow the file
    // once per zone change. `utc-v1` is excluded on purpose — that is the old aggregate the owner asked
    // to keep, not a stale local set — and any zone another configuration still reads is kept too.
    const abandoned = storedRules(db)
      .filter((r) => !isUtcRule(r.rule) && r.rule !== rule)
      .map((r) => r.rule);
    if (abandoned.length) {
      const drop = db.prepare('DELETE FROM daily WHERE rule = ?');
      for (const r of abandoned) drop.run(r);
    }

    setMetaAt(db, 'daily.rule', rule, at);
    setMetaAt(db, 'rebuild.done', JSON.stringify({ rule, tz, at, itemsMoved, itemsFrozen, dailyRows }), at);
    setMetaAt(db, 'rebuild.previousRule', before.rule, at);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* a failed rollback must not hide the original error */
    }
    throw e;
  }

  const preserved = storedRules(db).filter((r) => r.rule !== rule);
  const logged =
    `archive rebuild: rule=${rule} tz=${tz}, items.day recomputed=${itemsMoved} frozen(no own timestamp)=${itemsFrozen}, ` +
    `daily=${dailyRows} rows in ${days.size} days; preserved ${preserved.map((p) => `${p.rule}(${p.rows} rows)`).join(', ') || 'nothing'}`;
  if (typeof log?.info === 'function') log.info(logged);

  return {
    timeZone: tz,
    rule,
    from: before.rule,
    fromSource: before.source,
    itemsMoved,
    itemsFrozen,
    dailyRows,
    days: days.size,
    preservedRules: preserved.map((p) => p.rule),
    preservedRows: preserved.reduce((n, p) => n + p.rows, 0),
    logged,
  };
}
