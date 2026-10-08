// tools/lib/app-ready.cjs - the one readiness wait for anything that has to drive the app.
//
// ASCII only, CommonJS, no side effects: this module only defines what "the app is up" means.
//
// Why this is not `waitUntil: 'networkidle'`, which is what the UI walk used to do:
//
//   `networkidle` means "500 ms during which at most two connections were in flight". This application
//   polls `/api/state` on a 3 s interval by design (web/src/App.jsx), so the page is never quiet, and the
//   wait was therefore decided by how loaded the machine was. Measured on the machine this was found:
//   13 `/api/state` requests inside a 20 s `goto`, the page fully rendered, `networkidle` never reached -
//   the same walk passed on a quiet machine and timed out at 30 s while two agents and Tor Browser were
//   competing for the CPU. A gate whose result is a function of machine load is not a gate.
//
//   Playwright's own documentation discourages `networkidle` for exactly this reason.
//
// What replaces it is a fact the application states about itself. The shell sets `data-vml-ready="1"` on
// `<html>` once a real answer to `/api/state` has arrived (see web/src/App.jsx - the attribute is written
// in an effect, so the DOM it appears in is a committed render, not a promise). Two properties matter and
// both are the opposite of the old wait:
//
//   * it is **stricter**: a page that renders but whose API never answers does not set it, so a server
//     that merely accepts a connection can no longer be mistaken for a working app;
//   * it is **load-independent**: it is set by the app's first successful state read, not by the network
//     happening to fall quiet, so a busy machine and a quiet one answer the same way.
//
// `tools/readiness-test.mjs` pins both directions of it (a live app reaches it; a server that never
// renders the shell does not, and the failure names what was missing).

'use strict';

/** The attribute the shell publishes, as a selector a Playwright page can wait for. */
const READY_SELECTOR = 'html[data-vml-ready="1"]';

/**
 * Wait for the application to be ready, or throw a reason that says which fact was missing.
 *
 * @param {{waitForSelector:Function}} page a Playwright page
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForAppReady(page, timeoutMs = 30000) {
  try {
    await page.waitForSelector(READY_SELECTOR, { timeout: timeoutMs });
  } catch (e) {
    // The reason is spelled out rather than passed through: Playwright's own timeout says only that a
    // selector did not appear, and the distinction that matters to whoever reads the failure is "the page
    // never reached the app" versus "the app is slow".
    throw new Error(
      'READY_FAILED: the shell never reported itself ready (no ' +
        READY_SELECTOR +
        ' within ' +
        timeoutMs +
        'ms) — the page loaded but its /api/state never answered, which is a different failure from a slow network',
    );
  }
}

module.exports = { READY_SELECTOR, waitForAppReady };
