// routes/reports.js — the reports endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { diffHunks, diffLines, diffStats } from '../diff.js';
import { exportReport, listReports, markdownSource, readReport, searchReports } from '../reports.js';
import { search } from '../search.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerReportsRoutes(app, { getConfig, patchConfig, log }) {
    // ── reports ──────────────────────────────────────────────────────
    app.get('/api/reports', (_req, res) => res.json(listReports(getConfig())));

    // note: this has to be registered before /api/reports/:name, otherwise "search" is treated as a file name
    app.get('/api/reports/search', (req, res) => {
      res.json({ query: req.query.q ?? '', hits: searchReports(getConfig(), req.query.q) });
    });

    app.get('/api/reports/:name/export', (req, res) => {
      const format = ['json', 'docx'].includes(String(req.query.format)) ? String(req.query.format) : 'html';
      const out = exportReport(getConfig(), req.params.name, format);
      if (!out) return res.status(404).json({ error: 'not found' });
      res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
      // the body may be a string (html/json) or a Buffer (docx)
      res.type(out.mime).send(out.buffer ?? out.body);
    });

    // line-by-line comparison of two reports
    app.get('/api/reports/diff', (req, res) => {
      const cfg = getConfig();
      const a = String(req.query.from ?? '');
      const b = String(req.query.to ?? '');
      // compare via the markdown source: that lines up no matter whether the report's main file is html/adoc/json
      const left = a ? markdownSource(cfg, a) : null;
      const right = b ? markdownSource(cfg, b) : null;
      if (left === null || right === null) return res.status(404).json({ error: 'one of the reports was not found' });
      const lines = diffLines(left, right);
      const stats = diffStats(lines);
      res.json({ from: a, to: b, stats, hunks: diffHunks(lines, 4) });
    });

    // The report's main file may be .html / .adoc / .md / .json; give the right MIME by extension so the
    // frontend can drop a .html straight into an iframe preview (the same kind of file you would open in VSCode).
    const REPORT_MIME = {
      html: 'text/html; charset=utf-8',
      json: 'application/json; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      adoc: 'text/plain; charset=utf-8',
    };
    app.get('/api/reports/:name', (req, res) => {
      const name = String(req.params.name ?? '');
      const body = readReport(getConfig(), name);
      if (body === null) return res.status(404).json({ error: 'not found' });
      const ext = path.extname(name).slice(1).toLowerCase();
      res.type(REPORT_MIME[ext] ?? 'text/plain; charset=utf-8').send(body);
    });
}
