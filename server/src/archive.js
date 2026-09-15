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

export const SCHEMA_VERSION = 1;

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
];

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

/** The date carried by an item -> the day column used by the archive (UTC calendar day; the run day when there is none) */
export function dayOf(item, fallbackDay) {
  const raw = item?.publishedAt ?? item?.at ?? item?.ts ?? item?.time ?? null;
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return fallbackDay;
}

const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Incrementally write a batch of items.
 * Idempotent: writing the same id again is ignored (and counted separately), so a back-fill does not
 * pollute the charts.
 * @returns {{inserted:number, skipped:number, days:string[]}}
 */
export function ingestItems(db, items, { day, runId = null, now = new Date().toISOString() } = {}) {
  if (!day) throw new Error('ingestItems requires a day (YYYY-MM-DD)');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, day, source_id, title, text, url, published_at, first_seen_at, people, keywords, image_count, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bump = db.prepare(`
    INSERT INTO daily (day, source_id, items, with_media, alerts, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, source_id) DO UPDATE SET
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
      const d = dayOf(it, day);
      const media = asList(it.images).length;
      const alerts = asList(it.keywords).length ? 1 : 0;
      const res = insert.run(
        String(it.id),
        d,
        it.sourceId ? String(it.sourceId) : null,
        it.title ? String(it.title).slice(0, 500) : null,
        it.text ? String(it.text).slice(0, 4000) : null,
        it.url ? String(it.url).slice(0, 1000) : null,
        it.publishedAt ?? it.at ?? it.time ?? null,
        now,
        JSON.stringify(asList(it.people)),
        JSON.stringify(asList(it.keywords)),
        media,
        runId
      );
      // node:sqlite's run() returns { changes, lastInsertRowid }
      if (Number(res?.changes ?? 0) > 0) {
        inserted++;
        bump.run(d, it.sourceId ? String(it.sourceId) : '(unknown)', media > 0 ? 1 : 0, alerts, now);
        days.add(d);
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
  return { inserted, skipped, days: [...days] };
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

/** Items per day; grouped by source as well when groupBy='source' */
export function series(db, { days = 30, groupBy = 'day', endDay = null } = {}) {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  if (groupBy === 'source') {
    // parameterized: the source id comes from the database but the date comes from the caller, so both are bound
    const rows = db
      .prepare(`SELECT day, source_id, items FROM daily WHERE day >= ? AND day <= ? ORDER BY day ASC, items DESC`)
      .all(from, end);
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
      days: Object.values(byDay),
      totals: Object.entries(totals)
        .map(([id, items]) => ({ sourceId: id, items }))
        .sort((a, b) => b.items - a.items),
    };
  }
  const rows = db
    .prepare(`SELECT day, SUM(items) AS items, SUM(alerts) AS alerts, SUM(with_media) AS media FROM daily WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day ASC`)
    .all(from, end);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  // fill in the blank days: a chart should not break its line just because nothing ran on some day
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    out.push({ day: d, items: Number(r?.items ?? 0), alerts: Number(r?.alerts ?? 0), media: Number(r?.media ?? 0) });
  }
  return { from, to: end, days: out };
}

/** People active on each day (by the person names stored in the archive) */
export function peopleSeries(db, { days = 30, endDay = null } = {}) {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
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
    totals: Object.entries(totals)
      .map(([id, items]) => ({ personId: id, items }))
      .sort((a, b) => b.items - a.items),
    byDay,
  };
}

/** Keyword trends: how many times each word appears on each day */
export function keywordSeries(db, { days = 30, limit = 12, endDay = null } = {}) {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
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

/** Source health: success rate and average duration (statistics accumulated per day) */
export function healthSeries(db, { days = 30, endDay = null } = {}) {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT source_id, SUM(checks) AS n, SUM(ok) AS ok, SUM(ms_sum) AS ms_sum
       FROM source_health WHERE day >= ? AND day <= ? GROUP BY source_id ORDER BY n DESC`
    )
    .all(from, end);
  return {
    from,
    to: end,
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

export function stats(db) {
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
  return {
    items: Number(items.n ?? 0),
    days: Number(days.n ?? 0),
    sources: Number(sources.n ?? 0),
    runs: Number(runs.n ?? 0),
    healthChecks: Number(health.n ?? 0),
    firstDay: items.firstDay ?? null,
    lastDay: items.lastDay ?? null,
    bySource: bySource.map((r) => ({ sourceId: r.source_id, items: Number(r.n ?? 0) })),
  };
}

/** Paginated item query (parameterized; external values are always bound) */
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
  const sql = `SELECT id, day, source_id, title, url, published_at, people, keywords
               FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, Math.min(1000, Number(limit) || 100), Number(offset) || 0);
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
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
export function latestItemsByPerson(db, { personIds = [], limit = 2 } = {}) {
  const out = {};
  const n = Math.max(1, Number(limit) || 2);
  // The ordering has two subtleties:
  //   1. COALESCE(published_at, day) - an item's **own date** lives in published_at, while day is the
  //      **ingest day** (the two are far apart for a back-fill fetch). Ordering by day alone would treat
  //      "content posted half a year ago and ingested today" as the newest, which is simply wrong for a
  //      question like "what was his last item".
  //   2. **items with their own date rank first**: items without published_at can only fall back to the
  //      ingest day, and one back-fill fetch turns them all into "today". For a question like "his last
  //      item", a piece of older content with a definite date is preferable to one with an unknown date.
  const stmt = db.prepare(
    `SELECT id, day, published_at, title, text, url FROM items
     WHERE people LIKE ?
     ORDER BY (published_at IS NULL) ASC, COALESCE(published_at, day) DESC, id DESC
     LIMIT ?`,
  );
  for (const pid of personIds) {
    try {
      out[String(pid)] = stmt.all(`%"${String(pid)}"%`, n).map((r) => ({
        id: r.id,
        day: String(r.published_at ?? r.day ?? '').slice(0, 10),
        archiveDay: r.day,
        title: r.title,
        text: r.text,
        url: r.url,
      }));
    } catch {
      out[String(pid)] = [];
    }
  }
  return out;
}

export function archiveRun(cfg, { date, items, summary = {}, runId = null, health = [] } = {}) {
  let db = null;
  try {
    db = openArchive(cfg);
    const r = ingestItems(db, items, { day: date, runId });
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
    return { ok: true, ...r };
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
