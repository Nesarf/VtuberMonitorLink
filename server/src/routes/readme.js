// routes/readme.js — the readme endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { APP_ROOT, resolveDir } from '../config.js';
import { docLang, pickDoc, readDocs } from '../docs.js';
import { DATA_DIRS, measureDir, privacyFacts, privacyMarkdown } from '../privacy.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerReadmeRoutes(app, { getConfig, patchConfig, log }) {
    // ── README (shown inside the app) ────────────────────────────────
    // The UI has an "About" panel that renders these files and switches language instantly, so a
    // reader never has to leave the app (and never has to find the file on disk).
    //
    // Which documents it may show, and what each one is called, is `server/src/docs.js`: a fixed allowlist, so the
    // caller picks a *key* in it and never a path. `privacy` and `security` joined the Readme there, which is what
    // makes the privacy posture readable inside the app rather than only in the package folder. The document's
    // title is its own first heading, so the panel needs no new i18n key and the label cannot drift from the file.
    // In a packaged build the files sit next to app/ (build-portable copies them); from a source checkout they are
    // at the repo root. Both candidates are tried, nothing else.
    app.get('/api/readme', (req, res) => {
      const lang = docLang(req.query.lang);
      const roots = [APP_ROOT, path.join(APP_ROOT, '..'), process.cwd()];
      // The one generated document: what *this* install is configured to contact and where its data lives. Measured
      // per request (directory sizes are read-only and bounded) and never cached, because the answer changes the
      // moment the user edits a setting - a stale privacy page would be worse than none.
      const cfg = getConfig();
      const sizes = {};
      for (const d of DATA_DIRS) {
        const m = measureDir(d.configured ? resolveDir(cfg, d.key) : '', { fs });
        if (m) sizes[d.key] = m;
      }
      const generated = { machine: () => privacyMarkdown(privacyFacts(cfg), { sizes }) };
      const result = readDocs(req.query.doc, lang, roots, generated);
      if (!result.found) {
        return res.status(404).json({
          ok: false,
          error: `no ${result.wanted} document next to the app`,
          documents: result.available,
        });
      }
      const requested = pickDoc(req.query.doc);
      res.json({
        ok: true,
        doc: result.wanted,
        lang: result.lang,
        file: result.found.file,
        title: result.found.title,
        // The languages this *document* exists in: the Readmes in two, everything else in one. The panel's language
        // switch is built from this, which is why a single-language document offers no switch rather than offering
        // one that would silently show the other file.
        available: Object.keys(requested.files),
        documents: result.available,
        bytes: Buffer.byteLength(result.found.markdown, 'utf8'),
        markdown: result.found.markdown,
      });
    });
}
