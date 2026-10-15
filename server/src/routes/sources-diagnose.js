// routes/sources-diagnose.js — the sources endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { effectiveSources } from '../sources.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSourcesDiagnoseRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn, busyGuard }) {
    // ── bulk source toggles ──────────────────────────────────────────
    // Clicking 30 sources one by one is tiring, and it is very easy to forget to turn them back off in tests (this feature exists because of exactly that trap)
    app.post('/api/sources/bulk', (req, res) => {
      let cfg = getConfig();
      const { action, category, ids } = req.body ?? {};
      const all = effectiveSources(cfg);
      const picked = all.filter((s) => (ids?.length ? ids.includes(s.id) : category ? s.category === category : true));
      if (!picked.length) return res.status(400).json({ error: 'no matching sources' });
      cfg.sources = cfg.sources ?? {};
      for (const s of picked) {
        if (action === 'enable') cfg.sources[s.id] = { ...(cfg.sources[s.id] ?? {}), enabled: true };
        else if (action === 'disable') cfg.sources[s.id] = { ...(cfg.sources[s.id] ?? {}), enabled: false };
        else if (action === 'reset') delete cfg.sources[s.id];
        else return res.status(400).json({ error: 'action must be enable | disable | reset' });
      }
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, changed: picked.length, action, sources: effectiveSources(cfg) });
    });
}
