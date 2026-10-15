// routes/cookies.js — the cookies endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { resolveProfileTarget } from '../browser-target.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerCookiesRoutes(app, { getConfig, patchConfig, log }) {
    // ── login availability ───────────────────────────────────────────
    // Only reports "which cookie names were read", and **never sends back any value**.
    //
    // The profile is resolved exactly like every feature's own read (server/src/browser-target.js): a request
    // that names one is an explicit hand-in, anything else follows the shared setting. This route used to read
    // `cfg.browser.profileDir` on its own, which is how the settings page and the share page could answer
    // differently about the same machine.
    app.post('/api/cookies/check', async (req, res) => {
      const cfg = getConfig();
      const profile = resolveProfileTarget(cfg, { profileDir: req.body?.profileDir });
      const domains = Array.isArray(req.body?.domains) && req.body.domains.length ? req.body.domains : ['reddit.com'];
      const { readBrowserCookies, hasSessionCookie } = await import('../cookies.js');
      const r = await readBrowserCookies(profile.dir, domains);
      res.json({
        ok: r.ok,
        error: r.error ?? null,
        warning: r.warning ?? null,
        profile: r.profile ?? null,
        profileDir: profile.dir || null,
        profileSource: profile.source,
        profileReason: profile.dir ? null : 'no-profile-configured',
        domains,
        cookieCount: (r.names ?? []).length,
        // The same predicate every other login check uses (server/src/cookies.js), so this route cannot answer
        // "signed in" while the share page answers "probably not" about the same store.
        hasSession: hasSessionCookie(r.names),
        names: r.names ?? [],
      });
    });
}
