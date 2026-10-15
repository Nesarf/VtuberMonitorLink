// routes/sources.js — the sources endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { FETCH_KINDS } from '../fetchers/index.js';
import { loadObservationState } from '../observe.js';
import { selectSources } from '../runner.js';
import { CATEGORIES, effectiveSources, mergeSourceOverride } from '../sources.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSourcesRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn }) {
    // ── source catalog ───────────────────────────────────────────────
    app.get('/api/sources', (_req, res) => {
      const cfg = getConfig();
      // "last observed": when each source was last picked while observation mode is on.
      // Given nothing but a sampling ratio, the user cannot tell which sources have not been looked at, and
      // for how long — and that is exactly the evidence for judging whether coverage is sufficient.
      const obs = loadObservationState(cfg);
      const sources = effectiveSources(cfg).map((s) => ({
        ...s,
        lastObserved: obs.lastPicked?.[s.id] ?? null,
      }));
      res.json({
        categories: CATEGORIES,
        fetchKinds: FETCH_KINDS,
        sources,
        observation: {
          enabled: cfg?.observation?.enabled === true,
          rounds: obs.rounds ?? 0,
          ratio: cfg?.observation?.sampleRatio ?? null,
        },
        selected: {
          daily: selectSources(cfg, 'daily').length,
          merch: selectSources(cfg, 'merch').length,
        },
      });
    });

    app.patch('/api/sources/:id', (req, res) => {
      let cfg = getConfig();
      const { id } = req.params;
      if (!effectiveSources(cfg).some((s) => s.id === id)) return res.status(404).json({ error: `unknown source: ${id}` });
      const { enabled, login, url, uid, proxy, note, region } = preserveSecretsIn(req.body ?? {});
      cfg.sources = cfg.sources ?? {};
      cfg.sources[id] = {
        ...(cfg.sources[id] ?? {}),
        ...(enabled === undefined ? {} : { enabled: !!enabled }),
        ...(login ? { login } : {}),
      };
      // overriding the handful of mutable fields of a built-in source (uid / url / egress / region) lands in
      // the custom source list.
      //
      // The merge keeps only the fields actually sent (see mergeSourceOverride): spreading all of them at once
      // writes `undefined` over a field the caller left out, and the sanitiser skips undefined values, so the
      // entry's old value for that field is lost rather than kept. The region box on the sources page is what
      // made that visible - editing a region wiped the url of the same override entry, silently.
      const customIdx = (cfg.customSources ?? []).findIndex((s) => s.id === id);
      if (url !== undefined || uid !== undefined || proxy !== undefined || note !== undefined || region !== undefined) {
        const base = customIdx >= 0 ? cfg.customSources[customIdx] : effectiveSources(cfg).find((s) => s.id === id);
        const merged = mergeSourceOverride(base, { url, uid, proxy, note, region });
        if (customIdx >= 0) cfg.customSources[customIdx] = merged;
        else cfg.customSources = [...(cfg.customSources ?? []), merged];
      }
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, sources: effectiveSources(cfg) });
    });
}
