// routes/sources-extra.js — the sources endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { diagnoseSource } from '../diagnose.js';
import { effectiveSources } from '../sources.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSourcesExtraRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn, busyGuard }) {
    app.post('/api/sources/:id/diagnose', busyGuard('source diagnose'), async (req, res) => {
      const cfg = getConfig();
      const source = effectiveSources(cfg).find((s) => s.id === req.params.id);
      if (!source) return res.status(404).json({ error: `unknown source: ${req.params.id}` });
      try {
        const r = await diagnoseSource(source, cfg, log);
        res.json({ ok: true, sourceId: source.id, ...r });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
}
