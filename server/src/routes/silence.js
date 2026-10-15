// routes/silence.js — the silence endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { openArchive, peopleSeries, series } from '../archive.js';
import { detectSilence, silenceSummary } from '../silence.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSilenceRoutes(app, { getConfig, patchConfig, log }) {
    // ── silence ──────────────────────────────────────────────────────
    // "no activity" is intel too: this lays out "who stopped, for how long, and whether the whole agency stopped together".
    // The criteria are in silence.js (relative to each person's own rhythm); this side only fetches, computes and returns.
    app.get('/api/silence', (req, res) => {
      const cfg = getConfig();
      const days = Math.max(7, Math.min(365, Number(req.query.days ?? cfg?.silence?.basisDays ?? 60)));
      let db = null;
      try {
        db = openArchive(cfg);
        const series = peopleSeries(db, { days, cfg });
        const result = detectSilence({
          byDay: series.byDay,
          people: cfg.people ?? [],
          rules: cfg.silence ?? {},
          now: new Date(),
          cfg,
        });
        res.json({
          ok: true,
          days,
          people: (cfg.people ?? []).length,
          ...result,
          summary: silenceSummary(result),
        });
      } catch (e) {
        res.json({ ok: false, error: e.message, people: (cfg.people ?? []).length, person: [], group: [], checked: 0, skippedNoBaseline: 0 });
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    });
}
