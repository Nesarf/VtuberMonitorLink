// routes/archive.js — the archive endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { archivePath, archiveRun, openArchive, rebuildAggregates, rebuildPlan, stats as archiveStats } from '../archive.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerArchiveRoutes(app, { getConfig, patchConfig, log }) {
    // ── incremental archive & charts ─────────────────────────────────
    // The archive layer is in archive.js, self-tested by tools/archive-test.mjs (idempotency / parameterization / migration / performance).
    // Every run writes incrementally; this side only queries and backfills by hand.
    app.get('/api/archive/stats', (_req, res) => {
      const cfg = getConfig();
      let db = null;
      try {
        db = openArchive(cfg);
        // `cfg` decides the rule the counts are reported under, and the answer carries the rule it read
        // (`rule`/`storedRules`/`itemRules`): an archive whose days are still the old UTC ones says so
        // here instead of looking like an archive whose numbers are simply small.
        res.json({ ok: true, ...archiveStats(db, { cfg }), file: path.basename(archivePath(cfg)) });
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

    // Recompute the derived aggregates under the configured day rule. `?plan=1` reports what would change
    // without changing anything, which is the form a UI (or a nervous owner) should call first.
    //
    // A run does this on its own (see archiveRun), so this route exists for the two cases a run cannot
    // cover: an upgrade where the owner wants the history brought forward now rather than at the next
    // scheduled run, and a look at what a rebuild would do before letting it.
    app.post('/api/archive/rebuild', (req, res) => {
      const cfg = getConfig();
      const dryRun = String(req.query.plan ?? req.body?.plan ?? '') === '1';
      let db = null;
      try {
        db = openArchive(cfg);
        if (dryRun) {
          res.json({ ok: true, plan: rebuildPlan(db, { cfg }), file: path.basename(archivePath(cfg)) });
          return;
        }
        const rebuilt = rebuildAggregates(db, { cfg });
        res.json({ ok: true, ...rebuilt, file: path.basename(archivePath(cfg)) });
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
}
