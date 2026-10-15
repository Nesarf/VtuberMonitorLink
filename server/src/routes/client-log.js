// routes/client-log.js — the client-log endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { resolveDir } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerClientLogRoutes(app, { getConfig, patchConfig, log }) {
    // ── client error beacon ──────────────────────────────────────────
    // When a page throws, the whole tree gets unmounted and the page turns blank, while the server knew nothing about it.
    // The frontend already installs the listener in index.html; this side only persists to disk + writes the server log.
    app.post('/api/client-log', (req, res) => {
      const cfg = getConfig();
      const b = req.body ?? {};
      const entry = {
        at: b.at ?? new Date().toISOString(),
        kind: String(b.kind ?? 'unknown').slice(0, 24),
        message: String(b.message ?? '').slice(0, 800),
        source: b.source ? String(b.source).slice(0, 200) : null,
        line: b.line ?? null,
        col: b.col ?? null,
        stack: b.stack ? String(b.stack).slice(0, 1200) : null,
        href: b.href ? String(b.href).slice(0, 200) : null,
        ua: b.ua ? String(b.ua).slice(0, 160) : null,
      };
      try {
        const f = path.join(resolveDir(cfg, 'logsDir'), 'client-errors.jsonl');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        /* keep going even when the write to disk fails */
      }
      log?.warn(`client ${entry.kind}: ${entry.message}${entry.source ? ` @ ${entry.source}:${entry.line}` : ''}`);
      res.json({ ok: true });
    });

    // read back the recorded frontend errors (handy for troubleshooting)
    app.get('/api/client-log', (_req, res) => {
      const cfg = getConfig();
      const f = path.join(resolveDir(cfg, 'logsDir'), 'client-errors.jsonl');
      let entries = [];
      try {
        if (fs.existsSync(f)) {
          entries = fs
            .readFileSync(f, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-100)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .reverse();
        }
      } catch {
        /* ignore */
      }
      res.json({ count: entries.length, entries });
    });
}
