// routes/groups.js — the groups endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { openArchive, peopleSeries, series } from '../archive.js';
import { groupView } from '../groups.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerGroupsRoutes(app, { getConfig, patchConfig, log }) {
    // ── group view ───────────────────────────────────────────────────
    // "how is this agency doing right now" — group the followed people by agency into one block: a daily heat map,
    // simultaneous appearances, shared silence, and each person's anomaly relative to their own rhythm. A flat item
    // stream simply cannot answer that question.
    app.get('/api/groups', (req, res) => {
      const cfg = getConfig();
      const days = Math.max(7, Math.min(180, Number(req.query.days ?? 30)));
      let db = null;
      try {
        db = openArchive(cfg);
        const series = peopleSeries(db, { days, cfg });
        const view = groupView({
          byDay: series.byDay,
          people: cfg.people ?? [],
          days,
          rules: cfg.silence ?? {},
          now: new Date(),
          cfg,
        });
        res.json({ ok: true, ...view, hasAgency: view.groups.length > 0 });
      } catch (e) {
        res.json({ ok: false, error: e.message, groups: [], ungrouped: null, people: (cfg.people ?? []).length });
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    });
}
