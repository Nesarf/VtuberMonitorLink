// routes/run.js — the run endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { runOnce, runState } from '../runner.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerRunRoutes(app, { getConfig, patchConfig, log }) {
    // ── run ──────────────────────────────────────────────────────────
    app.post('/api/run', async (req, res) => {
      const mode = ['merch', 'watch'].includes(req.body?.mode) ? req.body.mode : 'daily';
      if (runState.running) return res.status(409).json({ error: 'a run is already in progress' });
      // return immediately, the run keeps going in the background; the UI polls /api/state
      res.json({ ok: true, started: mode });
      runOnce({ cfg: getConfig(), mode }).catch((e) => log?.error(`run failed — ${e.message}`));
    });
}
