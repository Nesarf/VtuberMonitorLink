// routes/cost.js — the cost endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { budgetStatus, costSummary, loadUsage, summarizeUsage } from '../cost.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerCostRoutes(app, { getConfig, patchConfig, log }) {
    // ── LLM usage & budget ───────────────────────────────────────────
    // Before this no usage was visible in the UI at all (the usage was being fetched but nobody aggregated it), yet this is where the money goes.
    // Report only **what is visible**: a call whose usage cannot be read is counted separately, never guessed at.
    app.get('/api/cost', (req, res) => {
      const cfg = getConfig();
      const days = Math.max(1, Math.min(90, Number(req.query.days ?? 14)));
      try {
        const { rows, badLines } = loadUsage(cfg);
        const summary = summarizeUsage(rows, { days, cfg });
        const budget = budgetStatus(cfg, summary);
        res.json({ ok: true, ...summary, budget, badLines, summary: costSummary(summary, budget) });
      } catch (e) {
        res.json({ ok: false, error: e.message, today: { tokens: 0, calls: 0 }, total: { tokens: 0, calls: 0 }, days: [], models: [] });
      }
    });
}
