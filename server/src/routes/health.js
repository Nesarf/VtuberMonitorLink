// routes/health.js — the health endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { isFresh, loadCache } from '../probe.js';
import { latestIntel } from '../reports.js';
import { effectiveSources } from '../sources.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerHealthRoutes(app, { getConfig, patchConfig, log }) {
    // ── source health board ──────────────────────────────────────────
    app.get('/api/health', (_req, res) => {
      const cfg = getConfig();
      const cache = loadCache(cfg);
      const ttl = cfg.ui?.probeTtlMinutes ?? 30;
      const intel = latestIntel(cfg, 1);
      const lastRun = new Map((intel.sources ?? []).map((s) => [s.id, s]));
      const sources = effectiveSources(cfg)
        .filter((s) => s.enabled)
        .map((s) => {
          const p = cache[s.id];
          const run = lastRun.get(s.id);
          return {
            id: s.id,
            label: s.name?.zh ?? s.id,
            category: s.category,
            url: s.url,
            egress: s.proxy ?? (cfg.proxy?.enabled ? 'proxy' : 'direct'),
            direct: p?.modes?.direct ?? null,
            proxy: p?.modes?.proxy ?? null,
            verdict: p?.verdict ?? null,
            hint: p?.hint ?? null,
            probeAt: p?.at ?? null,
            probeFresh: isFresh(p, ttl),
            lastRunOk: run ? run.ok : null,
            lastRunBytes: run?.bytes ?? null,
          };
        });
      const problems = sources.filter(
        (s) => (!s.probeAt || s.probeFresh === false) === false && (s.verdict === 'none' || s.lastRunOk === false)
      );
      res.json({
        at: new Date().toISOString(),
        probed: sources.filter((s) => s.probeAt).length,
        total: sources.length,
        problems,
        sources,
      });
    });
}
