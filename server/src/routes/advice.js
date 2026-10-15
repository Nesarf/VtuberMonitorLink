// routes/advice.js — the advice endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { adviceDir, listAdvice, readAdvice } from '../diagnose.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerAdviceRoutes(app, { getConfig, patchConfig }) {
    app.get('/api/advice', (_req, res) => res.json({ files: listAdvice(getConfig()) }));

    // clicking it opens a readable web page (?raw=1 fetches the raw markdown)
    app.get('/api/advice/:file', (req, res) => {
      const raw = req.query.raw === '1';
      const got = readAdvice(getConfig(), req.params.file, !raw);
      if (!got) return res.status(404).json({ error: 'not found' });
      res.type(got.mime).send(raw ? got.markdown : got.html);
    });

    app.delete('/api/advice/:file', (req, res) => {
      const cfg = getConfig();
      const p = path.join(adviceDir(cfg), path.basename(req.params.file));
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
      res.json({ ok: true, removed: path.basename(req.params.file) });
    });
}
