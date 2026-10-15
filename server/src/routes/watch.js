// routes/watch.js — the watch endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { isMaskedSecret, publicConfig } from '../config.js';
import { DEFAULT_RULES, TARGET_KINDS, allBaselines, baselineHealthSnapshot, checkTarget, checkWatchLogin, readHistory, sanitizeId, sanitizeTarget, watchDir } from '../watch.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerWatchRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn }) {
    // ── watch targets ────────────────────────────────────────────────
    app.get('/api/watch', (_req, res) => {
      const cfg = getConfig();
      const baselines = allBaselines(cfg);
      // `targets` goes out through the same serializer as /api/config: a target may carry username +
      // botPassword (the wiki login), and this route spreads `...t` verbatim, so it was the second copy of the
      // same leak. The baseline object below is computed here and carries no secret.
      const masked = publicConfig({ targets: cfg.watch?.targets ?? [] }).targets;
      const targets = masked.map((t) => {
        const b = baselines[sanitizeId(t.id)] ?? null;
        return {
          ...t,
          baseline: b
            ? {
                at: b.updatedAt,
                kind: b.kind,
                revid: b.revid,
                // Future-facing field, kept deliberately: no watch handler writes a `follower` baseline any
                // more (it came from a platform this build no longer knows), so this is always `undefined`
                // today. The field and the count key that renders it are kept together because the key is
                // pinned by name in tools/i18n-plural-test.mjs (its per-locale plural forms are documented and
                // tested), so the data layer keeps the slot for the handler that fills it again.
                follower: b.follower,
                ids: Array.isArray(b.ids) ? b.ids.length : undefined,
                lastTimestamp: b.lastTimestamp,
              }
            : null,
        };
      });
      res.json({
        enabled: cfg.watch?.enabled !== false,
        targets,
        rules: { ...DEFAULT_RULES, ...(cfg.watch?.rules ?? {}) },
        kinds: TARGET_KINDS,
        // The condition of the baselines themselves, on the route the watch page already polls. The v1.0.5
        // audit's finding for these files was that a damaged one was indistinguishable from an absent one and
        // that the fact lived only in a log line; a log line in a run that prints twenty others is not a
        // report. Same arrangement as config.js: the condition is a property of the running process, so the
        // running process is where it is asked for, and `faults` names the preserved copy so the reader knows
        // where the bytes went. Carries no baseline content — file names and states only.
        baselineHealth: baselineHealthSnapshot(),
      });
    });

    app.put('/api/watch', (req, res) => {
      const cfg = getConfig();
      // `body` is the incoming change and `cfg` is what is stored, so the mask rule is applied to the
      // *request* (see the helper above). Doing it after the sanitiser would be too late: `sanitizeTarget`
      // keeps only the fields it knows, and by then the masked password would already have replaced the real
      // one in the object being written.
      const changed = preserveSecretsIn(req.body ?? {});
      const { targets, rules, enabled } = changed;
      const watch = { ...(cfg.watch ?? {}) };
      if (Array.isArray(changed.targets)) {
        const seen = new Set();
        watch.targets = changed.targets.map((t, i) => {
          const clean = sanitizeTarget(t, i);
          while (seen.has(clean.id)) clean.id = `${clean.id}-2`;
          seen.add(clean.id);
          return clean;
        });
      }
      if (rules && typeof rules === 'object') watch.rules = { ...DEFAULT_RULES, ...watch.rules, ...rules };
      if (enabled !== undefined) watch.enabled = !!enabled;
      const next = persist({ ...cfg, watch });
      res.json({ ok: true, watch: next.watch });
    });

    app.post('/api/watch/check', async (req, res) => {
      const cfg = getConfig();
      const id = req.body?.id;
      const targets = (cfg.watch?.targets ?? []).filter((t) => (id ? t.id === id : t.enabled !== false));
      if (!targets.length) return res.status(400).json({ error: 'no matching watch target' });
      const results = [];
      for (const t of targets) results.push(await checkTarget(t, { cfg, rules: cfg.watch?.rules, log }));
      const baselines = allBaselines(cfg);
      res.json({
        ok: true,
        results: results.map((r) => ({
          ...r,
          target: { ...r.target, baseline: baselines[sanitizeId(r.target?.id)] ? true : null },
        })),
        // A check that ran against a damaged baseline is exactly the moment the reader has to be told, and it
        // is the moment the old code was quietest: the run rebuilt the baseline and reported "no change".
        baselineHealth: baselineHealthSnapshot(),
      });
    });

    // "Is the wiki credential I configured still a login?" -- the check button next to those two fields.
    //
    // A watchlist target carries a real credential (username + BotPassword) and nothing ever measured it,
    // so the first thing that found out it had stopped working was a watch run whose failure reads as
    // "the wiki changed". This route makes one read-only request (`meta=userinfo` + `assert=user`) and
    // returns who the credential is, or the wiki's own reason.
    //
    // The password never leaves this process: it is not echoed, not logged, and not part of the answer --
    // the answer carries a name or a reason. The client sends the two fields because the check has to work
    // **before** they are saved, which is the moment a person actually wants it.
    app.post('/api/watch/login-check', busyGuard('watch login check'), async (req, res) => {
      const cfg = getConfig();
      const body = req.body ?? {};
      // The saved target is the fallback, so an already-configured target can be checked without the page
      // sending its secret back at all.
      const saved = (cfg.watch?.targets ?? []).find((t) => t.id === body.id) ?? {};
      // '***' is what the page now holds for a saved password (the config it read is masked), so it means
      // "the stored one". Without this the check would authenticate with the literal three asterisks and
      // report the wiki's rejection as if the credential had stopped working — a false negative that looks
      // exactly like a real one.
      const sentPw = body.botPassword;
      const target = {
        apiUrl: body.apiUrl ?? saved.apiUrl,
        username: body.username ?? saved.username,
        botPassword: sentPw && !isMaskedSecret(sentPw) ? sentPw : saved.botPassword,
        proxy: body.proxy ?? saved.proxy,
        // The saved target's loopback allowance travels with the saved address: this route builds a *partial*
        // target from the request body plus the saved one, and a field left out of it is a field the URL policy
        // will read as "not set". The page has no reason to send this back, and a target that was configured to
        // point at a wiki on this machine must not be refused at its own login check (measured: it was, and the
        // refusal is what the config-secrets suite caught).
        allowLoopback: saved.allowLoopback === true,
      };
      const r = await checkWatchLogin(target, { cfg, log });
      res.json(r);
    });

    app.get('/api/watch/:id/history', (req, res) => {
      const cfg = getConfig();
      res.json({ id: req.params.id, history: readHistory(cfg, req.params.id, Number(req.query.limit ?? 50)) });
    });

    app.delete('/api/watch/:id/baseline', (req, res) => {
      const cfg = getConfig();
      const f = path.join(watchDir(cfg), 'history', `${sanitizeId(req.params.id)}.baseline.json`);
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
      res.json({ ok: true, cleared: req.params.id, next: '下次检查会重建基线，不报变更' });
    });
}
