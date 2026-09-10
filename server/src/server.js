// server.js — 本机 HTTP 服务 + REST API（仅监听 127.0.0.1）
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.js';
import { CATEGORIES, BUILTIN_SOURCES, effectiveSources } from './sources.js';
import { detectBrowsers } from './fetchers/browser.js';
import { ProxyAgent } from 'undici';
import { runOnce, runState, selectSources } from './runner.js';
import { listReports, readReport } from './reports.js';
import { preflight } from './analyze.js';
import * as scheduler from './scheduler.js';

export function createApp({ getConfig, setConfig, log, onConfigChanged }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // ── 配置 / config ────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => res.json(getConfig()));
  app.put('/api/config', (req, res) => {
    const next = setConfig(req.body ?? {});
    onConfigChanged?.(next);
    res.json(next);
  });

  // ── 来源目录 / source catalog ────────────────────────────────────
  app.get('/api/sources', (_req, res) => {
    const cfg = getConfig();
    res.json({
      categories: CATEGORIES,
      sources: effectiveSources(cfg),
      selected: {
        daily: selectSources(cfg, 'daily').length,
        merch: selectSources(cfg, 'merch').length,
      },
    });
  });

  app.patch('/api/sources/:id', (req, res) => {
    const cfg = getConfig();
    const { id } = req.params;
    if (!BUILTIN_SOURCES.some((s) => s.id === id)) return res.status(404).json({ error: `unknown source: ${id}` });
    const { enabled, login } = req.body ?? {};
    cfg.sources = cfg.sources ?? {};
    cfg.sources[id] = {
      ...(cfg.sources[id] ?? {}),
      ...(enabled === undefined ? {} : { enabled: !!enabled }),
      ...(login ? { login } : {}),
    };
    setConfig(cfg);
    res.json({ ok: true, sources: effectiveSources(cfg) });
  });

  // ── 浏览器探测 / browser detection ───────────────────────────────
  app.get('/api/browsers', (_req, res) => {
    res.json({ detected: detectBrowsers(), config: getConfig().browser });
  });

  // ── 代理探测 / proxy detection ───────────────────────────────────
  // 逐个试探本机常见代理端口，返回真正能出网的地址（不写死任何端口为唯一答案）
  app.get('/api/proxy/detect', async (_req, res) => {
    const ports = [7890, 7891, 7897, 1080, 1081, 8118, 10809, 10808, 10090, 2080, 8889, 8888, 20171];
    const found = [];
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`;
      try {
        const agent = new ProxyAgent(url);
        const r = await fetch('https://api.ipify.org?format=json', {
          dispatcher: agent,
          signal: AbortSignal.timeout(3500),
        });
        if (r.ok) found.push(url);
      } catch {
        /* 该端口不是可用代理，继续试探 / not a usable proxy, keep probing */
      }
    }
    res.json({ found, probed: ports.length });
  });

  // ── 运行 / run ───────────────────────────────────────────────────
  app.post('/api/run', async (req, res) => {
    const mode = req.body?.mode === 'merch' ? 'merch' : 'daily';
    if (runState.running) return res.status(409).json({ error: 'a run is already in progress' });
    // 立即返回，运行在后台继续；UI 轮询 /api/state
    res.json({ ok: true, started: mode });
    runOnce({ cfg: getConfig(), mode }).catch((e) => log?.error(`run failed — ${e.message}`));
  });

  app.get('/api/state', (_req, res) =>
    res.json({ ...runState, nextFire: scheduler.nextFire(), schedule: getConfig().schedule })
  );

  // ── 前置检查 / preflight ─────────────────────────────────────────
  app.post('/api/preflight', async (_req, res) => {
    const r = await preflight(getConfig());
    res.json(r);
  });

  // ── 报告 / reports ───────────────────────────────────────────────
  app.get('/api/reports', (_req, res) => res.json(listReports(getConfig())));
  app.get('/api/reports/:name', (req, res) => {
    const md = readReport(getConfig(), req.params.name);
    if (md === null) return res.status(404).json({ error: 'not found' });
    res.type('text/markdown; charset=utf-8').send(md);
  });

  // ── 静态前端 / built web app ─────────────────────────────────────
  const webDist = path.join(APP_ROOT, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // 未知的 /api/* 必须是 JSON 404，不能被 SPA 兜底吞成一张 HTML 页面，
    // 否则调用方拿到 200 + HTML 会误判成功。
    // An unknown /api/* must answer with JSON, not fall through to the SPA
    // shell: a 200 + HTML would read as success to any caller.
    app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown API route' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .type('text/plain; charset=utf-8')
        .send(
          "Vtuber's Monitor Link API is running.\n前端尚未构建 / web not built yet —— 开发模式请运行 npm run dev:web\n"
        )
    );
  }

  return app;
}
