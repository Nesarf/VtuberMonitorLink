// routes/thumb.js — the thumb endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { effectiveSources } from '../sources.js';
import { getThumbnail, listThumbs, readThumb } from '../thumbs.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerThumbRoutes(app, { getConfig, patchConfig, log }) {
    // ── site thumbnails ──────────────────────────────────────────────
    app.get('/api/thumb', async (req, res) => {
      const cfg = getConfig();
      const url = String(req.query.url ?? '').trim();
      if (!url) return res.status(400).json({ error: 'url is required' });
      const source = effectiveSources(cfg).find((s) => s.id === req.query.sourceId);
      const mode = req.query.mode === 'screenshot' ? 'screenshot' : req.query.mode === 'icon' ? 'icon' : 'auto';
      const r = await getThumbnail(url, {
        cfg,
        subject: source,
        refresh: req.query.refresh === '1',
        mode,
        log,
      });
      if (req.query.json === '1') return res.json(r);
      // "this site has no usable thumbnail" is a normal result, not an error — do not answer 404, which would make the frontend treat it as a failed request
      if (!r.ok) return res.json({ ok: false, error: r.error, site: url });
      res.json({ ok: true, ...r, image: `/api/thumb/file/${encodeURIComponent(r.file)}` });
    });

    app.get('/api/thumb/file/:file', (req, res) => {
      const got = readThumb(getConfig(), req.params.file);
      if (!got) return res.status(404).json({ error: 'not found' });
      res.setHeader('cache-control', 'public, max-age=86400');
      res.type(got.type).send(got.buf);
    });

    app.get('/api/thumb/list', (_req, res) => {
      const cfg = getConfig();
      res.json({ dir: 'thumbs/', files: listThumbs(cfg) });
    });
}
