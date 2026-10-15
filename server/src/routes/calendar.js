// routes/calendar.js — the anniversary / birthday / 3D-reveal countdown endpoints.
//
// Why this is the first route group to move out of server.js: the file had grown to ~2 480 lines holding ~90
// routes, and a factory that size is where a shared helper quietly becomes a per-route copy. This group was
// chosen because it is genuinely self-contained - it reads the configuration, edits one section of it, and does
// all its date arithmetic in `calendar.js` (which has its own self-test, tools/calendar-test.mjs) - so moving it
// proves the shape the rest will follow:
//
//   · a route module exports `register<Group>Routes(app, ctx)` and nothing else;
//   · it imports what it needs from the module that owns it (calendar.js here, reports.js for the intel scan),
//     rather than reaching into server.js;
//   · the two things only the factory can provide - the live configuration and the one place that persists a
//     patch of it - arrive as `ctx`, so a route cannot invent its own way to save.
//
// The handlers are moved verbatim: a refactor that also changes behaviour is two changes in one commit, and the
// proof that this one does not is `npm run traverse` (every endpoint), `traverse-flows` and the UI walk.
import { detectFromItems, marksFor, monthGrid, sanitizeEntry, upcoming } from '../calendar.js';
import { latestIntel } from '../reports.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerCalendarRoutes(app, { getConfig, patchConfig }) {
  // ── anniversary / birthday / 3D reveal countdown ─────────────────
  // All the date arithmetic (leap-day shift, time zones, daylight saving) lives in calendar.js with its own
  // self-test, tools/calendar-test.mjs (`npm run test:calendar`), which is the reason this group could move
  // without the arithmetic moving with it. The count is deliberately not quoted here: a number in a comment is a
  // number that goes stale, and the suite prints its own.
  app.get('/api/calendar', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(1, Math.min(730, Number(req.query.days ?? cfg?.calendar?.reportDays ?? 60)));
    const view = upcoming(cfg, { days });
    const month = Number(req.query.month ?? 0);
    const year = Number(req.query.year ?? 0);
    const grid = month
      ? monthGrid(year || Number(view.today.slice(0, 4)), month, Number(req.query.weekStart ?? 1), {
          marks: marksFor(cfg, year || Number(view.today.slice(0, 4)), month),
        })
      : null;
    res.json({ ...view, entries: cfg?.calendar?.entries ?? [], grid });
  });

  app.post('/api/calendar/entry', (req, res) => {
    const cfg = getConfig();
    const { entry, error } = sanitizeEntry(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const list = [...(cfg.calendar?.entries ?? [])];
    if (list.some((e) => e.id === entry.id)) return res.status(409).json({ error: `entry exists: ${entry.id}` });
    list.push(entry);
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entry, entries: list });
  });

  app.patch('/api/calendar/entry/:id', (req, res) => {
    const cfg = getConfig();
    const list = [...(cfg.calendar?.entries ?? [])];
    const i = list.findIndex((e) => e.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'entry not found' });
    const { entry, error } = sanitizeEntry({ ...list[i], ...req.body, id: list[i].id });
    if (error) return res.status(400).json({ error });
    list[i] = entry;
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entry, entries: list });
  });

  app.delete('/api/calendar/entry/:id', (req, res) => {
    const cfg = getConfig();
    const list = (cfg.calendar?.entries ?? []).filter((e) => e.id !== req.params.id);
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entries: list });
  });

  // add several hints at once (ticked in the UI and then submitted)
  app.post('/api/calendar/import', (req, res) => {
    const cfg = getConfig();
    const incoming = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const list = [...(cfg.calendar?.entries ?? [])];
    const added = [];
    const skipped = [];
    for (const raw of incoming) {
      const { entry, error } = sanitizeEntry(raw);
      if (error) {
        skipped.push({ input: raw, error });
        continue;
      }
      // the same day plus the same kind counts as a duplicate (hints often have several sources pointing at the same thing)
      if (list.some((e) => e.date === entry.date && e.kind === entry.kind && e.name === entry.name)) {
        skipped.push({ input: raw, error: 'duplicate' });
        continue;
      }
      list.push(entry);
      added.push(entry);
    }
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, added: added.length, skipped, entries: list });
  });

  // look for hints in the latest intel (**local regex, no network, no LLM**)
  app.get('/api/calendar/detect', (req, res) => {
    const cfg = getConfig();
    const data = latestIntel(cfg, Number(req.query.limit ?? 300));
    const found = detectFromItems(data.items ?? []);
    const existing = new Set((cfg.calendar?.entries ?? []).map((e) => `${e.kind}|${e.date}`));
    res.json({
      ok: true,
      scanned: (data.items ?? []).length,
      suggestions: found.map((f) => ({ ...f, alreadyAdded: existing.has(`${f.kind}|${f.date}`) })),
    });
  });
}
