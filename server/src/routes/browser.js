// routes/browser.js — the browser endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { browserTargetReport } from '../browser-consumers.js';
import { listProfiles, pickerFor, resolveProfileTarget } from '../browser-target.js';
import { detectBrowsers } from '../fetchers/browser.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerBrowserRoutes(app, { getConfig, patchConfig, log }) {
    // ── browser / profile targeting ──────────────────────────────────
    //
    // The page that owns the browser setting (web/src/pages/Browser.jsx) is rendered from this one answer:
    // the installed executables, the **discovered profiles** (so nobody hand-writes a path), what the setting
    // currently resolves to (through the same function every feature uses, see server/src/browser-target.js),
    // and one status row per feature that depends on it (server/src/browser-consumers.js).
    //
    // `profiles: false` skips the discovery for callers that only want the detected browsers; the discovery
    // itself is a directory listing and reads no cookie.
    app.get('/api/browser/target', (req, res) => {
      const cfg = getConfig();
      const discovered = listProfiles();
      const picker = pickerFor(discovered, cfg);
      res.json({
        // `paths.browsersDir` is handed in as an extra root: it is the setting that decides where engines live
        // when PLAYWRIGHT_BROWSERS_PATH was not already set at startup, and an engine the page cannot see is an
        // engine the user cannot pick.
        detected: detectBrowsers({ extraRoots: [cfg?.paths?.browsersDir] }),
        target: resolveProfileTarget(cfg),
        report: browserTargetReport(cfg),
        profiles: picker.options,
        // Entries the discovery refused (a row with no usable path) and rows the picker could not offer: the
        // page shows the count rather than quietly presenting a shorter list.
        unusableProfiles: picker.unusable,
        selected: picker.selected,
      });
    });
}
