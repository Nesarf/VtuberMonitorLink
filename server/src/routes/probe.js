// routes/probe.js — the probe endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { DEFAULT_SAMPLES, loadCache, probeUrl, updateCache } from '../probe.js';
import { effectiveSources } from '../sources.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerProbeRoutes(app, { getConfig, patchConfig, log, busyGuard }) {
    // ── reachability ─────────────────────────────────────────────────
    app.get('/api/probe', (_req, res) => {
      const cfg = getConfig();
      res.json({ cache: loadCache(cfg), ttlMinutes: cfg.ui?.probeTtlMinutes ?? 30 });
    });

    app.post('/api/probe', busyGuard('probe'), async (req, res) => {
      const cfg = getConfig();
      const samples = Math.max(1, Math.min(10, Number(req.body?.samples) || cfg.ui?.probeSamples || DEFAULT_SAMPLES));
      const modes = Array.isArray(req.body?.modes) && req.body.modes.length ? req.body.modes : ['direct', 'proxy'];
      const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : req.body?.id ? [req.body.id] : null;
      const oneUrl = String(req.body?.url ?? '').trim();

      const targets = [];
      if (oneUrl) {
        targets.push({ id: oneUrl, url: oneUrl, label: oneUrl });
      } else {
        const all = effectiveSources(cfg);
        const picked = ids ? all.filter((s) => ids.includes(s.id)) : all.filter((s) => s.enabled);
        for (const s of picked) if (s.url) targets.push({ id: s.id, url: s.url, label: s.name?.zh ?? s.id, source: s });
      }
      if (!targets.length) return res.status(400).json({ error: '没有可测的目标 / nothing to probe' });
      if (targets.length > 40) targets.length = 40;

      // When no egress is specified, probe over **the egress these sources actually use**: when a source is set to
      // Tor, "test the network" has to test Tor — otherwise judging whether a Tor-routed source should use Tor
      // from a direct-connection latency produces the wrong conclusion (this trap really existed: the UI had a
      // Tor option while the probe did not recognize it).
      let effectiveModes = modes;
      const perTarget = new Map();
      if (!Array.isArray(req.body?.modes) || !req.body.modes.length) {
        for (const t of targets) {
          const want = String(t.source?.proxy ?? ''); // that dropdown on the sources page: '' = auto / direct / proxy / tor
          const list = ['direct'];
          if (want === 'proxy' || want === 'tor') list.push(want);
          else {
            if (cfg.proxy?.enabled) list.push('proxy');
            // Tor is probed only when it **is genuinely going to be used**: otherwise "probe everything" makes
            // every source pay one extra round of about 2.5s (bringing up a Tor circuit is slow to begin with),
            // which is pure waste — and that time is better kept for the entries that really need Tor.
            const torInPlay =
              cfg?.observation?.enabled === true || cfg?.proxy?.mode === 'tor' || cfg?.proxy?.enableTor === true;
            if (torInPlay && cfg.proxy?.torSocks) list.push('tor');
          }
          perTarget.set(t.id, list);
        }
        effectiveModes = null; // decided target by target
      }

      const out = [];
      for (const t of targets) {
        try {
          // The allowance travels from the entry being probed (a custom source or a watch target carries it);
          // nothing is probed with an allowance it did not itself declare.
          const r = await probeUrl(t.url, {
            cfg,
            samples,
            modes: perTarget.get(t.id) ?? effectiveModes ?? modes,
            subject: t.source ?? null,
          });
          out.push({ id: t.id, label: t.label, sourceId: t.source?.id ?? null, ...r });
        } catch (e) {
          out.push({ id: t.id, label: t.label, url: t.url, error: e.message, at: new Date().toISOString() });
        }
      }
      updateCache(cfg, out);
      res.json({ ok: true, probed: out.length, samples, results: out });
    });
}
