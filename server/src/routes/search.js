// routes/search.js — the search endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { activeProvider, checkedChatRequest, providerPolicy } from '../llm.js';
import { netFetch } from '../net.js';
import { loadFlags } from '../reports.js';
import { corpusSample, loadVocab, saveVocab, search, tagCloud } from '../search.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerSearchRoutes(app, { getConfig, patchConfig }) {
    // ── search ───────────────────────────────────────────────────────
    // Purely local matching: no LLM and no network required. The LLM is only used by the optional "help me recognise this person" assistant.
    app.post('/api/search', (req, res) => {
      const cfg = getConfig();
      const flags = loadFlags(cfg);
      res.json(search(cfg, req.body ?? {}, flags));
    });

    app.get('/api/search/tags', (_req, res) => {
      const cfg = getConfig();
      res.json(tagCloud(cfg, loadFlags(cfg)));
    });

    app.put('/api/search/tags', (req, res) => {
      const cfg = getConfig();
      const tags = req.body?.tags ?? {};
      if (!tags || typeof tags !== 'object') return res.status(400).json({ error: 'tags must be an object' });
      const clean = {};
      for (const [k, v] of Object.entries(tags)) {
        const key = String(k).slice(0, 40);
        if (!key) continue;
        clean[key] = (Array.isArray(v) ? v : []).map((x) => String(x).slice(0, 40)).slice(0, 20);
      }
      saveVocab(cfg, clean);
      res.json({ ok: true, tags: loadVocab(cfg) });
    });

    // optional assistant: for when only the traits are remembered and the name is forgotten. With no LLM configured it tells the frontend plainly that it is unusable.
    app.post('/api/search/assist', async (req, res) => {
      const cfg = getConfig();
      const p = activeProvider(cfg);
      if (!p.apiKey) {
        return res.json({
          ok: false,
          needsLlm: true,
          error: '「帮我认人」需要配置 LLM；普通检索不需要，直接用关键词和标签就行',
        });
      }
      const description = String(req.body?.description ?? '').slice(0, 2000);
      if (!description.trim()) return res.status(400).json({ error: 'description is required' });

      const sample = corpusSample(cfg, 150);
      const req2 = await checkedChatRequest(p, [
        {
          role: 'system',
          content:
            '你是 VTuber 情报检索助手。用户只记得一些特征（外貌/声音/直播内容/名场面/所属关系），忘了名字。' +
            '请给出候选，并给出**可直接用于检索的关键词**。只输出 JSON，不要别的话。',
        },
        {
          role: 'user',
          content:
            `用户描述：${description}\n\n` +
            `本地已收集的条目样本（可能相关，也可能无关）：\n${sample.join('\n')}\n\n` +
            '请输出：{"candidates":[{"name":"可能的名字","reason":"为什么这么猜","confidence":0-1}],' +
            '"searchTerms":["可直接检索的词"],"tags":["可能的标签"]}',
        },
      ], {}, cfg);
      // The refusal is the answer here too: this route talks to a provider profile that arrived in the request
      // body, so the endpoint is exactly as user-supplied as the one the settings page tests.
      if (!req2.ok) return res.json({ ok: false, error: req2.error });
      try {
        const r = await netFetch(
          req2.url,
          { method: 'POST', headers: req2.headers, body: JSON.stringify(req2.body), signal: AbortSignal.timeout(120000) },
          { cfg, policy: providerPolicy(p, cfg) }
        );
        const text = await r.text();
        if (!r.ok) return res.json({ ok: false, error: `LLM HTTP ${r.status} — ${text.slice(0, 200)}` });
        const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
        const m = /\{[\s\S]*\}/.exec(content);
        let parsed = null;
        try {
          parsed = m ? JSON.parse(m[0]) : null;
        } catch {
          /* the model did not hand back clean JSON */
        }
        res.json({ ok: true, provider: { name: p.name, model: req2.body.model }, raw: content, ...(parsed ?? {}) });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });
}
