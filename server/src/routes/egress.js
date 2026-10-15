// routes/egress.js — the egress endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { clear as egressClear, decision as egressDecision, snapshot as egressSnapshot } from '../egress.js';
import { probeUrl, updateCache } from '../probe.js';
import { effectiveSources } from '../sources.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerEgressRoutes(app, { getConfig, patchConfig }) {
    // ── automatic per-site egress ────────────────────────────────────
    // Every site picks direct or proxy automatically by "equivalent latency = avg × (1 + loss × 4)",
    // with hysteresis (no switch unless the advantage is over 20%, to avoid flapping). The verdict + reason + scores live here.
    app.get('/api/egress', (_req, res) => {
      const cfg = getConfig();
      const snap = egressSnapshot(cfg);
      const byKey = {};
      for (const d of snap.decisions) byKey[d.key] = d;
      res.json({ ...snap, byKey });
    });

    app.post('/api/egress/decide', async (req, res) => {
      const cfg = getConfig();
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const sources = effectiveSources(cfg).filter((s) => !ids.length || ids.includes(s.id));
      const results = [];
      for (const s of sources) {
        try {
          const p = await probeUrl(s.url, { cfg, samples: Number(req.body?.samples ?? 3), subject: s });
          updateCache(cfg, [{ id: s.id, label: s.name?.zh ?? s.id, sourceId: s.id, ...p }]);
          const d = egressDecision(cfg, s);
          results.push({ id: s.id, mode: d?.mode ?? null, reason: d?.reason ?? '', confidence: d?.confidence ?? 'none' });
        } catch (e) {
          results.push({ id: s.id, mode: null, reason: e.message, confidence: 'none' });
        }
      }
      res.json({ ok: true, results, ...egressSnapshot(cfg) });
    });

    app.post('/api/egress/clear', (_req, res) => {
      const cfg = getConfig();
      egressClear(cfg);
      res.json({ ok: true });
    });
}
