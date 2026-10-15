// routes/people.js — the people endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { entityStats } from '../entities.js';
import { annotateItems, feedByPerson, personExport, sanitizePerson, suggestFromPeople } from '../people.js';
import { latestIntel, loadFlags } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerPeopleRoutes(app, { getConfig, patchConfig }) {
    // ── follow people ────────────────────────────────────────────────
    // All matching happens in people.js (local string matching, no network, no LLM) and has its own self-test
    // tools/people-test.mjs: CJK substring + Latin word boundaries, to avoid false negatives and false positives.
    app.get('/api/people', (req, res) => {
      const cfg = getConfig();
      const people = cfg.people ?? [];
      const limit = Number(req.query.limit ?? 300);
      const items = latestIntel(cfg, limit).items ?? [];
      const { matched } = annotateItems(items, people);
      const feed = feedByPerson(items, people);
      const stats = Object.fromEntries(
        feed.map((f) => [
          f.person.id,
          { count: f.count, lastAt: f.lastAt, kinds: f.kinds },
        ])
      );
      res.json({
        ok: true,
        people: people.map((p) => ({ ...p, stats: stats[p.id] ?? { count: 0, lastAt: null, kinds: {} } })),
        scanned: items.length,
        matched,
        options: cfg.peopleOptions ?? {},
      });
    });

    app.post('/api/people', (req, res) => {
      const cfg = getConfig();
      const { person, error } = sanitizePerson(req.body ?? {}, (cfg.people ?? []).length);
      if (error) return res.status(400).json({ error });
      const list = [...(cfg.people ?? [])];
      if (list.some((p) => p.id === person.id)) return res.status(409).json({ error: `person exists: ${person.id}` });
      list.push(person);
      patchConfig(cfg, { people: list });
      res.json({ ok: true, person, people: list });
    });

    app.patch('/api/people/:id', (req, res) => {
      const cfg = getConfig();
      const list = [...(cfg.people ?? [])];
      const i = list.findIndex((p) => p.id === req.params.id);
      if (i < 0) return res.status(404).json({ error: 'person not found' });
      const { person, error } = sanitizePerson({ ...list[i], ...req.body, id: list[i].id }, i);
      if (error) return res.status(400).json({ error });
      list[i] = person;
      patchConfig(cfg, { people: list });
      res.json({ ok: true, person, people: list });
    });

    app.delete('/api/people/:id', (req, res) => {
      const cfg = getConfig();
      const list = (cfg.people ?? []).filter((p) => p.id !== req.params.id);
      patchConfig(cfg, { people: list });
      res.json({ ok: true, people: list });
    });

    // the information stream aggregated by person (whoever just showed activity comes first)
    app.get('/api/people/feed', (req, res) => {
      const cfg = getConfig();
      const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
      const feed = feedByPerson(items, cfg.people ?? [], { id: req.query.id ?? null, limit: Number(req.query.per ?? 50) });
      res.json({ ok: true, feed });
    });

    // suggest followed people from the entities already extracted (local statistics, no need to run the LLM again)
    app.get('/api/people/suggest', (req, res) => {
      const cfg = getConfig();
      const stats = entityStats(cfg, loadFlags(cfg));
      const suggestions = suggestFromPeople(stats.top ?? [], cfg.people ?? [], {
        minCount: Number(req.query.min ?? 2),
      });
      res.json({ ok: true, suggestions, scanned: stats.total ?? 0 });
    });

    // per-person intel export (JSON / Markdown) — also handy for feeding another tool or sending straight to a friend
    app.get('/api/people/:id/export', (req, res) => {
      const cfg = getConfig();
      const person = (cfg.people ?? []).find((p) => p.id === req.params.id);
      if (!person) return res.status(404).json({ error: 'person not found' });
      const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
      const bucket = feedByPerson(items, cfg.people, { id: person.id })[0];
      const format = String(req.query.format ?? 'json') === 'md' ? 'md' : 'json';
      const out = personExport(person, bucket?.items ?? [], format);
      res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
      res.type(out.mime).send(out.body);
    });
}
