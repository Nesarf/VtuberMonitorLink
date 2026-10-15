// routes/llm.js — the llm endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { preflight } from '../analyze.js';
import { publicConfig } from '../config.js';
import { PRESETS, activeProvider, listModels, newProvider } from '../llm.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerLlmRoutes(app, { getConfig, patchConfig, log, persist }) {
    // ── LLM providers ────────────────────────────────────────────────
    app.get('/api/llm/presets', (_req, res) => {
      const cfg = getConfig();
      const p = activeProvider(cfg);
      res.json({
        // The model lists go out as they are, and that is a decision with a measurement behind it rather than an
        // omission. A preset list is a **fallback for a provider that cannot be queried**, and the only predicate
        // available offline is the id pattern - which does not recognise `deepseek-flash`, the one model this
        // provider actually serves that can see (its capability is stated in metadata, not in its name). Filtering
        // these lists with that predicate would therefore delete the correct entry and keep the doubtful ones.
        // The pull path is where the rule belongs, and there the answer comes from the provider: listModels()
        // keeps only what the metadata or the id can show to be multimodal.
        presets: PRESETS,
        // The masked profile list, not `cfg.llm.providers` verbatim: masking only `active` (which this route
        // did at first) left every *other* profile's apiKey in the response — the same leak as /api/config,
        // one endpoint over. `publicConfig` is the one place the rule lives; the masker here is the same
        // function applied to the single active profile, so the two can never disagree.
        providers: publicConfig({ providers: cfg.llm?.providers ?? [] }).providers,
        activeId: cfg.llm?.activeId ?? '',
        // Never send the plaintext key back. `active` is wrapped in a one-key object so the walk has a field
        // *name* to judge (the rule is name-based, see config.js) instead of treating the profile itself as
        // the value under a nameless root.
        active: publicConfig({ provider: p }).provider,
        hasKey: !!p.apiKey,
      });
    });

    app.post('/api/llm/new', (req, res) => {
      let cfg = getConfig();
      const p = newProvider(req.body?.preset ?? 'deepseek', req.body?.overrides ?? {});
      cfg.llm = cfg.llm ?? {};
      cfg.llm.providers = [...(cfg.llm.providers ?? []), p];
      cfg.llm.activeId = p.id;
      cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
      res.json({ ok: true, provider: p });
    });

    // test connectivity with a "not yet saved provider": the body carries the provider directly
    app.post('/api/llm/test', async (req, res) => {
      const cfg = getConfig();
      const saved = activeProvider(cfg);
      const wanted = req.body?.provider ?? {};
      // what the frontend sends back is a mask, so never test with ***
      const provider = { ...saved, ...wanted, apiKey: wanted.apiKey && wanted.apiKey !== '***' ? wanted.apiKey : saved.apiKey };
      const r = await preflight(cfg, provider);
      res.json(r);
    });

    app.post('/api/llm/models', async (req, res) => {
      const cfg = getConfig();
      const saved = activeProvider(cfg);
      const wanted = req.body?.provider ?? {};
      const provider = { ...saved, ...wanted, apiKey: wanted.apiKey && wanted.apiKey !== '***' ? wanted.apiKey : saved.apiKey };
      res.json(await listModels(cfg, provider));
    });
}
