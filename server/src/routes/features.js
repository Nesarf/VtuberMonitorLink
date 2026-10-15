// routes/features.js — the features endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { applyFeatures, extractFeatures, featureStats, loadFeatureCache } from '../features.js';
import { latestIntel } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerFeaturesRoutes(app, { getConfig, patchConfig, log, busyGuard }) {
    // ── feature extraction (needs an LLM) ────────────────────────────
    app.get('/api/features', (_req, res) => res.json(featureStats(getConfig())));

    app.post('/api/features/extract', busyGuard('feature extraction'), async (req, res) => {
      const cfg = getConfig();
      const items = applyFeatures(latestIntel(cfg, 400).items ?? [], loadFeatureCache(cfg));
      const r = await extractFeatures(cfg, items, log);
      res.json({
        ok: !r.error,
        error: r.error ?? null,
        extracted: r.extracted,
        cached: r.skipped,
        stats: featureStats(cfg),
      });
    });
}
