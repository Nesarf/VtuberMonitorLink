// server.js — 本机 HTTP 服务 + REST API（仅监听 127.0.0.1）
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, resolveDir } from './config.js';
import { CATEGORIES, effectiveSources, sanitizeCustomSource } from './sources.js';
import { FETCH_KINDS } from './fetchers/index.js';
import { detectBrowsers } from './fetchers/browser.js';
import { makeProxyAgent } from './net.js';
import { runOnce, runState, selectSources } from './runner.js';
import {
  diffIntel,
  exportReport,
  htmlShell,
  latestIntel,
  listReports,
  loadFlags,
  markdownSource,
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
import { clear as egressClear, decision as egressDecision, snapshot as egressSnapshot } from './egress.js';
import { detectFromItems, marksFor, monthGrid, sanitizeEntry, upcoming } from './calendar.js';
import { adviceDir, diagnoseSource, listAdvice, readAdvice } from './diagnose.js';
import { corpusSample, loadVocab, saveVocab, search, tagCloud } from './search.js';
import { chatRequest } from './llm.js';
import { netFetch } from './net.js';
import { applyFeatures, extractFeatures, featureStats, loadFeatureCache } from './features.js';
import { buildDocx, buildXlsx, itemsToMarkdown, itemsToSheet } from './office.js';
import { probeTor } from './socks.js';
import { entityDetail, entityStats } from './entities.js';
import {
  annotateItems,
  feedByPerson,
  personExport,
  sanitizePerson,
  suggestFromPeople,
} from './people.js';
import { dedupe, loadWeightHistory, makeWeighter, runClustering } from './cluster.js';
import {
  applyVisionTags,
  loadVisionCache,
  tagItems,
  visionReady,
  visionStats,
} from './vision.js';
import {
  archivePath,
  archiveRun,
  healthSeries,
  keywordSeries,
  openArchive,
  peopleSeries,
  queryItems,
  series,
  stats as archiveStats,
} from './archive.js';
import {
  appendAudit,
  buildBundle,
  bundleFilename,
  contentDisposition,
  getAccounts,
  guardPost,
  postBilibiliDynamic,
  readAudit as readShareAudit,
  readinessReport,
  renderBundle,
  targetById,
  toPlainText,
} from './share.js';
import { checkLive, liveUids, searchRoster } from './live.js';
import { MAX_LEN, MIN_INTERVAL_MS, readAudit, sendDanmaku } from './danmaku.js';
import { spawn } from 'node:child_process';
import {
  NOTIFY_KINDS,
  flushQueue as flushNotifyQueue,
  inQuietHours,
  maskTarget,
  newTarget,
  notify,
  readQueue,
  sanitizeTarget as sanitizeNotifyTarget,
} from './notify.js';
import * as proxyctl from './proxyctl.js';
import { getThumbnail, listThumbs, readThumb } from './thumbs.js';
import * as scheduler from './scheduler.js';

export function createApp({ getConfig, setConfig, log, onConfigChanged }) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  /**
   * 局部更新配置并落盘。
   *
   * 这里踩了两次坑，值得写下来：
   *  ① 最初我写的是 `saveConfig(...)` —— **这个函数根本不存在**；
   *  ② 改成 `setConfig` 后仍然 `ReferenceError: setConfig is not defined`，
   *     因为 getConfig/setConfig/onConfigChanged 是 **createApp 的参数**，
   *     只有工厂内部的代码看得见，模块顶层的辅助函数看不见。
   * `node --check` 对这两类都无感（语法没错），只有真的打到接口才会暴露 ——
   * 所以巡检里必须有一条「新增纪念日」这种真正写配置的断言。
   */
  const patchConfig = (cfg, patch) => {
    const next = setConfig({ ...cfg, ...patch });
    onConfigChanged?.(next);
    return next;
  };

  // ── 请求日志 / request log ───────────────────────────────────────
  // 排查「UI 到底触发了什么」时，没有这个只能靠猜。/api/state 是 3 秒一次的轮询，
  // 记下来会把日志淹掉，所以单独排除；写操作额外标出来，方便一眼看到。
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/state') return next();
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      const line = (write ? '写入 ' : '') + req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + ' (' + ms + 'ms)';
      if (res.statusCode >= 400) log?.warn('请求 / request: ' + line);
      else log?.info('请求 / request: ' + line);
    });
    next();
  });

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
    // 归属到「人」：本地匹配，命中带证据（界面要能解释凭什么算他的）
    const peopleCfg = cfg.people ?? [];
    const annotated = annotateItems(items, peopleCfg);
    items = annotated.items;
    // 图片标签（来自缓存，读时合并）—— 有的话会顺带进 keywords，因此也能被检索命中
    let visionTagged = 0;
    try {
      if (cfg.vision?.enabled) {
        const vision = applyVisionTags(items, loadVisionCache(cfg));
        items = vision.items;
        visionTagged = items.filter((i) => (i.imageTags ?? []).length).length;
      }
    } catch {
      // 打标缓存坏了不该影响情报流
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
      // 按人关注的命中统计：界面用它显示「本次有几条命中关注对象」
      peopleMatched: annotated.matched,
      followed: (items ?? []).filter((i) => (i.people ?? []).length > 0).length,
      visionTagged,
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
      // 静默状态与积压队列：界面要能一眼看到「现在是不是静默中、积了几条」
      quiet: inQuietHours(cfg, { level: 'info' }),
      queue: readQueue(cfg),
      dedupeMinutes: cfg.notify?.dedupeMinutes ?? 0,
    });
  });

  // 手动补发积压的通知（force 会无视静默时段）
  app.post('/api/notify/flush', async (req, res) => {
    const cfg = getConfig();
    const r = await flushNotifyQueue(cfg, log, { force: req.body?.force === true });
    res.json({ ok: true, ...r, queue: readQueue(cfg) });
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
    const format = ['xlsx', 'docx', 'md', 'html'].includes(String(req.query.format)) ? String(req.query.format) : 'xlsx';
    const data = latestIntel(cfg, Number(req.query.limit ?? 500));
    const items = applyFeatures(data.items ?? [], loadFeatureCache(cfg));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'html') {
      res.setHeader('content-disposition', `attachment; filename="vml-intel-${stamp}.html"`);
      return res.type('text/html; charset=utf-8').send(htmlShell(`情报集 ${stamp}`, itemsToMarkdown(items, { title: '情报集' })));
    }
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

  // ── 开播监测 / live status ───────────────────────────────────────
  // 功能来源：dd-center/bilibili-dd-monitor（MIT）。上游用的 vtbs.moe /v1/live 已 404，
  // 这里改用实测可用的 B 站批量开播接口，并区分「直播中」与「轮播」。
  app.get('/api/live', async (req, res) => {
    const cfg = getConfig();
    const sources = effectiveSources(cfg).filter((s) => s.enabled);
    if (req.query.fresh === '1') {
      return res.json(await checkLive(cfg, sources, log));
    }
    const wanted = liveUids(cfg, sources);
    const r = await checkLive(cfg, sources, log);
    res.json({ ...r, monitored: wanted.length, uids: wanted.map((w) => w.uid) });
  });

  app.get('/api/live/roster', async (req, res) => {
    res.json(await searchRoster(getConfig(), req.query.q));
  });

  // ── 登录账号与发弹幕 / accounts & danmaku ────────────────────────
  // 账号发现只读；发送会用使用者本人身份公开发言，所以设计上层层设卡（见 danmaku.js）。
  //
  // **必须走 60 秒缓存**：listAccounts 是阻塞调用（同步 SQLite + execFileSync 解 DPAPI），
  // 一次要 3~4 秒，而这期间整个 Node 事件循环是停的 —— 直播页一挂载就会请求这个接口，
  // 于是「打开直播页 → 整个控制台卡住 4 秒、别的页面全停在『加载中』」。
  // 这不是「慢」，是一个接口把服务冻住了（和 BUGS #37 同一类）。
  // 对外发声前（发弹幕/发帖）仍然强制现读，见 danmaku.js 与 /api/share/post。
  app.get('/api/accounts', async (req, res) => {
    const cfg = getConfig();
    const { accounts, cached, error } = await getAccounts(cfg, { force: req.query.force === '1' });
    res.json({
      accounts,
      cached: !!cached,
      ...(error ? { error } : {}),
      // 再强调一次：这里只回传身份信息与能力，绝不回传任何 cookie 值
      canSendAny: accounts.some((a) => a.canSend),
      limits: { maxLen: MAX_LEN, minIntervalMs: MIN_INTERVAL_MS },
    });
  });

  app.post('/api/danmaku', async (req, res) => {
    const cfg = getConfig();
    const r = await sendDanmaku(cfg, log, req.body ?? {});
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.get('/api/danmaku/audit', (_req, res) => res.json({ entries: readAudit(getConfig(), 50) }));

  // ── 客户端错误上报 / client error beacon ─────────────────────────
  // 页面抛错时整棵树会被卸掉、页面变白，而服务端原本一无所知。
  // 前端在 index.html 里就挂了监听，这里只负责落盘 + 进服务端日志。
  app.post('/api/client-log', (req, res) => {
    const cfg = getConfig();
    const b = req.body ?? {};
    const entry = {
      at: b.at ?? new Date().toISOString(),
      kind: String(b.kind ?? 'unknown').slice(0, 24),
      message: String(b.message ?? '').slice(0, 800),
      source: b.source ? String(b.source).slice(0, 200) : null,
      line: b.line ?? null,
      col: b.col ?? null,
      stack: b.stack ? String(b.stack).slice(0, 1200) : null,
      href: b.href ? String(b.href).slice(0, 200) : null,
      ua: b.ua ? String(b.ua).slice(0, 160) : null,
    };
    try {
      const f = path.join(resolveDir(cfg, 'logsDir'), 'client-errors.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* 落盘失败也要继续 */
    }
    log?.warn(`前端错误 / client ${entry.kind}: ${entry.message}${entry.source ? ` @ ${entry.source}:${entry.line}` : ''}`);
    res.json({ ok: true });
  });

  // 读取已记录的前端错误（给排查用）
  app.get('/api/client-log', (_req, res) => {
    const cfg = getConfig();
    const f = path.join(resolveDir(cfg, 'logsDir'), 'client-errors.jsonl');
    let entries = [];
    try {
      if (fs.existsSync(f)) {
        entries = fs
          .readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .slice(-100)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .reverse();
      }
    } catch {
      /* ignore */
    }
    res.json({ count: entries.length, entries });
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
    // 用 markdown 源做对比：报告主文件是 html/adoc/json 都能对齐
    const left = a ? markdownSource(cfg, a) : null;
    const right = b ? markdownSource(cfg, b) : null;
    if (left === null || right === null) return res.status(404).json({ error: 'one of the reports was not found' });
    const lines = diffLines(left, right);
    const stats = diffStats(lines);
    res.json({ from: a, to: b, stats, hunks: diffHunks(lines, 4) });
  });

  // 报告主文件可能是 .html / .adoc / .md / .json，按扩展名给正确的 MIME，
  // 前端就能直接把 .html 丢进 iframe 预览（VSCode 里也是同一种文件）。
  const REPORT_MIME = {
    html: 'text/html; charset=utf-8',
    json: 'application/json; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    adoc: 'text/plain; charset=utf-8',
  };
  app.get('/api/reports/:name', (req, res) => {
    const name = String(req.params.name ?? '');
    const body = readReport(getConfig(), name);
    if (body === null) return res.status(404).json({ error: 'not found' });
    const ext = path.extname(name).slice(1).toLowerCase();
    res.type(REPORT_MIME[ext] ?? 'text/plain; charset=utf-8').send(body);
  });

  // ── 自动出口 / automatic per-site egress ──────────────────────────
  // 每个站点按「等效延迟 = avg × (1 + 丢包 × 4)」自动挑直连或代理，
  // 并带粘滞（优势不足 20% 就不换，避免抖动）。这里有判定 + 原因 + 得分。
  app.get('/api/egress', (_req, res) => {
    const cfg = getConfig();
    const snap = egressSnapshot(cfg);
    const byKey = {};
    for (const d of snap.decisions) byKey[d.key] = d;
    res.json({ ...snap, byKey });
  });

  app.post('/api/egress/decide', async (req, res) => {
    const cfg = getConfig();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const sources = effectiveSources(cfg).filter((s) => !ids.length || ids.includes(s.id));
    const results = [];
    for (const s of sources) {
      try {
        const p = await probeUrl(s.url, { cfg, samples: Number(req.body?.samples ?? 3) });
        updateCache(cfg, [{ id: s.id, label: s.name?.zh ?? s.id, sourceId: s.id, ...p }]);
        const d = egressDecision(cfg, s);
        results.push({ id: s.id, mode: d?.mode ?? null, reason: d?.reason ?? '', confidence: d?.confidence ?? 'none' });
      } catch (e) {
        results.push({ id: s.id, mode: null, reason: e.message, confidence: 'none' });
      }
    }
    res.json({ ok: true, results, ...egressSnapshot(cfg) });
  });

  app.post('/api/egress/clear', (_req, res) => {
    const cfg = getConfig();
    egressClear(cfg);
    res.json({ ok: true });
  });

  // ── 图片理解打标 / image tagging ─────────────────────────────────
  // 核心在 vision.js（按图 URL 缓存、解析宽容、并发受限），
  // 自检 tools/vision-test.mjs 用本地假视觉模型做端到端验证（不花 Key、不发图）。
  app.get('/api/vision/stats', (_req, res) => {
    const cfg = getConfig();
    res.json({ ok: true, ...visionStats(cfg), ready: visionReady(cfg) });
  });

  // 给最近一次情报里的配图打标（未启用时明确拒绝，不会偷偷把图发出去）
  app.post('/api/vision/tag', async (req, res) => {
    const cfg = getConfig();
    const ready = visionReady(cfg);
    if (!ready.ok) return res.status(400).json({ ok: false, error: ready.reason });
    const data = latestIntel(cfg, Number(req.body?.scan ?? 300));
    const r = await tagItems(cfg, {
      items: data.items ?? [],
      limit: Number(req.body?.limit ?? cfg.vision?.runLimit ?? 40),
      force: req.body?.force === true,
      log,
    });
    res.json({ ...r, ...visionStats(cfg) });
  });

  // ── 一键分享 / one-click sharing ─────────────────────────────────
  // 目标登记表在 share.js：每个目标如实声明是否需要登录、当前可不可用；
  // 自检 tools/share-test.mjs（零外部引用的单文件 HTML / 登录需求 / 发声闸门 / 审计）。
  app.get('/api/share/targets', async (_req, res) => {
    const cfg = getConfig();
    // 用缓存：读登录态是阻塞的，每次开页面都现读会把服务卡住（原因见 share.js）
    const { accounts, cached, error } = await getAccounts(cfg);
    res.json({
      ok: true,
      targets: readinessReport(accounts, cfg.share?.verifiedTargets ?? []),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, canSend: a.canSend })),
      accountsCached: !!cached,
      accountsError: error ?? null,
    });
  });

  /** 按范围收集条目：latest / day / person */
  function collectScope(cfg, scope = {}) {
    const kind = scope.kind ?? 'latest';
    if (kind === 'person') {
      const items = latestIntel(cfg, Number(scope.limit ?? 500)).items ?? [];
      const picked = annotateItems(items, cfg.people ?? []).items.filter((i) => (i.people ?? []).includes(scope.id));
      const person = (cfg.people ?? []).find((p) => p.id === scope.id);
      return {
        items: picked,
        title: `${person?.name ?? scope.id} 的情报`,
        subtitle: person?.agency ?? '',
        contentDate: new Date().toISOString().slice(0, 10),
      };
    }
    if (kind === 'day') {
      const day = String(scope.id ?? '').slice(0, 10);
      let db = null;
      try {
        db = openArchive(cfg);
        const rows = queryItems(db, { day, limit: 500 });
        // 归档里有这一天就用它 —— 即使原始情报已被后面的运行覆盖
        if (rows.length) return { items: rows, title: `Vtuber 情报 ${day}`, subtitle: '', contentDate: day };
      } catch {
        /* 归档不可用就退回原始情报 */
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
      const data = latestIntel(cfg, 500);
      return { items: data.items ?? [], title: `Vtuber 情报 ${day}`, subtitle: '', contentDate: day };
    }
    const data = latestIntel(cfg, Number(scope.limit ?? 500));
    return { items: data.items ?? [], title: 'Vtuber 情报分享', subtitle: '', contentDate: data.date ?? null };
  }

  // 生成分享包（返回文件下载；format=text 时返回纯文本供复制）
  app.post('/api/share/bundle', (req, res) => {
    const cfg = getConfig();
    const format = String(req.body?.format ?? cfg.share?.defaultFormat ?? 'html');
    const scope = collectScope(cfg, req.body?.scope ?? {});
    const bundle = buildBundle({
      ...scope,
      scopeKind: req.body?.scope?.kind ?? 'latest',
      note: String(req.body?.note ?? '').slice(0, 300),
    });
    const out = renderBundle(bundle, format);
    appendAudit(cfg, { action: 'bundle', scope: bundle.scope, format, items: bundle.items.length });
    if (format === 'text') return res.json({ ok: true, text: out.body, items: bundle.items.length, title: bundle.title });
    // 文件名可能含中文 → 必须走 RFC 5987 编码，否则 HTTP 头会抛 ERR_INVALID_CHAR
    res.setHeader('content-disposition', contentDisposition(bundleFilename(bundle, out.ext)));
    res.type(out.mime).send(out.body);
  });

  app.get('/api/share/audit', (_req, res) => res.json({ ok: true, entries: readShareAudit(getConfig(), 50) }));

  // 对外发声：确认 + 可做性 + 留痕，三道闸门缺一不可（见 share.js guardPost）
  app.post('/api/share/post', async (req, res) => {
    const cfg = getConfig();
    const target = String(req.body?.target ?? '');
    // 对外发声前**强制重新读**登录态：拿过期的判断去发帖等于用旧钥匙开新锁
    const { accounts } = await getAccounts(cfg, { force: true });
    const verified = cfg.share?.verifiedTargets ?? [];
    // verify:true 表示「这次就是为了验证这个目标」—— 成功后把它记进已验证列表
    const isVerifyAttempt = req.body?.verify === true && targetById(target)?.status === 'needs-verification';
    const allowed = isVerifyAttempt ? [...verified, target] : verified;

    let body = String(req.body?.text ?? '').trim();
    if (!body && req.body?.scope) {
      const scope = collectScope(cfg, req.body.scope);
      body = toPlainText(buildBundle({ ...scope, scopeKind: req.body.scope.kind ?? 'latest' }));
    }
    const g = guardPost(cfg, { target, accounts, verified: allowed, text: body, confirm: req.body?.confirm === true });
    if (!g.ok) {
      appendAudit(cfg, { action: 'post-refused', target, error: g.error, status: g.status ?? null });
      return res.status(400).json({ ok: false, error: g.error, status: g.status ?? null });
    }

    let result = { ok: false, error: '尚未实现该目标' };
    if (target === 'bilibili-dynamic') {
      result = await postBilibiliDynamic(cfg, { accountId: req.body?.accountId, text: g.body, log });
    }
    appendAudit(cfg, {
      action: 'post',
      target,
      ok: !!result.ok,
      error: result.error ?? null,
      chars: g.body.length,
      account: result.account ?? null,
      verifyAttempt: isVerifyAttempt,
    });
    if (result.ok && isVerifyAttempt) {
      patchConfig(cfg, { share: { ...(cfg.share ?? {}), verifiedTargets: [...new Set([...verified, target])] } });
    }
    res.json({ ok: !!result.ok, error: result.error ?? null, account: result.account ?? null, verified: result.ok && isVerifyAttempt ? true : undefined });
  });

  // ── SQLite 增量归档与图表数据 / incremental archive & charts ─────
  // 归档层在 archive.js，自检 tools/archive-test.mjs（幂等 / 参数化 / 迁移 / 性能）。
  // 每次运行都会增量写入；这里只负责查询与手动补录。
  app.get('/api/archive/stats', (_req, res) => {
    const cfg = getConfig();
    let db = null;
    try {
      db = openArchive(cfg);
      res.json({ ok: true, ...archiveStats(db), file: path.basename(archivePath(cfg)) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  });

  app.get('/api/archive/series', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30)));
    let db = null;
    try {
      db = openArchive(cfg);
      res.json({
        ok: true,
        daily: series(db, { days }),
        bySource: series(db, { days, groupBy: 'source' }),
        people: peopleSeries(db, { days }),
        keywords: keywordSeries(db, { days, limit: Number(req.query.keywords ?? 12) }),
        health: healthSeries(db, { days }),
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  });

  app.get('/api/archive/items', (req, res) => {
    const cfg = getConfig();
    let db = null;
    try {
      db = openArchive(cfg);
      const items = queryItems(db, {
        day: req.query.day ?? null,
        sourceId: req.query.source ?? null,
        personId: req.query.person ?? null,
        q: req.query.q ?? null,
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ ok: true, count: items.length, items });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  });

  // 把最近一次情报补录进归档（升级后补历史、或归档被删掉时重建）
  app.post('/api/archive/ingest', (req, res) => {
    const cfg = getConfig();
    const limit = Number(req.body?.limit ?? 500);
    const data = latestIntel(cfg, limit);
    const r = archiveRun(cfg, { date: data.date ?? new Date().toISOString().slice(0, 10), items: data.items ?? [] });
    res.json({ ok: r.ok, ...r });
  });

  // ── 多源同事件合并 / 相似度去重 / 来源权重 ───────────────────────
  // 算法与自检在 cluster.js + tools/cluster-test.mjs：IDF 加权 Dice + 单链接并查集 +
  // 「必须共享罕见词」闸门 + 时间窗；来源权重从「谁先报」的历史里学。
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
        items: c.items.map((i) => ({ id: i.id, title: i.title, sourceId: i.sourceId, url: i.url, publishedAt: i.publishedAt ?? i.at ?? null })),
      })),
    });
  });

  // 拿一段条目试一下合并效果（不动历史、不落盘）—— 方便调阈值，也让这条链路可端到端验证
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

  // 只做去重（保持信息流顺序，把重复的丢掉）
  app.get('/api/events/dedupe', (req, res) => {
    const cfg = getConfig();
    const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
    const weigh = makeWeighter(cfg, loadWeightHistory(cfg));
    const r = dedupe(items, { weight: weigh });
    res.json({ ok: true, kept: r.kept.length, dropped: r.dropped.length, removed: r.dropped, items: r.kept });
  });

  // ── 按「人」关注 / follow people ─────────────────────────────────
  // 匹配全在 people.js 里做（本地字符串匹配，不联网不用 LLM），并有独立自检
  // tools/people-test.mjs：中日文子串 + 拉丁词边界，避免假阴性/假阳性。
  app.get('/api/people', (req, res) => {
    const cfg = getConfig();
    const people = cfg.people ?? [];
    const limit = Number(req.query.limit ?? 300);
    const items = latestIntel(cfg, limit).items ?? [];
    const { matched } = annotateItems(items, people);
    const feed = feedByPerson(items, people);
    const stats = Object.fromEntries(
      feed.map((f) => [
        f.person.id,
        { count: f.count, lastAt: f.lastAt, kinds: f.kinds },
      ])
    );
    res.json({
      ok: true,
      people: people.map((p) => ({ ...p, stats: stats[p.id] ?? { count: 0, lastAt: null, kinds: {} } })),
      scanned: items.length,
      matched,
      options: cfg.peopleOptions ?? {},
    });
  });

  app.post('/api/people', (req, res) => {
    const cfg = getConfig();
    const { person, error } = sanitizePerson(req.body ?? {}, (cfg.people ?? []).length);
    if (error) return res.status(400).json({ error });
    const list = [...(cfg.people ?? [])];
    if (list.some((p) => p.id === person.id)) return res.status(409).json({ error: `person exists: ${person.id}` });
    list.push(person);
    patchConfig(cfg, { people: list });
    res.json({ ok: true, person, people: list });
  });

  app.patch('/api/people/:id', (req, res) => {
    const cfg = getConfig();
    const list = [...(cfg.people ?? [])];
    const i = list.findIndex((p) => p.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'person not found' });
    const { person, error } = sanitizePerson({ ...list[i], ...req.body, id: list[i].id }, i);
    if (error) return res.status(400).json({ error });
    list[i] = person;
    patchConfig(cfg, { people: list });
    res.json({ ok: true, person, people: list });
  });

  app.delete('/api/people/:id', (req, res) => {
    const cfg = getConfig();
    const list = (cfg.people ?? []).filter((p) => p.id !== req.params.id);
    patchConfig(cfg, { people: list });
    res.json({ ok: true, people: list });
  });

  // 按人聚合的信息流（谁刚有动静排在前面）
  app.get('/api/people/feed', (req, res) => {
    const cfg = getConfig();
    const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
    const feed = feedByPerson(items, cfg.people ?? [], { id: req.query.id ?? null, limit: Number(req.query.per ?? 50) });
    res.json({ ok: true, feed });
  });

  // 从已抽取的实体里推荐关注对象（本地统计，不需要 LLM 再跑一遍）
  app.get('/api/people/suggest', (req, res) => {
    const cfg = getConfig();
    const stats = entityStats(cfg, loadFlags(cfg));
    const suggestions = suggestFromPeople(stats.top ?? [], cfg.people ?? [], {
      minCount: Number(req.query.min ?? 2),
    });
    res.json({ ok: true, suggestions, scanned: stats.total ?? 0 });
  });

  // 单人的情报导出（JSON / Markdown）—— 顺手也能喂给别的工具或直接发给朋友
  app.get('/api/people/:id/export', (req, res) => {
    const cfg = getConfig();
    const person = (cfg.people ?? []).find((p) => p.id === req.params.id);
    if (!person) return res.status(404).json({ error: 'person not found' });
    const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
    const bucket = feedByPerson(items, cfg.people, { id: person.id })[0];
    const format = String(req.query.format ?? 'json') === 'md' ? 'md' : 'json';
    const out = personExport(person, bucket?.items ?? [], format);
    res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
    res.type(out.mime).send(out.body);
  });

  // ── 纪念日 / 生日 / 3D披露 倒计时 ────────────────────────────────
  // 时间算术（闰日顺延、时区、夏令时）全在 calendar.js 里，并有独立自检：
  // tools/calendar-test.mjs（26 项，含 2/29 与跨时区跨日）。
  app.get('/api/calendar', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(1, Math.min(730, Number(req.query.days ?? cfg?.calendar?.reportDays ?? 60)));
    const view = upcoming(cfg, { days });
    const month = Number(req.query.month ?? 0);
    const year = Number(req.query.year ?? 0);
    const grid = month
      ? monthGrid(year || Number(view.today.slice(0, 4)), month, Number(req.query.weekStart ?? 1), {
          marks: marksFor(cfg, year || Number(view.today.slice(0, 4)), month),
        })
      : null;
    res.json({ ...view, entries: cfg?.calendar?.entries ?? [], grid });
  });

  app.post('/api/calendar/entry', (req, res) => {
    const cfg = getConfig();
    const { entry, error } = sanitizeEntry(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const list = [...(cfg.calendar?.entries ?? [])];
    if (list.some((e) => e.id === entry.id)) return res.status(409).json({ error: `entry exists: ${entry.id}` });
    list.push(entry);
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entry, entries: list });
  });

  app.patch('/api/calendar/entry/:id', (req, res) => {
    const cfg = getConfig();
    const list = [...(cfg.calendar?.entries ?? [])];
    const i = list.findIndex((e) => e.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'entry not found' });
    const { entry, error } = sanitizeEntry({ ...list[i], ...req.body, id: list[i].id });
    if (error) return res.status(400).json({ error });
    list[i] = entry;
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entry, entries: list });
  });

  app.delete('/api/calendar/entry/:id', (req, res) => {
    const cfg = getConfig();
    const list = (cfg.calendar?.entries ?? []).filter((e) => e.id !== req.params.id);
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, entries: list });
  });

  // 一次把多个线索加进去（界面里勾选后提交）
  app.post('/api/calendar/import', (req, res) => {
    const cfg = getConfig();
    const incoming = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const list = [...(cfg.calendar?.entries ?? [])];
    const added = [];
    const skipped = [];
    for (const raw of incoming) {
      const { entry, error } = sanitizeEntry(raw);
      if (error) {
        skipped.push({ input: raw, error });
        continue;
      }
      // 同一天同一类型视为重复（线索常有多个来源指向同一件事）
      if (list.some((e) => e.date === entry.date && e.kind === entry.kind && e.name === entry.name)) {
        skipped.push({ input: raw, error: 'duplicate' });
        continue;
      }
      list.push(entry);
      added.push(entry);
    }
    patchConfig(cfg, { calendar: { ...cfg.calendar, entries: list } });
    res.json({ ok: true, added: added.length, skipped, entries: list });
  });

  // 从最近一次情报里找线索（**本地正则，不联网、不用 LLM**）
  app.get('/api/calendar/detect', (req, res) => {
    const cfg = getConfig();
    const data = latestIntel(cfg, Number(req.query.limit ?? 300));
    const found = detectFromItems(data.items ?? []);
    const existing = new Set((cfg.calendar?.entries ?? []).map((e) => `${e.kind}|${e.date}`));
    res.json({
      ok: true,
      scanned: (data.items ?? []).length,
      suggestions: found.map((f) => ({ ...f, alreadyAdded: existing.has(`${f.kind}|${f.date}`) })),
    });
  });

  // 探测成功后立刻重算判定，界面不用等下一次运行

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
