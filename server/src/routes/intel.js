// routes/intel.js — the intel endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { annotateItems } from '../people.js';
import { diffIntel, latestIntel, loadFlags, setFlag } from '../reports.js';
import { search } from '../search.js';
import { applyVisionTags, loadVisionCache } from '../vision.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerIntelRoutes(app, { getConfig, patchConfig, log }) {
    // ── intel items ──────────────────────────────────────────────────
    app.get('/api/intel', (req, res) => {
      const cfg = getConfig();
      const data = latestIntel(cfg, Number(req.query.limit ?? 400));
      const flags = loadFlags(cfg);
      const source = String(req.query.source ?? '').trim();
      const q = String(req.query.q ?? '').trim().toLowerCase();
      const onlyAlerts = req.query.alerts === '1';
      let items = (data.items ?? []).map((i) => ({ ...i, flag: flags[i.id] ?? null }));
      // attribution to a "person": local matching, every hit carries evidence (the UI must be able to explain why an item is attributed to them)
      const peopleCfg = cfg.people ?? [];
      const annotated = annotateItems(items, peopleCfg);
      items = annotated.items;
      // image tags (from the cache, merged at read time) — when present they also join keywords, so search can match them too
      let visionTagged = 0;
      try {
        if (cfg.vision?.enabled) {
          const vision = applyVisionTags(items, loadVisionCache(cfg));
          items = vision.items;
          visionTagged = items.filter((i) => (i.imageTags ?? []).length).length;
        }
      } catch {
        // a broken tagging cache must not affect the intel stream
      }
      const person = String(req.query.person ?? '').trim();
      if (person) items = items.filter((i) => (i.people ?? []).includes(person));
      if (req.query.followed === '1' || (cfg.peopleOptions?.onlyFollowed && !person)) {
        items = items.filter((i) => (i.people ?? []).length > 0);
      }
      if (source) items = items.filter((i) => i.sourceId === source);
      if (onlyAlerts) items = items.filter((i) => i.keywords?.length);
      if (req.query.starred === '1') items = items.filter((i) => i.flag?.starred);
      if (req.query.unread === '1') items = items.filter((i) => !i.flag?.read);
      if (q) items = items.filter((i) => `${i.title ?? ''} ${i.text ?? ''}`.toLowerCase().includes(q));
      res.json({
        generatedAt: data.generatedAt ?? null,
        date: data.date ?? null,
        watch: data.watch ?? [],
        sources: data.sources ?? [],
        total: (data.items ?? []).length,
        count: items.length,
        // per-person hit stats: the UI uses them to show "how many items matched a followed person in this run"
        peopleMatched: annotated.matched,
        followed: (items ?? []).filter((i) => (i.people ?? []).length > 0).length,
        visionTagged,
        runs: data.runs ?? [],
        starred: (data.items ?? []).filter((i) => flags[i.id]?.starred).length,
        items,
      });
    });

    // star / read / custom tags
    app.patch('/api/intel/:id', (req, res) => {
      const cfg = getConfig();
      const { starred, read, note, tags } = req.body ?? {};
      const flag = setFlag(cfg, req.params.id, {
        ...(starred === undefined ? {} : { starred: !!starred }),
        ...(read === undefined ? {} : { read: !!read }),
        ...(note === undefined ? {} : { note: String(note).slice(0, 500) }),
        // custom tags: search uses them (search.js buildIndex reads flags[id].tags)
        ...(tags === undefined
          ? {}
          : {
              tags: (Array.isArray(tags) ? tags : [])
                .map((t) => String(t).trim().slice(0, 40))
                .filter(Boolean)
                .slice(0, 20),
            }),
      });
      res.json({ ok: true, id: req.params.id, flag });
    });

    // this round vs the previous one
    app.get('/api/intel/diff', (_req, res) => res.json(diffIntel(getConfig())));
}
