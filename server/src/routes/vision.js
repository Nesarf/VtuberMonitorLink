// routes/vision.js — the vision endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { latestIntel } from '../reports.js';
import { tagItems, visionReady, visionStats } from '../vision.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerVisionRoutes(app, { getConfig, patchConfig, log }) {
    // ── image tagging ────────────────────────────────────────────────
    // The core lives in vision.js (cache keyed by image URL, tolerant parsing, bounded concurrency),
    // and tools/vision-test.mjs verifies the whole path end to end against a local fake vision model (no Key spent, no image sent out).
    app.get('/api/vision/stats', (_req, res) => {
      const cfg = getConfig();
      res.json({ ok: true, ...visionStats(cfg), ready: visionReady(cfg) });
    });

    // tag the images attached to the latest intel (with the feature off it refuses outright and never quietly sends an image out)
    app.post('/api/vision/tag', async (req, res) => {
      const cfg = getConfig();
      const ready = visionReady(cfg);
      if (!ready.ok) return res.status(400).json({ ok: false, error: ready.reason });
      const data = latestIntel(cfg, Number(req.body?.scan ?? 300));
      const r = await tagItems(cfg, {
        items: data.items ?? [],
        limit: Number(req.body?.limit ?? cfg.vision?.runLimit ?? 40),
        force: req.body?.force === true,
        log,
      });
      res.json({ ...r, ...visionStats(cfg) });
    });
}
