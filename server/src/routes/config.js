// routes/config.js — the config endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { publicConfig } from '../config.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerConfigRoutes(app, { getConfig, patchConfig, log, onConfigChanged, persist, preserveSecretsIn }) {
    // ── config ───────────────────────────────────────────────────────
    // The whole config, minus its secrets: this route is what a DNS-rebound page used to be able to read, and
    // it is also what every settings page round-trips. `publicConfig` masks at any depth and states which
    // fields are secret in one place (config.js); the matching write-side restore lives in `persist`.
    app.get('/api/config', (_req, res) => res.json(publicConfig(getConfig())));
    app.put('/api/config', (req, res) => {
      // The body is applied as sent (a settings page posts the whole config back), with the masked secrets
      // restored from storage first. Narrow patches go through the same helper; see preserveSecretsIn below.
      const next = persist(preserveSecretsIn(req.body ?? {}));
      onConfigChanged?.(next);
      res.json(publicConfig(next));
    });
}
