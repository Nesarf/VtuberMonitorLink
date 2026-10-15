// routes/intel-rest.js — the intel endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { todayIn } from '../day.js';
import { applyFeatures, loadFeatureCache } from '../features.js';
import { buildDocx, buildXlsx, itemsToMarkdown, itemsToSheet } from '../office.js';
import { htmlShell, latestIntel } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerIntelRestRoutes(app, { getConfig, patchConfig, log }) {
    // ── Office export / Word & Excel ─────────────────────────────────
    // OOXML hand-written in pure Node, with no dependency on Office / COM / Python — a portable exe cannot assume what the target machine has installed.
    app.get('/api/intel/export', (req, res) => {
      const cfg = getConfig();
      const format = ['xlsx', 'docx', 'md', 'html'].includes(String(req.query.format)) ? String(req.query.format) : 'xlsx';
      const data = latestIntel(cfg, Number(req.query.limit ?? 500));
      const items = applyFeatures(data.items ?? [], loadFeatureCache(cfg));
      const stamp = todayIn(cfg);
      if (format === 'html') {
        res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.html"`);
        return res.type('text/html; charset=utf-8').send(htmlShell(`情报集 ${stamp}`, itemsToMarkdown(items, { title: '情报集' })));
      }
      if (format === 'md') {
        res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.md"`);
        return res.type('text/markdown; charset=utf-8').send(itemsToMarkdown(items, { title: '情报集' }));
      }
      if (format === 'docx') {
        const buf = buildDocx({ title: `情报集 ${stamp}`, markdown: itemsToMarkdown(items, { title: `情报集 ${stamp}` }) });
        res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.docx"`);
        return res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buf);
      }
      const buf = buildXlsx([{ name: stamp, rows: itemsToSheet(items) }]);
      res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.xlsx"`);
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
    });
}
