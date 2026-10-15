// routes/events.js — the events endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { dedupe, loadWeightHistory, makeWeighter, runClustering } from '../cluster.js';
import { latestIntel } from '../reports.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerEventsRoutes(app, { getConfig, patchConfig, log, eventWhy }) {
    // ── multi-source event merging / similarity dedupe / source weight ─
    // The algorithm and its self-tests live in cluster.js + tools/cluster-test.mjs (the similarity
    // machinery) and tools/cluster-identity-test.mjs (the layers): identity first — native id, canonical
    // url, extracted item id, exact title — and IDF-weighted Dice with a diameter limit last. Source
    // weight is learned from the history of "who reported it first".
    //
    // Every event carries **why its members are one event** (`why`), because a wrong merge is otherwise
    // invisible: `why.by` is the strongest layer that actually joined something, `why.layers` names the
    // shared key per layer, and `why.refused` counts the candidate pairs the guards turned away. `item.why`
    // says the same thing per item. This is additive: every field the UI read before is unchanged.
    app.get('/api/events', (req, res) => {
      const cfg = getConfig();
      const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
      const { clusters, stats, weights } = runClustering(cfg, items, { learn: req.query.learn !== '0' });
      res.json({
        ok: true,
        stats,
        weights,
        events: clusters.slice(0, Number(req.query.per ?? 60)).map((c) => ({
          id: c.id,
          title: c.title,
          url: c.url,
          firstAt: c.firstAt,
          lastAt: c.lastAt,
          sources: c.sources,
          sourceCount: c.sourceCount,
          duplicateCount: c.duplicateCount,
          confirmed: c.confirmed,
          weight: c.weight,
          leadSourceId: c.leadSourceId,
          firstSourceId: c.firstSourceId,
          people: c.people,
          similarityRange: c.similarityRange ?? null,
          why: eventWhy(c),
          items: c.items.map((i) => ({ id: i.id, title: i.title, sourceId: i.sourceId, url: i.url, publishedAt: i.publishedAt ?? i.at ?? null, why: i.reason ?? null })),
        })),
      });
    });

    // try the merge on a slice of items (touches no history, writes nothing) — handy for tuning the threshold, and it makes this path verifiable end to end
    app.post('/api/events/preview', (req, res) => {
      const cfg = getConfig();
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) return res.status(400).json({ error: 'items[] is required' });
      const { clusters, stats, weights } = runClustering(cfg, items, {
        learn: false,
        threshold: req.body?.threshold,
        windowHours: req.body?.windowHours,
      });
      res.json({ ok: true, stats, weights, events: clusters.map((c) => ({ id: c.id, title: c.title, sourceCount: c.sourceCount, duplicateCount: c.duplicateCount, sources: c.sources, confirmed: c.confirmed, leadSourceId: c.leadSourceId })) });
    });

    // dedupe only (keep the order of the item stream, drop the duplicates)
    app.get('/api/events/dedupe', (req, res) => {
      const cfg = getConfig();
      const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
      const weigh = makeWeighter(cfg, loadWeightHistory(cfg));
      const r = dedupe(items, { weight: weigh });
      res.json({ ok: true, kept: r.kept.length, dropped: r.dropped.length, removed: r.dropped, items: r.kept });
    });
}
