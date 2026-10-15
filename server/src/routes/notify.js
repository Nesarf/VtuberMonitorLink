// routes/notify.js — the notify endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { isMaskedSecret } from '../config.js';
import { NOTIFY_KINDS, flushQueue as flushNotifyQueue, inQuietHours, maskTarget, newTarget, notify, readQueue, sanitizeTarget as sanitizeNotifyTarget } from '../notify.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerNotifyRoutes(app, { getConfig, patchConfig, log, persist }) {
    // ── alert destinations ───────────────────────────────────────────
    app.get('/api/notify', (_req, res) => {
      const cfg = getConfig();
      res.json({
        kinds: NOTIFY_KINDS,
        desktop: cfg.notify?.desktop !== false,
        targets: (cfg.notify?.targets ?? []).map(maskTarget),
        count: (cfg.notify?.targets ?? []).length,
        // quiet state and the backlog queue: the UI must see at a glance "are we quiet right now, and how many are queued"
        quiet: inQuietHours(cfg, { level: 'info' }),
        queue: readQueue(cfg),
        dedupeMinutes: cfg.notify?.dedupeMinutes ?? 0,
      });
    });

    // manually flush the queued notifications (force ignores the quiet hours)
    app.post('/api/notify/flush', async (req, res) => {
      const cfg = getConfig();
      const r = await flushNotifyQueue(cfg, log, { force: req.body?.force === true });
      res.json({ ok: true, ...r, queue: readQueue(cfg) });
    });

    app.post('/api/notify/new', (req, res) => {
      let cfg = getConfig();
      const t = newTarget(req.body?.kind ?? 'bark', req.body?.overrides ?? {});
      cfg.notify = cfg.notify ?? {};
      cfg.notify.targets = [...(cfg.notify.targets ?? []), t];
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, target: maskTarget(t) });
    });

    // try one push with a "not yet saved target"
    app.post('/api/notify/test', async (req, res) => {
      const cfg = getConfig();
      const wanted = sanitizeNotifyTarget(req.body?.target ?? {}, 0);
      const saved = (cfg.notify?.targets ?? []).find((t) => t.id === wanted.id);
      // what the frontend sends back is a mask, so never send with ***
      const merged = { ...(saved ?? {}), ...wanted, enabled: true, on: 'always' };
      for (const k of ['key', 'token', 'chatId', 'webhookUrl']) {
        // Same rule as everywhere else, now through the one shared predicate: a masked field means "the saved
        // one". The local regex it replaces only recognised a run of asterisks, so the partial mask the
        // notifier sends for a webhook URL ('https://host/***') was pushed as a live URL.
        if (!wanted[k] || isMaskedSecret(wanted[k])) merged[k] = saved?.[k] ?? wanted[k] ?? '';
      }
      const r = await notify({ ...cfg, notify: { targets: [merged] } }, log, {
        title: "Vtuber's Monitor Link 测试通知",
        body: '这条是测试消息。看到它就说明推送通道是通的。',
        level: 'info',
      });
      res.json({ ok: r.results[0]?.ok === true, result: r.results[0] ?? null });
    });
}
