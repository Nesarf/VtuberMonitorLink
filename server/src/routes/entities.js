// routes/entities.js — the entities endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { entityDetail, entityStats } from '../entities.js';
import { loadFlags } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerEntitiesRoutes(app, { getConfig, patchConfig, log }) {
    // ── entities ─────────────────────────────────────────────────────
    // Aggregate the names pulled out by feature extraction into objects: which items, which games, which events they showed up in.
    app.get('/api/entities', (req, res) => {
      const cfg = getConfig();
      res.json(entityStats(cfg, loadFlags(cfg)));
    });

    app.get('/api/entities/:name', (req, res) => {
      const cfg = getConfig();
      const detail = entityDetail(cfg, req.params.name, { flags: loadFlags(cfg) });
      if (!detail) return res.status(404).json({ error: `no entity named ${req.params.name}` });
      res.json(detail);
    });
}
