// routes/state.js — the state endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { runState } from '../runner.js';
import * as scheduler from '../scheduler.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerStateRoutes(app, { getConfig, patchConfig, log }) {
    app.get('/api/state', (_req, res) =>
      res.json({ ...runState, nextFire: scheduler.nextFire(), schedule: getConfig().schedule })
    );
}
