// routes/vdb.js — the vdb endpoints, moved out of the factory verbatim.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration and the one place that
// persists a patch of it, and imports everything else from the module that owns it. The handlers below are
// unchanged - see the commit that added this file for the traversals that prove it, rather than the diff.
import { ensureIndex, indexSummary, loadCachedIndex, searchIndex, toPerson } from '../vdb.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerVdbRoutes(app, { getConfig, patchConfig }) {

    // ── VDB roster (multi-platform) ──────────────────────────────────
    // Data source github.com/dd-center/vdb (the upstream of vtbs.moe), licensed CC BY-NC-SA 4.0:
    //   · fetched at runtime only and cached in app/vdb/, **never shipped in the release package** (see the exclusion list in tools/make-zip.mjs)
    //   · both the UI and the docs have to carry the attribution
    // It supplies the dimension we were missing: **agency (group)** + multilingual names + per-platform accounts.
    app.get('/api/vdb/status', (_req, res) => {
      const cfg = getConfig();
      const index = loadCachedIndex(cfg);
      res.json({
        ok: true,
        cached: !!index,
        summary: indexSummary(index),
        count: index?.count ?? 0,
        groups: index?.groups ?? {},
        platforms: index?.platforms ?? {},
        generatedAt: index?.generatedAt ?? null,
        source: index?.source ?? 'dd-center/vdb',
        license: index?.license ?? 'CC BY-NC-SA 4.0',
      });
    });

    // explicit sync (this one really downloads, ~0.5MB, one request)
    app.post('/api/vdb/sync', async (_req, res) => {
      const cfg = getConfig();
      try {
        const index = await ensureIndex(cfg, { force: true, log });
        res.json({ ok: true, count: index.count, groups: Object.keys(index.groups ?? {}).length, summary: indexSummary(index) });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    });

    // search: a name (any language/alias) and an account id or link shape on **any platform** all match
    app.get('/api/vdb/search', async (req, res) => {
      const cfg = getConfig();
      const q = String(req.query.q ?? '').trim();
      if (!q) return res.json({ ok: true, results: [], summary: indexSummary(loadCachedIndex(cfg)) });
      try {
        // fetch once automatically on first use: 0.5MB in a single request is friendlier than making the user guess that they "have to sync first"
        let index = loadCachedIndex(cfg);
        if (!index) index = await ensureIndex(cfg, { log });
        const results = searchIndex(index, q, { limit: Number(req.query.limit ?? 20), group: req.query.group || null });
        res.json({ ok: true, results, summary: indexSummary(index), license: index.license, source: index.source });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message, results: [] });
      }
    });

    app.get('/api/vdb/groups', (_req, res) => {
      const index = loadCachedIndex(getConfig());
      res.json({ ok: true, groups: index?.groups ?? {}, summary: indexSummary(index) });
    });

    // import: turn the selected VDB records into "followed people" (name / aliases / agency / per-platform links)
    app.post('/api/vdb/import', (req, res) => {
      const cfg = getConfig();
      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
      if (!keys.length) return res.status(400).json({ ok: false, error: '没有选中任何条目 / nothing selected' });
      const index = loadCachedIndex(cfg);
      if (!index) return res.status(400).json({ ok: false, error: '还没有花名册，先点「同步花名册」/ sync the roster first' });
      const want = new Set(keys);
      const picked = (index.records ?? []).filter((r) => want.has(r.key));
      if (!picked.length) return res.status(400).json({ ok: false, error: '选中的条目在花名册里找不到' });
      const list = [...(cfg.people ?? [])];
      const existing = new Set(list.map((p) => p.id));
      const added = [];
      const skipped = [];
      for (const r of picked) {
        // go through the same sanitizing path as a manual add: VDB data has to pass validation too, and there is no back door for it
        const { person, error } = sanitizePerson(toPerson(r), list.length + added.length);
        if (error) {
          skipped.push({ key: r.key, reason: error });
          continue;
        }
        if (existing.has(person.id)) {
          skipped.push({ key: r.key, id: person.id, reason: '已经有同 id 的关注对象' });
          continue;
        }
        added.push(person);
        existing.add(person.id);
      }
      if (added.length) {
        patchConfig(cfg, { people: [...list, ...added] });
        log?.info?.(`imported ${added.length} people from VDB (${list.length} → ${list.length + added.length})`);
      }
      res.json({ ok: true, added: added.length, skipped, people: (getConfig().people ?? []).length });
    });
}
