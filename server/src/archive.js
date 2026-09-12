// archive.js — SQLite 增量归档 / incremental SQLite archive
//
// 为什么需要一层归档：情报现在是「每天一份 JSON」，够用但做不了趋势分析 ——
// 「这个来源最近是不是变差了」「这个人多久没动静了」「哪个关键词最近在涨」
// 都要把几十份文件全读一遍再自己聚合。归档层负责：
//
//   1) **增量写入**：按条目 id 幂等（`INSERT OR IGNORE`），同一天重跑不会产生重复
//   2) **每日汇总**：写入时顺手更新 daily 计数，图表不必扫全表
//   3) **可查询**：按天/来源/人/关键词出时间序列
//
// 三个必须做对的地方：
//   · **幂等**：运行会重跑、补跑，重复计数会让图表悄悄失真
//   · **参数化**：任何来自外部的值（来源 id、日期）一律绑定参数，不做字符串拼接
//   · **迁移**：这是要随发行版一起交付的库文件，加列必须能被老库平滑升级
//
// 用的是 Node 24 自带的 node:sqlite（同样用于读浏览器 cookie），**不引入新依赖**。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDir } from './config.js';

export const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  // v1：初始结构
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

/** 打开（必要时创建并迁移）归档库 */
export function openArchive(cfg, { file = null } = {}) {
  const p = file ?? archivePath(cfg);
  if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

/** 按 user_version 逐级迁移 —— 老库必须能被新版本平滑接上 */
export function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  return { from: current, to: MIGRATIONS.length };
}

/** 条目里的日期 → 归档用的 day 列（UTC 日历日；没有就落到运行日） */
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
 * 增量写入一批条目。
 * 幂等：同一条 id 重复写入会被忽略（并单独计数），因此补跑不会污染图表。
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
  // 整批一个事务：逐条 INSERT 会各起一个隐式事务（1000 条 = 1000 次 fsync，
  // 实测 3.6 秒）。包起来之后是毫秒级，而且失败会整体回滚，不会留下一半数据。
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
      // node:sqlite 的 run() 返回 { changes, lastInsertRowid }
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
      /* 回滚失败也不再往上抛，交给调用方处理原始错误 */
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
 * 记录一次来源健康检查（按天累加）。
 *
 * 注意不要用「时间戳当主键的一部分」：同一毫秒内的多次写入会被 OR REPLACE 覆盖
 * （自检里 4 次写入只剩 1 条就是这么来的）。健康度天然是**按天聚合**的，
 * 所以主键是 (day, source_id)，写入用累加。
 */
export function recordHealth(db, { day, sourceId, ok, ms = null, error = null, at = new Date().toISOString() }) {
  if (!sourceId) return;
  db.prepare(
    `INSERT INTO source_health (day, source_id, checks, ok, ms_sum, last_error, at)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(day, source_id) DO UPDATE SET
       checks = checks + 1,
       ok = ok + excluded.ok,
       -- 只累加**成功**的耗时：平均耗时是「成功那几次有多快」，
       -- 把失败的那次也算进去会让数字没有意义（自检里 460/3=153 就是这么来的）
       ms_sum = ms_sum + excluded.ms_sum,
       last_error = COALESCE(excluded.last_error, last_error),
       at = excluded.at`
  ).run(day, String(sourceId), ok ? 1 : 0, ok ? Number(ms ?? 0) : 0, error ? String(error).slice(0, 300) : null, at);
}

// ───────────────────────────────────────────── 查询（图表用）

/** 每天条目数；groupBy='source' 时按来源再分组 */
export function series(db, { days = 30, groupBy = 'day', endDay = null } = {}) {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
  if (groupBy === 'source') {
    // 参数化：来源 id 来自数据库，但日期来自调用方，一律绑定
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
  // 补齐空白日：图表不该因为某天没跑就断线
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    out.push({ day: d, items: Number(r?.items ?? 0), alerts: Number(r?.alerts ?? 0), media: Number(r?.media ?? 0) });
  }
  return { from, to: end, days: out };
}

/** 每天活跃的关注对象（按归档里存的人名） */
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

/** 关键词趋势：每个词在各天的出现次数 */
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

/** 来源健康度：成功率与平均耗时（按天累加后的统计） */
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
        // 平均耗时只对成功的那些取，失败的没有耗时可言
        avgMs: ok ? Math.round(Number(r.ms_sum ?? 0) / ok) : null,
      };
    }),
  };
}

/** 归档概况 */
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

/** 分页查询条目（参数化，外部值一律绑定） */
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
    // people 列是 JSON 数组文本；用 LIKE 做包含判断（值仍然参数化）
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

/** 把最近一次运行的结果写进归档（失败绝不影响运行本身） */
/**
 * 按人取「最新几条」内容 —— 给「停止活动/毕业」区块用。
 *
 * 注意跟 queryItems 的差别：这里要的是**每个人的最后一条**，而那条可能在很久以前
 * （半年、一年），所以不能按「最近 N 天」筛，只能按人查、按天倒序取前几条。
 * people 列是 JSON 数组，用带引号的 LIKE 匹配（personId 是我们自己生成的 id，不含通配符）。
 */
export function latestItemsByPerson(db, { personIds = [], limit = 2 } = {}) {
  const out = {};
  const n = Math.max(1, Number(limit) || 2);
  // 排序有两层讲究：
  //   1. 用 COALESCE(published_at, day) —— 条目**自己的日期**在 published_at，
  //      day 是**入库日**（回溯抓取时两者差很远）。只按 day 排会把「半年前发的内容
  //      今天才入库」当成最新，对「他最后一条是什么」这种问题就是错的。
  //   2. **有自己日期的排前面**：没有 published_at 的条目只能退回入库日，
  //      而一次回溯抓取会让它们全部变成「今天」。对「他最后一条」这种问题，
  //      宁可给一条日期确切的旧内容，也不要给一条日期不明的。
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
      /* 关不掉也没关系 */
    }
  }
}
