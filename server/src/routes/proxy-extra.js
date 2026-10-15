// routes/proxy-extra.js — the proxy endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { APP_ROOT } from '../config.js';
import { probeTor, torLaunchPlan } from '../socks.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerProxyExtraRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn }) {
    // ── Tor egress ───────────────────────────────────────────────────
    app.post('/api/proxy/tor', async (req, res) => {
      const cfg = getConfig();
      const socks = req.body?.socks ?? cfg.proxy?.torSocks;
      res.json(await probeTor(cfg, socks));
    });

    // If torExe is configured, one click can bring it up (tor is not bundled, this just clicks for you).
    // The arguments are not a bare spawn — see the comment on torLaunchPlan: Tor Browser's tor needs its own
    // torrc (otherwise there are no bridges and the port is wrong), and a standalone tor's data directory has
    // to point inside the app directory (never write to the C: drive).
    app.post('/api/proxy/tor/start', (req, res) => {
      const cfg = getConfig();
      const exe = String(req.body?.exe ?? cfg.proxy?.torExe ?? '').trim();
      if (!exe) return res.status(400).json({ error: '未配置 torExe，请填 Tor 的 tor.exe 路径（例如 Tor Browser 里的 Browser\\TorBrowser\\Tor\\tor.exe）' });
      if (!fs.existsSync(exe)) return res.status(400).json({ error: `找不到文件：${exe}` });
      const plan = torLaunchPlan({ exe, socksUrl: cfg.proxy?.torSocks, appRoot: APP_ROOT });
      if (!plan.ok) return res.status(400).json({ error: plan.error });
      try {
        const child = spawn(exe, plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        res.json({
          ok: true,
          started: exe,
          kind: plan.kind,
          command: plan.command,
          note: plan.note,
          hint: 'Tor 启动需要时间（走网桥会更久，通常 10~40 秒），稍后点「检测 Tor」确认；日志里看到 Bootstrapped 100% 就是通了',
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
}
