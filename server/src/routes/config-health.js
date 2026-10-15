// routes/config-health.js — the config endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { configHealthSnapshot, recoverConfigFromBackup, verifyBackup } from '../config.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerConfigHealthRoutes(app, { getConfig, patchConfig, log, onConfigChanged, persist, preserveSecretsIn }) {
    // ── config integrity ─────────────────────────────────────────────
    //
    // Why this is a route of its own rather than three extra fields on /api/state: "is my config file
    // damaged" and "is a run in progress" are different questions with different lifetimes, and a page
    // that greys out a settings form should not have to read the run state to find out. It is also the
    // answer a support conversation starts from, and it stays readable when the config itself is the
    // thing that is broken — the payload describes the file, never a value from it.
    //
    // The state is a property of the running process (see the durability section of config.js for why),
    // so it is read from the module rather than through getConfig(): a damaged file is exactly the case
    // where getConfig() is an in-memory default that says nothing about the disk.
    app.get('/api/config/health', (_req, res) => {
      const backup = verifyBackup();
      res.json({ ...configHealthSnapshot(), backupUsable: backup.ok, backupError: backup.ok ? null : backup.error });
    });

    // The deliberate half of "never silently": the app runs on defaults after a damaged config and does
    // **not** put the backup back on its own, because a config that changes itself is the failure this
    // release is about. This is the one call that restores it, and the answer states what happened.
    app.post('/api/config/recover', (_req, res) => {
      const result = recoverConfigFromBackup();
      const { config, ...rest } = result;
      res.status(result.ok ? 200 : 409).json({ ...rest, health: configHealthSnapshot() });
      if (result.ok) onConfigChanged?.(config);
    });
}
