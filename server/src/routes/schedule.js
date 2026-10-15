// routes/schedule.js — the schedule endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { runOnce, runState } from '../runner.js';
import * as scheduler from '../scheduler.js';
import { readHistory } from '../watch.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerScheduleRoutes(app, { getConfig, patchConfig, log }) {
    // ── schedules ────────────────────────────────────────────────────
    app.get('/api/schedule', (_req, res) => {
      const cfg = getConfig();
      const tasks = (cfg.schedule?.tasks ?? []).map((t) => ({
        ...t,
        nextFire: scheduler.computeTaskNextFire(t)?.toISOString() ?? null,
        preview: scheduler.previewTask(t, 5),
        lastFire: scheduler.readHistory(cfg, 200).find((h) => h.taskId === t.id)?.at ?? null,
      }));
      res.json({
        tasks,
        nextFire: scheduler.nextFire(),
        running: scheduler.runningTasks(),
        history: scheduler.readHistory(cfg, 30),
        merchEveryDays: cfg.schedule?.merchEveryDays ?? 14,
      });
    });

    app.post('/api/schedule/run', async (req, res) => {
      const cfg = getConfig();
      const id = String(req.body?.id ?? '');
      const task = (cfg.schedule?.tasks ?? []).find((t) => t.id === id);
      if (!task) return res.status(404).json({ error: `unknown task: ${id}` });
      if (runState.running) return res.status(409).json({ error: 'a run is already in progress' });
      res.json({ ok: true, started: task.mode, task: task.id });
      runOnce({ cfg: getConfig(), mode: task.mode })
        .then((r) => scheduler.appendHistory(cfg, { taskId: task.id, name: task.name, manual: true, ok: !!r?.ok, error: r?.error ?? null }))
        .catch((e) => log?.error(`manual scheduled run failed — ${e.message}`));
    });
}
