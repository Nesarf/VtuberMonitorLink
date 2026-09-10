// server.js — 本机 HTTP 服务 + REST API（仅监听 127.0.0.1）
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.js';
import { CATEGORIES, effectiveSources, sanitizeCustomSource } from './sources.js';
import { FETCH_KINDS } from './fetchers/index.js';
import { detectBrowsers } from './fetchers/browser.js';
import { makeProxyAgent } from './net.js';
import { runOnce, runState, selectSources } from './runner.js';
import { exportReport, latestIntel, listReports, readReport, searchReports } from './reports.js';
import { preflight } from './analyze.js';
import { PRESETS, activeProvider, newProvider, listModels } from './llm.js';
import { TARGET_KINDS, DEFAULT_RULES, allBaselines, checkTarget, readHistory, sanitizeId, sanitizeTarget, watchDir } from './watch.js';
import * as scheduler from './scheduler.js';

export function createApp({ getConfig, setConfig, log, onConfigChanged }) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

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
      fetchKinds: FETCH_KINDS,
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
    if (!effectiveSources(cfg).some((s) => s.id === id)) return res.status(404).json({ error: `unknown source: ${id}` });
    const { enabled, login, url, uid, proxy, note } = req.body ?? {};
    cfg.sources = cfg.sources ?? {};
    cfg.sources[id] = {
      ...(cfg.sources[id] ?? {}),
      ...(enabled === undefined ? {} : { enabled: !!enabled }),
      ...(login ? { login } : {}),
    };
    // 覆盖内置来源的少数可变字段（uid / 地址 / 出口）时，落到自定义来源列表里
    const customIdx = (cfg.customSources ?? []).findIndex((s) => s.id === id);
    if (url !== undefined || uid !== undefined || proxy !== undefined || note !== undefined) {
      const base = customIdx >= 0 ? cfg.customSources[customIdx] : effectiveSources(cfg).find((s) => s.id === id);
      const merged = sanitizeCustomSource({ ...base, url, uid, proxy, note });
      if (customIdx >= 0) cfg.customSources[customIdx] = merged;
      else cfg.customSources = [...(cfg.customSources ?? []), merged];
    }
    setConfig(cfg);
    res.json({ ok: true, sources: effectiveSources(cfg) });
  });

  // ── 自定义来源 / custom sources ──────────────────────────────────
  app.post('/api/sources/custom', (req, res) => {
    const cfg = getConfig();
    const s = sanitizeCustomSource(req.body ?? {});
    if (!s.id) return res.status(400).json({ error: 'id is required' });
    if (!s.url && !s.uid) return res.status(400).json({ error: 'url or uid is required' });
    if (effectiveSources(cfg).some((x) => x.id === s.id)) return res.status(409).json({ error: `source already exists: ${s.id}` });
    cfg.customSources = [...(cfg.customSources ?? []), s];
    setConfig(cfg);
    res.json({ ok: true, source: s, sources: effectiveSources(cfg) });
  });

  app.delete('/api/sources/custom/:id', (req, res) => {
    const cfg = getConfig();
    const before = (cfg.customSources ?? []).length;
    cfg.customSources = (cfg.customSources ?? []).filter((s) => s.id !== req.params.id);
    if (cfg.sources?.[req.params.id]) delete cfg.sources[req.params.id];
    setConfig(cfg);
    res.json({ ok: true, removed: before - cfg.customSources.length, sources: effectiveSources(cfg) });
  });

  // ── 浏览器探测 / browser detection ───────────────────────────────
  app.get('/api/browsers', (_req, res) => {
    res.json({ detected: detectBrowsers(), config: getConfig().browser });
  });

  // ── 登录态探测 / login availability ──────────────────────────────
  // 只回报「读到了哪些 cookie 的名字」，**绝不回传任何值**。
  app.post('/api/cookies/check', async (req, res) => {
    const cfg = getConfig();
    const profileDir = req.body?.profileDir ?? cfg.browser?.profileDir ?? '';
    const domains = Array.isArray(req.body?.domains) && req.body.domains.length ? req.body.domains : ['bilibili.com'];
    const { readBrowserCookies } = await import('./cookies.js');
    const r = await readBrowserCookies(profileDir, domains);
    res.json({
      ok: r.ok,
      error: r.error ?? null,
      warning: r.warning ?? null,
      profile: r.profile ?? null,
      domains,
      cookieCount: (r.names ?? []).length,
      hasSession: (r.names ?? []).includes('SESSDATA'),
      names: r.names ?? [],
    });
  });

  // ── 代理探测 / proxy detection ───────────────────────────────────
  // 逐个试探本机常见代理端口，返回真正能出网的地址（不写死任何端口为唯一答案）
  app.get('/api/proxy/detect', async (_req, res) => {
    const ports = [7890, 7891, 7897, 1080, 1081, 8118, 10809, 10808, 10090, 2080, 8889, 8888, 20171];
    const found = [];
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`;
      try {
        const agent = makeProxyAgent(url);
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

  // ── LLM 档位 / LLM providers ─────────────────────────────────────
  app.get('/api/llm/presets', (_req, res) => {
    const cfg = getConfig();
    const p = activeProvider(cfg);
    res.json({
      presets: PRESETS,
      providers: cfg.llm?.providers ?? [],
      activeId: cfg.llm?.activeId ?? '',
      active: { ...p, apiKey: p.apiKey ? '***' : '' }, // 不回传明文 Key
      hasKey: !!p.apiKey,
    });
  });

  app.post('/api/llm/new', (req, res) => {
    const cfg = getConfig();
    const p = newProvider(req.body?.preset ?? 'deepseek', req.body?.overrides ?? {});
    cfg.llm = cfg.llm ?? {};
    cfg.llm.providers = [...(cfg.llm.providers ?? []), p];
    cfg.llm.activeId = p.id;
    setConfig(cfg);
    res.json({ ok: true, provider: p });
  });

  // 用「尚未保存的档位」测连通性：body 直接带 provider
  app.post('/api/llm/test', async (req, res) => {
    const cfg = getConfig();
    const saved = activeProvider(cfg);
    const wanted = req.body?.provider ?? {};
    // 前端回传的是掩码，别拿 *** 去测
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

  // ── 监视对象 / watch targets ─────────────────────────────────────
  app.get('/api/watch', (_req, res) => {
    const cfg = getConfig();
    const baselines = allBaselines(cfg);
    const targets = (cfg.watch?.targets ?? []).map((t) => {
      const b = baselines[sanitizeId(t.id)] ?? null;
      return {
        ...t,
        baseline: b
          ? {
              at: b.updatedAt,
              kind: b.kind,
              revid: b.revid,
              follower: b.follower,
              ids: Array.isArray(b.ids) ? b.ids.length : undefined,
              lastTimestamp: b.lastTimestamp,
            }
          : null,
      };
    });
    res.json({
      enabled: cfg.watch?.enabled !== false,
      targets,
      rules: { ...DEFAULT_RULES, ...(cfg.watch?.rules ?? {}) },
      kinds: TARGET_KINDS,
    });
  });

  app.put('/api/watch', (req, res) => {
    const cfg = getConfig();
    const { targets, rules, enabled } = req.body ?? {};
    cfg.watch = cfg.watch ?? {};
    if (Array.isArray(targets)) {
      const seen = new Set();
      cfg.watch.targets = targets.map((t, i) => {
        const clean = sanitizeTarget(t, i);
        while (seen.has(clean.id)) clean.id = `${clean.id}-2`;
        seen.add(clean.id);
        return clean;
      });
    }
    if (rules && typeof rules === 'object') cfg.watch.rules = { ...DEFAULT_RULES, ...cfg.watch.rules, ...rules };
    if (enabled !== undefined) cfg.watch.enabled = !!enabled;
    setConfig(cfg);
    res.json({ ok: true, watch: cfg.watch });
  });

  app.post('/api/watch/check', async (req, res) => {
    const cfg = getConfig();
    const id = req.body?.id;
    const targets = (cfg.watch?.targets ?? []).filter((t) => (id ? t.id === id : t.enabled !== false));
    if (!targets.length) return res.status(400).json({ error: 'no matching watch target' });
    const results = [];
    for (const t of targets) results.push(await checkTarget(t, { cfg, rules: cfg.watch?.rules, log }));
    const baselines = allBaselines(cfg);
    res.json({
      ok: true,
      results: results.map((r) => ({
        ...r,
        target: { ...r.target, baseline: baselines[sanitizeId(r.target?.id)] ? true : null },
      })),
    });
  });

  app.get('/api/watch/:id/history', (req, res) => {
    const cfg = getConfig();
    res.json({ id: req.params.id, history: readHistory(cfg, req.params.id, Number(req.query.limit ?? 50)) });
  });

  app.delete('/api/watch/:id/baseline', (req, res) => {
    const cfg = getConfig();
    const f = path.join(watchDir(cfg), 'history', `${sanitizeId(req.params.id)}.baseline.json`);
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
    res.json({ ok: true, cleared: req.params.id, next: '下次检查会重建基线，不报变更' });
  });

  // ── 运行 / run ───────────────────────────────────────────────────
  app.post('/api/run', async (req, res) => {
    const mode = ['merch', 'watch'].includes(req.body?.mode) ? req.body.mode : 'daily';
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
    res.json(await preflight(getConfig()));
  });

  // ── 情报条目 / intel items ───────────────────────────────────────
  app.get('/api/intel', (req, res) => {
    const cfg = getConfig();
    const data = latestIntel(cfg, Number(req.query.limit ?? 400));
    const source = String(req.query.source ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const onlyAlerts = req.query.alerts === '1';
    let items = data.items ?? [];
    if (source) items = items.filter((i) => i.sourceId === source);
    if (onlyAlerts) items = items.filter((i) => i.keywords?.length);
    if (q) items = items.filter((i) => `${i.title ?? ''} ${i.text ?? ''}`.toLowerCase().includes(q));
    res.json({
      generatedAt: data.generatedAt ?? null,
      date: data.date ?? null,
      watch: data.watch ?? [],
      sources: data.sources ?? [],
      total: (data.items ?? []).length,
      count: items.length,
      runs: data.runs ?? [],
      items,
    });
  });

  // ── 报告 / reports ───────────────────────────────────────────────
  app.get('/api/reports', (_req, res) => res.json(listReports(getConfig())));

  // 注意：必须排在 /api/reports/:name 之前，否则 search 会被当成文件名
  app.get('/api/reports/search', (req, res) => {
    res.json({ query: req.query.q ?? '', hits: searchReports(getConfig(), req.query.q) });
  });

  app.get('/api/reports/:name/export', (req, res) => {
    const format = req.query.format === 'json' ? 'json' : 'html';
    const out = exportReport(getConfig(), req.params.name, format);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
    res.type(out.mime).send(out.body);
  });

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
