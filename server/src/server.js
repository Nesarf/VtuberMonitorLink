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
import {
  diffIntel,
  exportReport,
  latestIntel,
  listReports,
  loadFlags,
  previousIntel,
  readReport,
  searchReports,
  setFlag,
} from './reports.js';
import { diffHunks, diffLines, diffStats } from './diff.js';
import { preflight } from './analyze.js';
import { PRESETS, activeProvider, newProvider, listModels } from './llm.js';
import { TARGET_KINDS, DEFAULT_RULES, allBaselines, checkTarget, readHistory, sanitizeId, sanitizeTarget, watchDir } from './watch.js';
import { DEFAULT_SAMPLES, isFresh, loadCache, probeUrl, updateCache } from './probe.js';
import { adviceDir, diagnoseSource, listAdvice, readAdvice } from './diagnose.js';
import { corpusSample, loadVocab, saveVocab, search, tagCloud } from './search.js';
import { chatRequest } from './llm.js';
import { netFetch } from './net.js';
import { applyFeatures, extractFeatures, featureStats, loadFeatureCache } from './features.js';
import { buildDocx, buildXlsx, itemsToMarkdown, itemsToSheet } from './office.js';
import { probeTor } from './socks.js';
import { entityDetail, entityStats } from './entities.js';
import { spawn } from 'node:child_process';
import { NOTIFY_KINDS, maskTarget, newTarget, notify, sanitizeTarget as sanitizeNotifyTarget } from './notify.js';
import * as proxyctl from './proxyctl.js';
import { getThumbnail, listThumbs, readThumb } from './thumbs.js';
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

  // ── 自定义来源自检 / diagnostics for a user-added source ─────────
  // 连通正常就不产出任何文件；只有明显异常才生成一份人可读的诊断 markdown。
  app.post('/api/sources/:id/diagnose', async (req, res) => {
    const cfg = getConfig();
    const source = effectiveSources(cfg).find((s) => s.id === req.params.id);
    if (!source) return res.status(404).json({ error: `unknown source: ${req.params.id}` });
    try {
      const r = await diagnoseSource(source, cfg, log);
      res.json({ ok: true, sourceId: source.id, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/advice', (_req, res) => res.json({ files: listAdvice(getConfig()) }));

  // 点开就是一份可读网页（?raw=1 拿原始 markdown）
  app.get('/api/advice/:file', (req, res) => {
    const raw = req.query.raw === '1';
    const got = readAdvice(getConfig(), req.params.file, !raw);
    if (!got) return res.status(404).json({ error: 'not found' });
    res.type(got.mime).send(raw ? got.markdown : got.html);
  });

  app.delete('/api/advice/:file', (req, res) => {
    const cfg = getConfig();
    const p = path.join(adviceDir(cfg), path.basename(req.params.file));
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
    res.json({ ok: true, removed: path.basename(req.params.file) });
  });

  // ── 情报条目 / intel items ───────────────────────────────────────
  app.get('/api/intel', (req, res) => {
    const cfg = getConfig();
    const data = latestIntel(cfg, Number(req.query.limit ?? 400));
    const flags = loadFlags(cfg);
    const source = String(req.query.source ?? '').trim();
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const onlyAlerts = req.query.alerts === '1';
    let items = (data.items ?? []).map((i) => ({ ...i, flag: flags[i.id] ?? null }));
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
      runs: data.runs ?? [],
      starred: (data.items ?? []).filter((i) => flags[i.id]?.starred).length,
      items,
    });
  });

  // 星标 / 已读 / 自定义标签
  app.patch('/api/intel/:id', (req, res) => {
    const cfg = getConfig();
    const { starred, read, note, tags } = req.body ?? {};
    const flag = setFlag(cfg, req.params.id, {
      ...(starred === undefined ? {} : { starred: !!starred }),
      ...(read === undefined ? {} : { read: !!read }),
      ...(note === undefined ? {} : { note: String(note).slice(0, 500) }),
      // 自定义标签：检索会用它们（search.js 的 buildIndex 读 flags[id].tags）
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

  // 本次 vs 上次
  app.get('/api/intel/diff', (_req, res) => res.json(diffIntel(getConfig())));

  // ── 连通性探测 / reachability ────────────────────────────────────
  app.get('/api/probe', (_req, res) => {
    const cfg = getConfig();
    res.json({ cache: loadCache(cfg), ttlMinutes: cfg.ui?.probeTtlMinutes ?? 30 });
  });

  app.post('/api/probe', async (req, res) => {
    const cfg = getConfig();
    const samples = Math.max(1, Math.min(10, Number(req.body?.samples) || cfg.ui?.probeSamples || DEFAULT_SAMPLES));
    const modes = Array.isArray(req.body?.modes) && req.body.modes.length ? req.body.modes : ['direct', 'proxy'];
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : req.body?.id ? [req.body.id] : null;
    const oneUrl = String(req.body?.url ?? '').trim();

    const targets = [];
    if (oneUrl) {
      targets.push({ id: oneUrl, url: oneUrl, label: oneUrl });
    } else {
      const all = effectiveSources(cfg);
      const picked = ids ? all.filter((s) => ids.includes(s.id)) : all.filter((s) => s.enabled);
      for (const s of picked) if (s.url) targets.push({ id: s.id, url: s.url, label: s.name?.zh ?? s.id, source: s });
    }
    if (!targets.length) return res.status(400).json({ error: '没有可测的目标 / nothing to probe' });
    if (targets.length > 40) targets.length = 40;

    const out = [];
    for (const t of targets) {
      try {
        const r = await probeUrl(t.url, { cfg, samples, modes });
        out.push({ id: t.id, label: t.label, sourceId: t.source?.id ?? null, ...r });
      } catch (e) {
        out.push({ id: t.id, label: t.label, url: t.url, error: e.message, at: new Date().toISOString() });
      }
    }
    updateCache(cfg, out);
    res.json({ ok: true, probed: out.length, samples, results: out });
  });

  // ── 站点健康看板 / source health board ───────────────────────────
  app.get('/api/health', (_req, res) => {
    const cfg = getConfig();
    const cache = loadCache(cfg);
    const ttl = cfg.ui?.probeTtlMinutes ?? 30;
    const intel = latestIntel(cfg, 1);
    const lastRun = new Map((intel.sources ?? []).map((s) => [s.id, s]));
    const sources = effectiveSources(cfg)
      .filter((s) => s.enabled)
      .map((s) => {
        const p = cache[s.id];
        const run = lastRun.get(s.id);
        return {
          id: s.id,
          label: s.name?.zh ?? s.id,
          category: s.category,
          url: s.url,
          egress: s.proxy ?? (cfg.proxy?.enabled ? 'proxy' : 'direct'),
          direct: p?.modes?.direct ?? null,
          proxy: p?.modes?.proxy ?? null,
          verdict: p?.verdict ?? null,
          hint: p?.hint ?? null,
          probeAt: p?.at ?? null,
          probeFresh: isFresh(p, ttl),
          lastRunOk: run ? run.ok : null,
          lastRunBytes: run?.bytes ?? null,
        };
      });
    const problems = sources.filter(
      (s) => (!s.probeAt || s.probeFresh === false) === false && (s.verdict === 'none' || s.lastRunOk === false)
    );
    res.json({
      at: new Date().toISOString(),
      probed: sources.filter((s) => s.probeAt).length,
      total: sources.length,
      problems,
      sources,
    });
  });

  // ── 站点缩略图 / site thumbnails ─────────────────────────────────
  app.get('/api/thumb', async (req, res) => {
    const cfg = getConfig();
    const url = String(req.query.url ?? '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    const source = effectiveSources(cfg).find((s) => s.id === req.query.sourceId);
    const mode = req.query.mode === 'screenshot' ? 'screenshot' : req.query.mode === 'icon' ? 'icon' : 'auto';
    const r = await getThumbnail(url, {
      cfg,
      subject: source,
      refresh: req.query.refresh === '1',
      mode,
      log,
    });
    if (req.query.json === '1') return res.json(r);
    // 「这个站没有可用的缩略图」是正常结果，不是错误 —— 别用 404 让前端把它当请求失败
    if (!r.ok) return res.json({ ok: false, error: r.error, site: url });
    res.json({ ok: true, ...r, image: `/api/thumb/file/${encodeURIComponent(r.file)}` });
  });

  app.get('/api/thumb/file/:file', (req, res) => {
    const got = readThumb(getConfig(), req.params.file);
    if (!got) return res.status(404).json({ error: 'not found' });
    res.setHeader('cache-control', 'public, max-age=86400');
    res.type(got.type).send(got.buf);
  });

  app.get('/api/thumb/list', (_req, res) => {
    const cfg = getConfig();
    res.json({ dir: 'thumbs/', files: listThumbs(cfg) });
  });

  // ── 计划任务 / schedules ─────────────────────────────────────────
  app.get('/api/schedule', (_req, res) => {
    const cfg = getConfig();
    const tasks = (cfg.schedule?.tasks ?? []).map((t) => ({
      ...t,
      nextFire: scheduler.computeTaskNextFire(t)?.toISOString() ?? null,
      preview: scheduler.previewTask(t, 5),
      lastFire: scheduler.readHistory(cfg, 200).find((h) => h.taskId === t.id)?.at ?? null,
    }));
    res.json({
      tasks,
      nextFire: scheduler.nextFire(),
      running: scheduler.runningTasks(),
      history: scheduler.readHistory(cfg, 30),
      merchEveryDays: cfg.schedule?.merchEveryDays ?? 14,
    });
  });

  app.post('/api/schedule/run', async (req, res) => {
    const cfg = getConfig();
    const id = String(req.body?.id ?? '');
    const task = (cfg.schedule?.tasks ?? []).find((t) => t.id === id);
    if (!task) return res.status(404).json({ error: `unknown task: ${id}` });
    if (runState.running) return res.status(409).json({ error: 'a run is already in progress' });
    res.json({ ok: true, started: task.mode, task: task.id });
    runOnce({ cfg: getConfig(), mode: task.mode })
      .then((r) => scheduler.appendHistory(cfg, { taskId: task.id, name: task.name, manual: true, ok: !!r?.ok, error: r?.error ?? null }))
      .catch((e) => log?.error(`manual scheduled run failed — ${e.message}`));
  });

  // ── 通知推送 / alert destinations ────────────────────────────────
  app.get('/api/notify', (_req, res) => {
    const cfg = getConfig();
    res.json({
      kinds: NOTIFY_KINDS,
      desktop: cfg.notify?.desktop !== false,
      targets: (cfg.notify?.targets ?? []).map(maskTarget),
      count: (cfg.notify?.targets ?? []).length,
    });
  });

  app.post('/api/notify/new', (req, res) => {
    const cfg = getConfig();
    const t = newTarget(req.body?.kind ?? 'bark', req.body?.overrides ?? {});
    cfg.notify = cfg.notify ?? {};
    cfg.notify.targets = [...(cfg.notify.targets ?? []), t];
    setConfig(cfg);
    res.json({ ok: true, target: maskTarget(t) });
  });

  // 用「尚未保存的目标」试推一条
  app.post('/api/notify/test', async (req, res) => {
    const cfg = getConfig();
    const wanted = sanitizeNotifyTarget(req.body?.target ?? {}, 0);
    const saved = (cfg.notify?.targets ?? []).find((t) => t.id === wanted.id);
    // 前端回传的是掩码，别拿 *** 去发
    const merged = { ...(saved ?? {}), ...wanted, enabled: true, on: 'always' };
    for (const k of ['key', 'token', 'chatId', 'webhookUrl']) {
      if (!wanted[k] || /\*\*\*/.test(String(wanted[k]))) merged[k] = saved?.[k] ?? wanted[k] ?? '';
    }
    const r = await notify({ ...cfg, notify: { targets: [merged] } }, log, {
      title: "Vtuber's Monitor Link 测试通知",
      body: '这条是测试消息。看到它就说明推送通道是通的。',
      level: 'info',
    });
    res.json({ ok: r.results[0]?.ok === true, result: r.results[0] ?? null });
  });

  // ── 代理内核控制 / proxy control (mihomo / Clash) ─────────────────
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

  // 每个节点到**某个具体站点**的延迟 —— 「按站点挑最快节点」就靠这个
  app.post('/api/proxy/nodes/test', async (req, res) => {
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

  // ── 配置导入导出 / config import & export ────────────────────────
  app.get('/api/config/export', (req, res) => {
    const cfg = getConfig();
    const withSecrets = req.query.secrets === '1';
    const clone = JSON.parse(JSON.stringify(cfg));
    if (!withSecrets) {
      for (const p of clone.llm?.providers ?? []) p.apiKey = '';
      for (const t of clone.watch?.targets ?? []) if (t.botPassword) t.botPassword = '';
      for (const t of clone.notify?.targets ?? []) {
        for (const k of ['key', 'token', 'chatId', 'webhookUrl']) if (t[k]) t[k] = '';
      }
    }
    const body = JSON.stringify(
      { app: "Vtuber's Monitor Link", version: 2, exportedAt: new Date().toISOString(), secrets: withSecrets, config: clone },
      null,
      2
    );
    res.setHeader('content-disposition', `attachment; filename="vml-config-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type('application/json; charset=utf-8').send(body);
  });

  app.post('/api/config/import', (req, res) => {
    const incoming = req.body?.config ?? req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'expected a config object' });
    const cur = getConfig();

    // 按 id 合并数组里的对象（providers / targets / customSources / tasks …）。
    // 不能简单地「数组整体替换」—— 那样脱敏导出里的 apiKey:'' 会把本机已有的 Key 抹掉，
    // 而这正是导入自己刚导出的配置时最常见的用法。
    const mergeArray = (a, b) => {
      const aList = Array.isArray(a) ? a : [];
      const hasIds = b.every((x) => x && typeof x === 'object' && typeof x.id === 'string');
      if (!hasIds || !aList.every((x) => x && typeof x === 'object')) return b;
      const byId = new Map(aList.filter((x) => typeof x.id === 'string').map((x) => [x.id, x]));
      return b.map((item) => (byId.has(item.id) ? merge(byId.get(item.id), item) : item));
    };

    const merge = (a, b) => {
      if (Array.isArray(b)) return mergeArray(a, b);
      if (b && typeof b === 'object') {
        const out = { ...(a ?? {}) };
        for (const [k, v] of Object.entries(b)) {
          // 空字符串不覆盖已有的非空值：脱敏导出导入时不该抹掉密钥
          if (v === '' && typeof out[k] === 'string' && out[k]) continue;
          out[k] = merge(out[k], v);
        }
        return out;
      }
      return b;
    };
    const next = setConfig(merge(cur, incoming));
    onConfigChanged?.(next);
    res.json({ ok: true, config: next });
  });

  // ── 检索 / search ────────────────────────────────────────────────
  // 纯本地匹配：不需要 LLM，也不需要联网。LLM 只用于可选的「帮我认人」助手。
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

  // 可选助手：只记得特征、忘了名字时用。没有配 LLM 就明确告诉前端「用不了」。
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
    const req2 = chatRequest(p, [
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
    ]);
    try {
      const r = await netFetch(
        req2.url,
        { method: 'POST', headers: req2.headers, body: JSON.stringify(req2.body), signal: AbortSignal.timeout(120000) },
        { cfg }
      );
      const text = await r.text();
      if (!r.ok) return res.json({ ok: false, error: `LLM HTTP ${r.status} — ${text.slice(0, 200)}` });
      const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
      const m = /\{[\s\S]*\}/.exec(content);
      let parsed = null;
      try {
        parsed = m ? JSON.parse(m[0]) : null;
      } catch {
        /* 模型没给干净 JSON */
      }
      res.json({ ok: true, provider: { name: p.name, model: req2.body.model }, raw: content, ...(parsed ?? {}) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Office 导出 / Word & Excel ───────────────────────────────────
  // 纯 Node 手写 OOXML，不依赖 Office / COM / Python —— 便携 exe 不能假设目标机装了什么。
  app.get('/api/intel/export', (req, res) => {
    const cfg = getConfig();
    const format = ['xlsx', 'docx', 'md'].includes(String(req.query.format)) ? String(req.query.format) : 'xlsx';
    const data = latestIntel(cfg, Number(req.query.limit ?? 500));
    const items = applyFeatures(data.items ?? [], loadFeatureCache(cfg));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'md') {
      res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.md"`);
      return res.type('text/markdown; charset=utf-8').send(itemsToMarkdown(items, { title: '情报集' }));
    }
    if (format === 'docx') {
      const buf = buildDocx({ title: `情报集 ${stamp}`, markdown: itemsToMarkdown(items, { title: `情报集 ${stamp}` }) });
      res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.docx"`);
      return res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buf);
    }
    const buf = buildXlsx([{ name: stamp, rows: itemsToSheet(items) }]);
    res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  });

  // ── 特征抽取 / feature extraction (needs an LLM) ─────────────────
  app.get('/api/features', (_req, res) => res.json(featureStats(getConfig())));

  app.post('/api/features/extract', async (req, res) => {
    const cfg = getConfig();
    const items = applyFeatures(latestIntel(cfg, 400).items ?? [], loadFeatureCache(cfg));
    const r = await extractFeatures(cfg, items, log);
    res.json({
      ok: !r.error,
      error: r.error ?? null,
      extracted: r.extracted,
      cached: r.skipped,
      stats: featureStats(cfg),
    });
  });

  // ── Tor 无痕出口 / Tor egress ────────────────────────────────────
  app.post('/api/proxy/tor', async (req, res) => {
    const cfg = getConfig();
    const socks = req.body?.socks ?? cfg.proxy?.torSocks;
    res.json(await probeTor(cfg, socks));
  });

  // 若配置了 torExe，可以一键把它拉起来（不自带 tor，只是替你点一下）
  app.post('/api/proxy/tor/start', (req, res) => {
    const cfg = getConfig();
    const exe = String(req.body?.exe ?? cfg.proxy?.torExe ?? '').trim();
    if (!exe) return res.status(400).json({ error: '未配置 torExe，请填 Tor 的 tor.exe 路径（例如 Tor Browser 里的 Browser\\TorBrowser\\Tor\\tor.exe）' });
    if (!fs.existsSync(exe)) return res.status(400).json({ error: `找不到文件：${exe}` });
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      res.json({ ok: true, started: exe, hint: 'Tor 启动需要时间（配了网桥会更久），稍后点「检测 Tor」确认' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 人物档案 / entities ──────────────────────────────────────────
  // 把特征抽取出来的人名聚合成对象：他/她出现过哪些条目、什么游戏、哪些事件。
  app.get('/api/entities', (req, res) => {
    const cfg = getConfig();
    res.json(entityStats(cfg, loadFlags(cfg)));
  });

  app.get('/api/entities/:name', (req, res) => {
    const cfg = getConfig();
    const detail = entityDetail(cfg, req.params.name, { flags: loadFlags(cfg) });
    if (!detail) return res.status(404).json({ error: `no entity named ${req.params.name}` });
    res.json(detail);
  });

  // ── 来源批量开关 / bulk source toggles ───────────────────────────
  // 30 条来源一个个点太累，而且很容易在测试里忘了关（这个功能就是被这个坑逼出来的）
  app.post('/api/sources/bulk', (req, res) => {
    const cfg = getConfig();
    const { action, category, ids } = req.body ?? {};
    const all = effectiveSources(cfg);
    const picked = all.filter((s) => (ids?.length ? ids.includes(s.id) : category ? s.category === category : true));
    if (!picked.length) return res.status(400).json({ error: 'no matching sources' });
    cfg.sources = cfg.sources ?? {};
    for (const s of picked) {
      if (action === 'enable') cfg.sources[s.id] = { ...(cfg.sources[s.id] ?? {}), enabled: true };
      else if (action === 'disable') cfg.sources[s.id] = { ...(cfg.sources[s.id] ?? {}), enabled: false };
      else if (action === 'reset') delete cfg.sources[s.id];
      else return res.status(400).json({ error: 'action must be enable | disable | reset' });
    }
    setConfig(cfg);
    res.json({ ok: true, changed: picked.length, action, sources: effectiveSources(cfg) });
  });

  // ── 报告 / reports ───────────────────────────────────────────────
  app.get('/api/reports', (_req, res) => res.json(listReports(getConfig())));

  // 注意：必须排在 /api/reports/:name 之前，否则 search 会被当成文件名
  app.get('/api/reports/search', (req, res) => {
    res.json({ query: req.query.q ?? '', hits: searchReports(getConfig(), req.query.q) });
  });

  app.get('/api/reports/:name/export', (req, res) => {
    const format = ['json', 'docx'].includes(String(req.query.format)) ? String(req.query.format) : 'html';
    const out = exportReport(getConfig(), req.params.name, format);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
    // body 可能是字符串（html/json），也可能是 Buffer（docx）
    res.type(out.mime).send(out.buffer ?? out.body);
  });

  // 两份报告的逐行对比
  app.get('/api/reports/diff', (req, res) => {
    const cfg = getConfig();
    const a = String(req.query.from ?? '');
    const b = String(req.query.to ?? '');
    const left = a ? readReport(cfg, a) : null;
    const right = b ? readReport(cfg, b) : null;
    if (left === null || right === null) return res.status(404).json({ error: 'one of the reports was not found' });
    const lines = diffLines(left, right);
    const stats = diffStats(lines);
    res.json({ from: a, to: b, stats, hunks: diffHunks(lines, 4) });
  });

  app.get('/api/reports/:name', (req, res) => {
    const md = readReport(getConfig(), req.params.name);
    if (md === null) return res.status(404).json({ error: 'not found' });
    res.type('text/markdown; charset=utf-8').send(md);
  });

  // ── JSON 错误兜底 / JSON error fallback ─────────────────────────
  // 路由里抛异常时，Express 默认回一张 HTML 错误页 —— 前端拿它去 JSON.parse
  // 只会得到 "Unexpected token '<'"，非常难查。这里统一改成 JSON。
  app.use((err, req, res, _next) => {
    log?.error('API 异常 / route error — ' + req.method + ' ' + req.originalUrl + ': ' + (err.stack ?? err.message));
    if (res.headersSent) return;
    res.status(err.status ?? 500).json({ error: err.message ?? 'internal error', route: req.originalUrl });
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
