// routes/config-transfer.js — the config endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { publicConfig } from '../config.js';
import { todayIn } from '../day.js';
import { notify } from '../notify.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerConfigTransferRoutes(app, { getConfig, patchConfig, log, onConfigChanged, persist, preserveSecretsIn }) {
    // ── config import & export ───────────────────────────────────────
    // This route keeps its own blank-the-fields redaction on purpose, and it is the precedent the read-side
    // rule was built to match: an export is a *file*, `?secrets=1` is the deliberate "give me the backup with
    // keys" switch, and the blank form is what `/api/config/import` documents ("apiKey:'' must not overwrite a
    // stored value") — a masked '***' in a file would read as a value to anyone opening it in an editor.
    // The blanket `publicConfig` pass afterwards is not decoration: the hand-kept list below covered the LLM key
    // and the wiki password but **not** `proxy.controlSecret`, so a redacted export still carried a live
    // credential for the mihomo/Clash control API (found by tools/config-secrets-test.mjs). Layering the
    // serializer over the blanking covers every secret the rule knows about, while the fields the list does
    // blank keep their '' shape — which is what the import path and its traversal check depend on.
    app.get('/api/config/export', (req, res) => {
      const cfg = getConfig();
      const withSecrets = req.query.secrets === '1';
      const clone = JSON.parse(JSON.stringify(cfg));
      if (!withSecrets) {
        for (const p of clone.llm?.providers ?? []) p.apiKey = '';
        for (const t of clone.watch?.targets ?? []) if (t.botPassword) t.botPassword = '';
        for (const t of clone.notify?.targets ?? []) {
          for (const k of ['key', 'token', 'chatId', 'webhookUrl']) if (t[k]) t[k] = '';
        }
      }
      const body = JSON.stringify(
        {
          app: "Vtuber's Monitor Link",
          version: 2,
          exportedAt: new Date().toISOString(),
          secrets: withSecrets,
          // ?secrets=1 is the deliberate "back up everything" switch and stays verbatim.
          config: withSecrets ? clone : publicConfig(clone),
        },
        null,
        2
      );
      res.setHeader('content-disposition', `attachment; filename="vml-config-${todayIn(cfg)}.json"`);
      res.type('application/json; charset=utf-8').send(body);
    });

    app.post('/api/config/import', (req, res) => {
      const raw = req.body?.config ?? req.body;
      if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'expected a config object' });
      const cur = getConfig();
      // A masked import (the UI can post back what /api/config just handed it) means "unchanged" for every
      // secret, the same rule the '':''-does-not-overwrite behaviour below expresses.
      const incoming = preserveSecretsIn(raw);

      // Merge the objects inside arrays by id (providers / targets / customSources / tasks …).
      // A plain "replace the whole array" would not work — the apiKey:'' of a redacted export would wipe the Key
      // already on this machine, and importing a config you just exported is the most common use case of all.
      const mergeArray = (a, b) => {
        const aList = Array.isArray(a) ? a : [];
        const hasIds = b.every((x) => x && typeof x === 'object' && typeof x.id === 'string');
        if (!hasIds || !aList.every((x) => x && typeof x === 'object')) return b;
        const byId = new Map(aList.filter((x) => typeof x.id === 'string').map((x) => [x.id, x]));
        return b.map((item) => (byId.has(item.id) ? merge(byId.get(item.id), item) : item));
      };

      const merge = (a, b) => {
        if (Array.isArray(b)) return mergeArray(a, b);
        if (b && typeof b === 'object') {
          const out = { ...(a ?? {}) };
          for (const [k, v] of Object.entries(b)) {
            // an empty string does not overwrite an existing non-empty value: importing a redacted export must not wipe secrets
            if (v === '' && typeof out[k] === 'string' && out[k]) continue;
            out[k] = merge(out[k], v);
          }
          return out;
        }
        return b;
      };
      const next = persist(merge(cur, incoming));
      onConfigChanged?.(next);
      // The merged config is answered masked: an import is usually fed back by the UI, and this response is a
      // config object like any other. The import itself still stores the real values (`persist` restored them).
      res.json({ ok: true, config: publicConfig(next) });
    });
}
