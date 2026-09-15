// server.js — local HTTP service + REST API (listens on 127.0.0.1 only)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, resolveDir } from './config.js';
import { CATEGORIES, effectiveSources, mergeSourceOverride, sanitizeCustomSource } from './sources.js';
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
import { probeTor, torLaunchPlan } from './socks.js';
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
  recentSeries,
  series,
  stats as archiveStats,
} from './archive.js';
import { detectSilence, silenceSummary } from './silence.js';
import { groupView } from './groups.js';
import { budgetStatus, costSummary, loadUsage, summarizeUsage } from './cost.js';
import { loadObservationState } from './observe.js';
import { ensureIndex, indexSummary, loadCachedIndex, searchIndex, toPerson } from './vdb.js';
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
   * Patch the config partially and write it to disk.
   *
   * Two traps here are worth writing down:
   *  1) the first version called `saveConfig(...)` — **that function simply does not exist**;
   *  2) after switching to `setConfig` it still threw `ReferenceError: setConfig is not defined`,
   *     because getConfig/setConfig/onConfigChanged are **parameters of createApp** and only code inside
   *     the factory can see them, not a helper function at module top level.
   * `node --check` is blind to both (the syntax is fine); only actually hitting the endpoint exposes them —
   * which is why the traversal needs an assertion that really writes config, like "add an anniversary".
   */
  const patchConfig = (cfg, patch) => {
    const next = setConfig({ ...cfg, ...patch });
    onConfigChanged?.(next);
    return next;
  };

  // ── request log ──────────────────────────────────────────────────
  // Without this, working out "what the UI actually triggered" is pure guesswork. /api/state is polled
  // once every 3 seconds and logging it would drown the log, so it is left out on purpose; writes are
  // marked out extra clearly so they can be spotted at a glance.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/state') return next();
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      const line = (write ? 'write ' : '') + req.method + ' ' + req.originalUrl + ' -> ' + res.statusCode + ' (' + ms + 'ms)';
      if (res.statusCode >= 400) log?.warn('request: ' + line);
      else log?.info('request: ' + line);
    });
    next();
  });

  // ── config ───────────────────────────────────────────────────────
  app.get('/api/config', (_req, res) => res.json(getConfig()));
  app.put('/api/config', (req, res) => {
    const next = setConfig(req.body ?? {});
    onConfigChanged?.(next);
    res.json(next);
  });

  // ── source catalog ───────────────────────────────────────────────
  app.get('/api/sources', (_req, res) => {
    const cfg = getConfig();
    // "last observed": when each source was last picked while observation mode is on.
    // Given nothing but a sampling ratio, the user cannot tell which sources have not been looked at, and
    // for how long — and that is exactly the evidence for judging whether coverage is sufficient.
    const obs = loadObservationState(cfg);
    const sources = effectiveSources(cfg).map((s) => ({
      ...s,
      lastObserved: obs.lastPicked?.[s.id] ?? null,
    }));
    res.json({
      categories: CATEGORIES,
      fetchKinds: FETCH_KINDS,
      sources,
      observation: {
        enabled: cfg?.observation?.enabled === true,
        rounds: obs.rounds ?? 0,
        ratio: cfg?.observation?.sampleRatio ?? null,
      },
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
    const { enabled, login, url, uid, proxy, note, region } = req.body ?? {};
    cfg.sources = cfg.sources ?? {};
    cfg.sources[id] = {
      ...(cfg.sources[id] ?? {}),
      ...(enabled === undefined ? {} : { enabled: !!enabled }),
      ...(login ? { login } : {}),
    };
    // overriding the handful of mutable fields of a built-in source (uid / url / egress / region) lands in
    // the custom source list.
    //
    // The merge keeps only the fields actually sent (see mergeSourceOverride): spreading all of them at once
    // writes `undefined` over a field the caller left out, and the sanitiser skips undefined values, so the
    // entry's old value for that field is lost rather than kept. The region box on the sources page is what
    // made that visible - editing a region wiped the url of the same override entry, silently.
    const customIdx = (cfg.customSources ?? []).findIndex((s) => s.id === id);
    if (url !== undefined || uid !== undefined || proxy !== undefined || note !== undefined || region !== undefined) {
      const base = customIdx >= 0 ? cfg.customSources[customIdx] : effectiveSources(cfg).find((s) => s.id === id);
      const merged = mergeSourceOverride(base, { url, uid, proxy, note, region });
      if (customIdx >= 0) cfg.customSources[customIdx] = merged;
      else cfg.customSources = [...(cfg.customSources ?? []), merged];
    }
    setConfig(cfg);
    res.json({ ok: true, sources: effectiveSources(cfg) });
  });

  // ── custom sources ───────────────────────────────────────────────
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

  // ── browser detection ────────────────────────────────────────────
  app.get('/api/browsers', (_req, res) => {
    res.json({ detected: detectBrowsers(), config: getConfig().browser });
  });

  // ── login availability ───────────────────────────────────────────
  // Only reports "which cookie names were read", and **never sends back any value**.
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

  // ── proxy detection ──────────────────────────────────────────────
  // Tries the common local proxy ports one by one and returns the addresses that actually get through
  // (no port is hard-coded as the one true answer)
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
        /* not a usable proxy, keep probing */
      }
    }
    res.json({ found, probed: ports.length });
  });

  // ── LLM providers ────────────────────────────────────────────────
  app.get('/api/llm/presets', (_req, res) => {
    const cfg = getConfig();
    const p = activeProvider(cfg);
    res.json({
      presets: PRESETS,
      providers: cfg.llm?.providers ?? [],
      activeId: cfg.llm?.activeId ?? '',
      active: { ...p, apiKey: p.apiKey ? '***' : '' }, // never send the plaintext Key back
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

  // ── watch targets ────────────────────────────────────────────────
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

  // ── run ──────────────────────────────────────────────────────────
  app.post('/api/run', async (req, res) => {
    const mode = ['merch', 'watch'].includes(req.body?.mode) ? req.body.mode : 'daily';
    if (runState.running) return res.status(409).json({ error: 'a run is already in progress' });
    // return immediately, the run keeps going in the background; the UI polls /api/state
    res.json({ ok: true, started: mode });
    runOnce({ cfg: getConfig(), mode }).catch((e) => log?.error(`run failed — ${e.message}`));
  });

  app.get('/api/state', (_req, res) =>
    res.json({ ...runState, nextFire: scheduler.nextFire(), schedule: getConfig().schedule })
  );

  // ── preflight ────────────────────────────────────────────────────
  app.post('/api/preflight', async (_req, res) => {
    res.json(await preflight(getConfig()));
  });

  // ── diagnostics for a user-added source ──────────────────────────
  // A healthy connection produces no file at all; only a clear anomaly generates a human-readable diagnostic markdown.
  // ── long operations must not run twice at once ───────────────────
  // Both halves of this were observed, not imagined. The nodes panel's probe button had no disabled
  // state, so someone who saw nothing happen clicked it four or five times and started four or five
  // real probes (the request log shows exactly that, twice). A full probe-all takes about three and a
  // half minutes; a second one is not a retry, it is the same work done twice on the same network at
  // the same time. A duplicate is answered with code 'busy' and the age of the run already going,
  // rather than being queued behind it, because the caller can decide what to do with that answer.
  const inFlight = new Map();
  const busyGuard = (name) => (req, res, next) => {
    const startedAt = inFlight.get(name);
    if (startedAt) {
      res.status(409).json({
        ok: false,
        code: 'busy',
        error: `${name} is already running (started ${Math.round((Date.now() - startedAt) / 1000)}s ago)`,
      });
      return;
    }
    inFlight.set(name, Date.now());
    res.on('close', () => inFlight.delete(name));
    next();
  };

  app.post('/api/sources/:id/diagnose', busyGuard('source diagnose'), async (req, res) => {
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

  // clicking it opens a readable web page (?raw=1 fetches the raw markdown)
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

  // ── reachability ─────────────────────────────────────────────────
  app.get('/api/probe', (_req, res) => {
    const cfg = getConfig();
    res.json({ cache: loadCache(cfg), ttlMinutes: cfg.ui?.probeTtlMinutes ?? 30 });
  });

  app.post('/api/probe', busyGuard('probe'), async (req, res) => {
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

    // When no egress is specified, probe over **the egress these sources actually use**: when a source is set to
    // Tor, "test the network" has to test Tor — otherwise judging whether a Tor-routed source should use Tor
    // from a direct-connection latency produces the wrong conclusion (this trap really existed: the UI had a
    // Tor option while the probe did not recognize it).
    let effectiveModes = modes;
    const perTarget = new Map();
    if (!Array.isArray(req.body?.modes) || !req.body.modes.length) {
      for (const t of targets) {
        const want = String(t.source?.proxy ?? ''); // that dropdown on the sources page: '' = auto / direct / proxy / tor
        const list = ['direct'];
        if (want === 'proxy' || want === 'tor') list.push(want);
        else {
          if (cfg.proxy?.enabled) list.push('proxy');
          // Tor is probed only when it **is genuinely going to be used**: otherwise "probe everything" makes
          // every source pay one extra round of about 2.5s (bringing up a Tor circuit is slow to begin with),
          // which is pure waste — and that time is better kept for the entries that really need Tor.
          const torInPlay =
            cfg?.observation?.enabled === true || cfg?.proxy?.mode === 'tor' || cfg?.proxy?.enableTor === true;
          if (torInPlay && cfg.proxy?.torSocks) list.push('tor');
        }
        perTarget.set(t.id, list);
      }
      effectiveModes = null; // decided target by target
    }

    const out = [];
    for (const t of targets) {
      try {
        const r = await probeUrl(t.url, { cfg, samples, modes: perTarget.get(t.id) ?? effectiveModes ?? modes });
        out.push({ id: t.id, label: t.label, sourceId: t.source?.id ?? null, ...r });
      } catch (e) {
        out.push({ id: t.id, label: t.label, url: t.url, error: e.message, at: new Date().toISOString() });
      }
    }
    updateCache(cfg, out);
    res.json({ ok: true, probed: out.length, samples, results: out });
  });

  // ── source health board ──────────────────────────────────────────
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

  // ── site thumbnails ──────────────────────────────────────────────
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
    // "this site has no usable thumbnail" is a normal result, not an error — do not answer 404, which would make the frontend treat it as a failed request
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

  // ── schedules ────────────────────────────────────────────────────
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

  // ── alert destinations ───────────────────────────────────────────
  app.get('/api/notify', (_req, res) => {
    const cfg = getConfig();
    res.json({
      kinds: NOTIFY_KINDS,
      desktop: cfg.notify?.desktop !== false,
      targets: (cfg.notify?.targets ?? []).map(maskTarget),
      count: (cfg.notify?.targets ?? []).length,
      // quiet state and the backlog queue: the UI must see at a glance "are we quiet right now, and how many are queued"
      quiet: inQuietHours(cfg, { level: 'info' }),
      queue: readQueue(cfg),
      dedupeMinutes: cfg.notify?.dedupeMinutes ?? 0,
    });
  });

  // manually flush the queued notifications (force ignores the quiet hours)
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

  // try one push with a "not yet saved target"
  app.post('/api/notify/test', async (req, res) => {
    const cfg = getConfig();
    const wanted = sanitizeNotifyTarget(req.body?.target ?? {}, 0);
    const saved = (cfg.notify?.targets ?? []).find((t) => t.id === wanted.id);
    // what the frontend sends back is a mask, so never send with ***
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

  // ── config import & export ───────────────────────────────────────
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

    // Merge the objects inside arrays by id (providers / targets / customSources / tasks …).
    // A plain "replace the whole array" would not work — the apiKey:'' of a redacted export would wipe the Key
    // already on this machine, and importing a config you just exported is the most common use case of all.
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
          // an empty string does not overwrite an existing non-empty value: importing a redacted export must not wipe secrets
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
        /* the model did not hand back clean JSON */
      }
      res.json({ ok: true, provider: { name: p.name, model: req2.body.model }, raw: content, ...(parsed ?? {}) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Office export / Word & Excel ─────────────────────────────────
  // OOXML hand-written in pure Node, with no dependency on Office / COM / Python — a portable exe cannot assume what the target machine has installed.
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

  // ── feature extraction (needs an LLM) ────────────────────────────
  app.get('/api/features', (_req, res) => res.json(featureStats(getConfig())));

  app.post('/api/features/extract', busyGuard('feature extraction'), async (req, res) => {
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

  // ── live status ──────────────────────────────────────────────────
  // Feature origin: dd-center/bilibili-dd-monitor (MIT). The vtbs.moe /v1/live that upstream uses is 404 now,
  // so the bilibili batch live endpoint that does work here is used instead, and "live" is kept apart from "carousel".
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

  // ── accounts & danmaku ───────────────────────────────────────────
  // Account discovery is read-only; sending speaks publicly as the user, so it is gated layer by layer (see danmaku.js).
  //
  // **The 60-second cache is mandatory**: listAccounts is a blocking call (synchronous SQLite + execFileSync to
  // unlock DPAPI) that takes 3~4 seconds, and during that time the whole Node event loop is stopped — the live
  // page requests this endpoint the moment it mounts, so "open the live page → the whole console freezes for 4
  // seconds and every other page sits at loading". This is not "slow", it is one endpoint freezing the service
  // (the same category as BUGS #37).
  // Before speaking in public (danmaku / posting) a fresh read is still forced, see danmaku.js and /api/share/post.
  app.get('/api/accounts', async (req, res) => {
    const cfg = getConfig();
    const { accounts, cached, error } = await getAccounts(cfg, { force: req.query.force === '1' });
    res.json({
      accounts,
      cached: !!cached,
      ...(error ? { error } : {}),
      // once more, for emphasis: only identity information and capabilities are returned here, never any cookie value
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

  // ── client error beacon ──────────────────────────────────────────
  // When a page throws, the whole tree gets unmounted and the page turns blank, while the server knew nothing about it.
  // The frontend already installs the listener in index.html; this side only persists to disk + writes the server log.
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
      /* keep going even when the write to disk fails */
    }
    log?.warn(`client ${entry.kind}: ${entry.message}${entry.source ? ` @ ${entry.source}:${entry.line}` : ''}`);
    res.json({ ok: true });
  });

  // read back the recorded frontend errors (handy for troubleshooting)
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

  // ── entities ─────────────────────────────────────────────────────
  // Aggregate the names pulled out by feature extraction into objects: which items, which games, which events they showed up in.
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

  // ── bulk source toggles ──────────────────────────────────────────
  // Clicking 30 sources one by one is tiring, and it is very easy to forget to turn them back off in tests (this feature exists because of exactly that trap)
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

  // ── reports ──────────────────────────────────────────────────────
  app.get('/api/reports', (_req, res) => res.json(listReports(getConfig())));

  // note: this has to be registered before /api/reports/:name, otherwise "search" is treated as a file name
  app.get('/api/reports/search', (req, res) => {
    res.json({ query: req.query.q ?? '', hits: searchReports(getConfig(), req.query.q) });
  });

  app.get('/api/reports/:name/export', (req, res) => {
    const format = ['json', 'docx'].includes(String(req.query.format)) ? String(req.query.format) : 'html';
    const out = exportReport(getConfig(), req.params.name, format);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.setHeader('content-disposition', `attachment; filename="${out.file}"`);
    // the body may be a string (html/json) or a Buffer (docx)
    res.type(out.mime).send(out.buffer ?? out.body);
  });

  // line-by-line comparison of two reports
  app.get('/api/reports/diff', (req, res) => {
    const cfg = getConfig();
    const a = String(req.query.from ?? '');
    const b = String(req.query.to ?? '');
    // compare via the markdown source: that lines up no matter whether the report's main file is html/adoc/json
    const left = a ? markdownSource(cfg, a) : null;
    const right = b ? markdownSource(cfg, b) : null;
    if (left === null || right === null) return res.status(404).json({ error: 'one of the reports was not found' });
    const lines = diffLines(left, right);
    const stats = diffStats(lines);
    res.json({ from: a, to: b, stats, hunks: diffHunks(lines, 4) });
  });

  // The report's main file may be .html / .adoc / .md / .json; give the right MIME by extension so the
  // frontend can drop a .html straight into an iframe preview (the same kind of file you would open in VSCode).
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

  // ── automatic per-site egress ────────────────────────────────────
  // Every site picks direct or proxy automatically by "equivalent latency = avg × (1 + loss × 4)",
  // with hysteresis (no switch unless the advantage is over 20%, to avoid flapping). The verdict + reason + scores live here.
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

  // ── image tagging ────────────────────────────────────────────────
  // The core lives in vision.js (cache keyed by image URL, tolerant parsing, bounded concurrency),
  // and tools/vision-test.mjs verifies the whole path end to end against a local fake vision model (no Key spent, no image sent out).
  app.get('/api/vision/stats', (_req, res) => {
    const cfg = getConfig();
    res.json({ ok: true, ...visionStats(cfg), ready: visionReady(cfg) });
  });

  // tag the images attached to the latest intel (with the feature off it refuses outright and never quietly sends an image out)
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

  // ── one-click sharing ────────────────────────────────────────────
  // The target registry lives in share.js: every target states honestly whether login is needed and whether it is usable right now;
  // self-tested by tools/share-test.mjs (single-file HTML with zero external references / login requirements / the post gates / the audit).
  app.get('/api/share/targets', async (_req, res) => {
    const cfg = getConfig();
    // use the cache: reading login state is blocking, and reading it fresh on every page open would freeze the service (the reason is in share.js)
    const { accounts, cached, error } = await getAccounts(cfg);
    res.json({
      ok: true,
      targets: readinessReport(accounts, cfg.share?.verifiedTargets ?? []),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, canSend: a.canSend })),
      accountsCached: !!cached,
      accountsError: error ?? null,
    });
  });

  /** collect items by scope: latest / day / person */
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
        // if the archive has this day, use it — even when the raw intel has since been overwritten by a later run
        if (rows.length) return { items: rows, title: `Vtuber 情报 ${day}`, subtitle: '', contentDate: day };
      } catch {
        /* the archive is unavailable, fall back to the raw intel */
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

  // build the share bundle (returns a file download; format=text returns plain text to copy)
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
    // the filename may contain Chinese → it must go through RFC 5987 encoding, otherwise the HTTP header throws ERR_INVALID_CHAR
    res.setHeader('content-disposition', contentDisposition(bundleFilename(bundle, out.ext)));
    res.type(out.mime).send(out.body);
  });

  app.get('/api/share/audit', (_req, res) => res.json({ ok: true, entries: readShareAudit(getConfig(), 50) }));

  // speaking in public: confirmation + capability + a trail, all three gates are required (see share.js guardPost)
  app.post('/api/share/post', async (req, res) => {
    const cfg = getConfig();
    const target = String(req.body?.target ?? '');
    // before speaking in public, **force a fresh read** of the login state: posting on a stale verdict is opening a new lock with an old key
    const { accounts } = await getAccounts(cfg, { force: true });
    const verified = cfg.share?.verifiedTargets ?? [];
    // verify:true means "this attempt exists precisely to verify this target" — on success it is recorded in the verified list
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

  // ── incremental archive & charts ─────────────────────────────────
  // The archive layer is in archive.js, self-tested by tools/archive-test.mjs (idempotency / parameterization / migration / performance).
  // Every run writes incrementally; this side only queries and backfills by hand.
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

  // ── README (shown inside the app) ────────────────────────────────
  // The UI has an "About" panel that renders these files and switches language instantly, so a
  // reader never has to leave the app (and never has to find the file on disk). Two fixed file
  // names, no user-controlled path: `lang=zh` → README.zh-CN.md, anything else → README.md.
  // In a packaged build they sit next to app/ (build-portable copies them); from a source checkout
  // they are at the repo root. Both candidates are tried, nothing else.
  app.get('/api/readme', (req, res) => {
    const lang = String(req.query.lang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    const files = { en: 'README.md', zh: 'README.zh-CN.md' };
    const roots = [APP_ROOT, path.join(APP_ROOT, '..'), process.cwd()];
    const available = [];
    let found = null;
    for (const [code, name] of Object.entries(files)) {
      for (const root of roots) {
        const p = path.join(root, name);
        if (!fs.existsSync(p)) continue;
        if (!available.includes(code)) available.push(code);
        if (code === lang && !found) found = { code, name, p };
        break;
      }
    }
    if (!found) {
      return res.status(404).json({ ok: false, error: 'README not found next to the app', available });
    }
    let markdown = '';
    try {
      markdown = fs.readFileSync(found.p, 'utf8');
    } catch (e) {
      return res.status(500).json({ ok: false, error: `could not read ${found.name}: ${e.message}`, available });
    }
    res.json({
      ok: true,
      lang: found.code,
      file: found.name,
      available,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      markdown,
    });
  });

  // ── VDB roster (multi-platform) ──────────────────────────────────
  // Data source github.com/dd-center/vdb (the upstream of vtbs.moe), licensed CC BY-NC-SA 4.0:
  //   · fetched at runtime only and cached in app/vdb/, **never shipped in the release package** (see the exclusion list in tools/make-zip.mjs)
  //   · both the UI and the docs have to carry the attribution
  // It supplies the dimension we were missing: **agency (group)** + multilingual names + per-platform accounts.
  app.get('/api/vdb/status', (_req, res) => {
    const cfg = getConfig();
    const index = loadCachedIndex(cfg);
    res.json({
      ok: true,
      cached: !!index,
      summary: indexSummary(index),
      count: index?.count ?? 0,
      groups: index?.groups ?? {},
      platforms: index?.platforms ?? {},
      generatedAt: index?.generatedAt ?? null,
      source: index?.source ?? 'dd-center/vdb',
      license: index?.license ?? 'CC BY-NC-SA 4.0',
    });
  });

  // explicit sync (this one really downloads, ~0.5MB, one request)
  app.post('/api/vdb/sync', async (_req, res) => {
    const cfg = getConfig();
    try {
      const index = await ensureIndex(cfg, { force: true, log });
      res.json({ ok: true, count: index.count, groups: Object.keys(index.groups ?? {}).length, summary: indexSummary(index) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // search: a name (any language/alias) and an account id or link shape on **any platform** all match
  app.get('/api/vdb/search', async (req, res) => {
    const cfg = getConfig();
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ ok: true, results: [], summary: indexSummary(loadCachedIndex(cfg)) });
    try {
      // fetch once automatically on first use: 0.5MB in a single request is friendlier than making the user guess that they "have to sync first"
      let index = loadCachedIndex(cfg);
      if (!index) index = await ensureIndex(cfg, { log });
      const results = searchIndex(index, q, { limit: Number(req.query.limit ?? 20), group: req.query.group || null });
      res.json({ ok: true, results, summary: indexSummary(index), license: index.license, source: index.source });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, results: [] });
    }
  });

  app.get('/api/vdb/groups', (_req, res) => {
    const index = loadCachedIndex(getConfig());
    res.json({ ok: true, groups: index?.groups ?? {}, summary: indexSummary(index) });
  });

  // import: turn the selected VDB records into "followed people" (name / aliases / agency / per-platform links)
  app.post('/api/vdb/import', (req, res) => {
    const cfg = getConfig();
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    if (!keys.length) return res.status(400).json({ ok: false, error: '没有选中任何条目 / nothing selected' });
    const index = loadCachedIndex(cfg);
    if (!index) return res.status(400).json({ ok: false, error: '还没有花名册，先点「同步花名册」/ sync the roster first' });
    const want = new Set(keys);
    const picked = (index.records ?? []).filter((r) => want.has(r.key));
    if (!picked.length) return res.status(400).json({ ok: false, error: '选中的条目在花名册里找不到' });
    const list = [...(cfg.people ?? [])];
    const existing = new Set(list.map((p) => p.id));
    const added = [];
    const skipped = [];
    for (const r of picked) {
      // go through the same sanitizing path as a manual add: VDB data has to pass validation too, and there is no back door for it
      const { person, error } = sanitizePerson(toPerson(r), list.length + added.length);
      if (error) {
        skipped.push({ key: r.key, reason: error });
        continue;
      }
      if (existing.has(person.id)) {
        skipped.push({ key: r.key, id: person.id, reason: '已经有同 id 的关注对象' });
        continue;
      }
      added.push(person);
      existing.add(person.id);
    }
    if (added.length) {
      patchConfig(cfg, { people: [...list, ...added] });
      log?.info?.(`imported ${added.length} people from VDB (${list.length} → ${list.length + added.length})`);
    }
    res.json({ ok: true, added: added.length, skipped, people: (getConfig().people ?? []).length });
  });

  // ── LLM usage & budget ───────────────────────────────────────────
  // Before this no usage was visible in the UI at all (the usage was being fetched but nobody aggregated it), yet this is where the money goes.
  // Report only **what is visible**: a call whose usage cannot be read is counted separately, never guessed at.
  app.get('/api/cost', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(1, Math.min(90, Number(req.query.days ?? 14)));
    try {
      const { rows, badLines } = loadUsage(cfg);
      const summary = summarizeUsage(rows, { days });
      const budget = budgetStatus(cfg, summary);
      res.json({ ok: true, ...summary, budget, badLines, summary: costSummary(summary, budget) });
    } catch (e) {
      res.json({ ok: false, error: e.message, today: { tokens: 0, calls: 0 }, total: { tokens: 0, calls: 0 }, days: [], models: [] });
    }
  });

  // ── group view ───────────────────────────────────────────────────
  // "how is this agency doing right now" — group the followed people by agency into one block: a daily heat map,
  // simultaneous appearances, shared silence, and each person's anomaly relative to their own rhythm. A flat item
  // stream simply cannot answer that question.
  app.get('/api/groups', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(7, Math.min(180, Number(req.query.days ?? 30)));
    let db = null;
    try {
      db = openArchive(cfg);
      const series = peopleSeries(db, { days });
      const view = groupView({
        byDay: series.byDay,
        people: cfg.people ?? [],
        days,
        rules: cfg.silence ?? {},
        now: new Date(),
      });
      res.json({ ok: true, ...view, hasAgency: view.groups.length > 0 });
    } catch (e) {
      res.json({ ok: false, error: e.message, groups: [], ungrouped: null, people: (cfg.people ?? []).length });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  });

  // ── silence ──────────────────────────────────────────────────────
  // "no activity" is intel too: this lays out "who stopped, for how long, and whether the whole agency stopped together".
  // The criteria are in silence.js (relative to each person's own rhythm); this side only fetches, computes and returns.
  app.get('/api/silence', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(7, Math.min(365, Number(req.query.days ?? cfg?.silence?.basisDays ?? 60)));
    let db = null;
    try {
      db = openArchive(cfg);
      const series = peopleSeries(db, { days });
      const result = detectSilence({
        byDay: series.byDay,
        people: cfg.people ?? [],
        rules: cfg.silence ?? {},
        now: new Date(),
      });
      res.json({
        ok: true,
        days,
        people: (cfg.people ?? []).length,
        ...result,
        summary: silenceSummary(result),
      });
    } catch (e) {
      res.json({ ok: false, error: e.message, people: (cfg.people ?? []).length, person: [], group: [], checked: 0, skippedNoBaseline: 0 });
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
    // The chart's time range. A range shorter than a week is answered from the items rather than from the
    // daily table, which cannot see below a day; the bucket width is stated per range so that every range
    // draws a readable number of points (thirty minutes in one-minute buckets, three days in six-hour
    // ones). `days` is still accepted: it is the same request for the day-based ranges, and it is what
    // this endpoint took before the selector offered the short ones.
    const RANGES = {
      '30m': { minutes: 30, bucket: 1 },
      '1h': { minutes: 60, bucket: 5 },
      '4h': { minutes: 240, bucket: 15 },
      '12h': { minutes: 720, bucket: 60 },
      '1d': { minutes: 1440, bucket: 120 },
      '3d': { minutes: 4320, bucket: 360 },
      '7d': { days: 7 },
      '30d': { days: 30 },
      '90d': { days: 90 },
      '180d': { days: 180 },
      '360d': { days: 360 },
    };
    const range = String(req.query.range ?? '').trim();
    const spec = RANGES[range] ?? null;
    const days = Math.max(1, Math.min(365, Number(spec?.days ?? req.query.days ?? 30)));
    let db = null;
    try {
      db = openArchive(cfg);
      if (spec && !spec.days) {
        const r = recentSeries(db, {
          minutes: spec.minutes,
          bucketMinutes: spec.bucket,
          keywordLimit: Number(req.query.keywords ?? 12),
        });
        res.json({
          ok: true,
          range,
          bucket: r.bucket,
          daily: { from: r.from, to: r.to, days: r.days },
          bySource: { from: r.from, to: r.to, days: [], totals: r.totals },
          people: { from: r.from, to: r.to, totals: r.peopleTotals, byDay: {} },
          keywords: { from: r.from, to: r.to, keywords: r.keywords },
          health: { from: r.from, to: r.to, sources: r.health, granularity: 'day' },
        });
        return;
      }
      res.json({
        ok: true,
        range: range || `${days}d`,
        bucket: { minutes: 1440 },
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

  // backfill the latest intel into the archive (to add history after an upgrade, or to rebuild when the archive was deleted)
  app.post('/api/archive/ingest', (req, res) => {
    const cfg = getConfig();
    const limit = Number(req.body?.limit ?? 500);
    const data = latestIntel(cfg, limit);
    const r = archiveRun(cfg, { date: data.date ?? new Date().toISOString().slice(0, 10), items: data.items ?? [] });
    res.json({ ok: r.ok, ...r });
  });

  // ── multi-source event merging / similarity dedupe / source weight ─
  // The algorithm and its self-test live in cluster.js + tools/cluster-test.mjs: IDF-weighted Dice + single-link
  // union-find + a "must share a rare term" gate + a time window; source weight is learned from the history of "who reported it first".
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

  // ── follow people ────────────────────────────────────────────────
  // All matching happens in people.js (local string matching, no network, no LLM) and has its own self-test
  // tools/people-test.mjs: CJK substring + Latin word boundaries, to avoid false negatives and false positives.
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

  // the information stream aggregated by person (whoever just showed activity comes first)
  app.get('/api/people/feed', (req, res) => {
    const cfg = getConfig();
    const items = latestIntel(cfg, Number(req.query.limit ?? 500)).items ?? [];
    const feed = feedByPerson(items, cfg.people ?? [], { id: req.query.id ?? null, limit: Number(req.query.per ?? 50) });
    res.json({ ok: true, feed });
  });

  // suggest followed people from the entities already extracted (local statistics, no need to run the LLM again)
  app.get('/api/people/suggest', (req, res) => {
    const cfg = getConfig();
    const stats = entityStats(cfg, loadFlags(cfg));
    const suggestions = suggestFromPeople(stats.top ?? [], cfg.people ?? [], {
      minCount: Number(req.query.min ?? 2),
    });
    res.json({ ok: true, suggestions, scanned: stats.total ?? 0 });
  });

  // per-person intel export (JSON / Markdown) — also handy for feeding another tool or sending straight to a friend
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

  // ── anniversary / birthday / 3D reveal countdown ─────────────────
  // All the date arithmetic (leap-day shift, time zones, daylight saving) lives in calendar.js with its own self-test:
  // tools/calendar-test.mjs (26 checks, covering 2/29 and cross-time-zone, cross-day cases).
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

  // add several hints at once (ticked in the UI and then submitted)
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
      // the same day plus the same kind counts as a duplicate (hints often have several sources pointing at the same thing)
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

  // look for hints in the latest intel (**local regex, no network, no LLM**)
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

  // once a probe succeeds the verdict is recomputed immediately, so the UI does not have to wait for the next run

  // ── JSON error fallback ──────────────────────────────────────────
  // When a route throws, Express replies with an HTML error page by default — the frontend's JSON.parse of it
  // only ever yields "Unexpected token '<'", which is very hard to debug. Here it is uniformly turned into JSON.
  app.use((err, req, res, _next) => {
    log?.error('route error — ' + req.method + ' ' + req.originalUrl + ': ' + (err.stack ?? err.message));
    if (res.headersSent) return;
    res.status(err.status ?? 500).json({ error: err.message ?? 'internal error', route: req.originalUrl });
  });

  // ── built web app ────────────────────────────────────────────────
  const webDist = path.join(APP_ROOT, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
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
