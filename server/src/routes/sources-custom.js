// routes/sources-custom.js — the sources endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { effectiveSources, sanitizeCustomSource } from '../sources.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSourcesCustomRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn }) {
    // ── custom sources ───────────────────────────────────────────────
    app.post('/api/sources/custom', (req, res) => {
      let cfg = getConfig();
      // A user-added source carries free-form keys (url / proxy / note), so the mask rule is applied before
      // the sanitiser picks the fields out.
      const s = sanitizeCustomSource(preserveSecretsIn(req.body ?? {}));
      if (!s.id) return res.status(400).json({ error: 'id is required' });
      // Every fetch kind this build offers reads a url: the uid-only kind (an account-id feed) was removed
      // with its platform, and a source that carries nothing to fetch would be refused by the fetch stage anyway.
      if (!s.url) return res.status(400).json({ error: 'url is required' });
      if (effectiveSources(cfg).some((x) => x.id === s.id)) return res.status(409).json({ error: `source already exists: ${s.id}` });
      cfg.customSources = [...(cfg.customSources ?? []), s];
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, source: s, sources: effectiveSources(cfg) });
    });

    app.delete('/api/sources/custom/:id', (req, res) => {
      let cfg = getConfig();
      const before = (cfg.customSources ?? []).length;
      cfg.customSources = (cfg.customSources ?? []).filter((s) => s.id !== req.params.id);
      if (cfg.sources?.[req.params.id]) delete cfg.sources[req.params.id];
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, removed: before - cfg.customSources.length, sources: effectiveSources(cfg) });
    });
}
