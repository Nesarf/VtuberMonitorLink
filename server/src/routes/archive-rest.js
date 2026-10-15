// routes/archive-rest.js — the archive endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { archiveRun, healthSeries, keywordSeries, openArchive, peopleSeries, queryItems, recentSeries, series } from '../archive.js';
import { todayIn } from '../day.js';
import { latestIntel } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerArchiveRestRoutes(app, { getConfig, patchConfig, log }) {
    app.get('/api/archive/series', (req, res) => {
      const cfg = getConfig();
      // The chart's time range. A range shorter than a week is answered from the items rather than from the
      // daily table, which cannot see below a day; the bucket width is stated per range so that every range
      // draws a readable number of points (thirty minutes in one-minute buckets, three days in six-hour
      // ones). `days` is still accepted: it is the same request for the day-based ranges, and it is what
      // this endpoint took before the selector offered the short ones.
      const RANGES = {
        '30m': { minutes: 30, bucket: 1 },
        '1h': { minutes: 60, bucket: 5 },
        '4h': { minutes: 240, bucket: 15 },
        '12h': { minutes: 720, bucket: 60 },
        '1d': { minutes: 1440, bucket: 120 },
        '3d': { minutes: 4320, bucket: 360 },
        '7d': { days: 7 },
        '30d': { days: 30 },
        '90d': { days: 90 },
        '180d': { days: 180 },
        '360d': { days: 360 },
      };
      const range = String(req.query.range ?? '').trim();
      const spec = RANGES[range] ?? null;
      const days = Math.max(1, Math.min(365, Number(spec?.days ?? req.query.days ?? 30)));
      let db = null;
      try {
        db = openArchive(cfg);
        if (spec && !spec.days) {
          const r = recentSeries(db, {
            minutes: spec.minutes,
            bucketMinutes: spec.bucket,
            keywordLimit: Number(req.query.keywords ?? 12),
          });
          res.json({
            ok: true,
            range,
            bucket: r.bucket,
            daily: { from: r.from, to: r.to, days: r.days },
            bySource: { from: r.from, to: r.to, days: [], totals: r.totals },
            people: { from: r.from, to: r.to, totals: r.peopleTotals, byDay: {} },
            keywords: { from: r.from, to: r.to, keywords: r.keywords },
            health: { from: r.from, to: r.to, sources: r.health, granularity: 'day' },
          });
          return;
        }
        res.json({
          ok: true,
          range: range || `${days}d`,
          bucket: { minutes: 1440 },
          daily: series(db, { days, cfg }),
          bySource: series(db, { days, groupBy: 'source', cfg }),
          people: peopleSeries(db, { days, cfg }),
          keywords: keywordSeries(db, { days, limit: Number(req.query.keywords ?? 12), cfg }),
          health: healthSeries(db, { days, cfg }),
        });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    });

    app.get('/api/archive/items', (req, res) => {
      const cfg = getConfig();
      let db = null;
      try {
        db = openArchive(cfg);
        const items = queryItems(db, {
          day: req.query.day ?? null,
          sourceId: req.query.source ?? null,
          personId: req.query.person ?? null,
          q: req.query.q ?? null,
          limit: Number(req.query.limit ?? 100),
          offset: Number(req.query.offset ?? 0),
        });
        res.json({ ok: true, count: items.length, items });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    });

    // backfill the latest intel into the archive (to add history after an upgrade, or to rebuild when the archive was deleted)
    app.post('/api/archive/ingest', (req, res) => {
      const cfg = getConfig();
      const limit = Number(req.body?.limit ?? 500);
      const data = latestIntel(cfg, limit);
      // The fallback is the **local** day, for the same reason the run's own date is (see runner.js): this
      // day becomes the bucket for every item in the batch that carries no timestamp of its own.
      const fallbackDay = todayIn(cfg) ?? String(data.date ?? '').slice(0, 10);
      const r = archiveRun(cfg, { date: data.date ?? fallbackDay, items: data.items ?? [] });
      res.json({ ok: r.ok, ...r });
    });
}
