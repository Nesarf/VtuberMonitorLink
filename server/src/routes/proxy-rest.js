// routes/proxy-rest.js — the proxy endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import * as proxyctl from '../proxyctl.js';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerProxyRestRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn }) {
    // ── proxy control (mihomo / Clash) ───────────────────────────────
    app.get('/api/proxy/control', async (_req, res) => {
      const cfg = getConfig();
      const d = await proxyctl.detectControl(cfg);
      res.json(d);
    });

    app.get('/api/proxy/nodes', async (req, res) => {
      const cfg = getConfig();
      const control = String(req.query.control ?? '').trim() || undefined;
      try {
        const r = await proxyctl.listGroups(cfg, control);
        res.json({ ok: true, ...r });
      } catch (e) {
        res.json({ ok: false, error: e.message, hint: '需要在内核配置里打开 external-controller' });
      }
    });

    // the latency from every node to **one specific site** — "pick the fastest node per site" leans on exactly this
    app.post('/api/proxy/nodes/test', busyGuard('proxy node test'), async (req, res) => {
      const cfg = getConfig();
      const { group, nodes, url, timeout } = req.body ?? {};
      if (!group || !Array.isArray(nodes) || !nodes.length) return res.status(400).json({ error: 'group and nodes are required' });
      try {
        const r = await proxyctl.groupDelaysFor(cfg, req.body?.control, group, nodes, url, Number(timeout) || 5000);
        res.json({ ok: true, ...r });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.post('/api/proxy/node', async (req, res) => {
      const cfg = getConfig();
      const { group, node } = req.body ?? {};
      if (!group || !node) return res.status(400).json({ error: 'group and node are required' });
      try {
        res.json(await proxyctl.selectNode(cfg, req.body?.control, group, node));
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
}
