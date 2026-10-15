// routes/browsers.js — the browsers endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { detectBrowsers } from '../fetchers/browser.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerBrowsersRoutes(app, { getConfig, patchConfig, log }) {
    // The older name of the route above, kept because a page may still ask for it: same detection, and the
    // browser config it used to return (the target answers everything it did, and more).
    app.get('/api/browsers', (_req, res) => {
      const cfg = getConfig();
      res.json({ detected: detectBrowsers({ extraRoots: [cfg?.paths?.browsersDir] }), config: cfg.browser });
    });
}
