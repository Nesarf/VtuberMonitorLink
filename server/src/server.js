// server.js — local HTTP service + REST API (listens on 127.0.0.1 only)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_ROOT,
  configHealthSnapshot,
  isMaskedSecret,
  preserveSecretStrings,
  publicConfig,
  recoverConfigFromBackup,
  resolveDir,
  verifyBackup,
} from './config.js';
import { requestGuard } from './request-guard.js';
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
import { PRESETS, activeProvider, listModels, newProvider, providerPolicy } from './llm.js';
import { TARGET_KINDS, DEFAULT_RULES, allBaselines, baselineHealthSnapshot, checkTarget, checkWatchLogin, readHistory, sanitizeId, sanitizeTarget, watchDir } from './watch.js';
import { DEFAULT_SAMPLES, isFresh, loadCache, probeUrl, updateCache } from './probe.js';
import { clear as egressClear, decision as egressDecision, snapshot as egressSnapshot } from './egress.js';
import { detectFromItems, marksFor, monthGrid, sanitizeEntry, upcoming } from './calendar.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { todayIn } from './day.js';
import { adviceDir, diagnoseSource, listAdvice, readAdvice } from './diagnose.js';
import { corpusSample, loadVocab, saveVocab, search, tagCloud } from './search.js';
import { checkedChatRequest } from './llm.js';
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
  rebuildAggregates,
  rebuildPlan,
  recentSeries,
  series,
  stats as archiveStats,
} from './archive.js';
import { detectSilence, silenceSummary } from './silence.js';
import { groupView } from './groups.js';
import { budgetStatus, costSummary, loadUsage, summarizeUsage } from './cost.js';
import { loadObservationState } from './observe.js';
import { ensureIndex, indexSummary, loadCachedIndex, searchIndex, toPerson } from './vdb.js';
// The documents the About panel may show (Readme, Privacy, Security) and the allowlist that keeps a caller to a
// key in it rather than a path. See server/src/docs.js for why that lives in a module.
import { docLang, pickDoc, readDocs } from './docs.js';
import { registerCostRoutes } from './routes/cost.js';
import { registerSilenceRoutes } from './routes/silence.js';
import { registerGroupsRoutes } from './routes/groups.js';
import { registerRunRoutes } from './routes/run.js';
import { registerOpenRoutes } from './routes/open.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerStateRoutes } from './routes/state.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerBrowsersRoutes } from './routes/browsers.js';
import { registerReadmeRoutes } from './routes/readme.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPreflightRoutes } from './routes/preflight.js';
import { registerCookiesRoutes } from './routes/cookies.js';
import { registerVisionRoutes } from './routes/vision.js';
import { registerEntitiesRoutes } from './routes/entities.js';
import { registerClientLogRoutes } from './routes/client-log.js';
import { registerFeaturesRoutes } from './routes/features.js';
import { registerProbeRoutes } from './routes/probe.js';
import { registerNotifyRoutes } from './routes/notify.js';
import { registerLlmRoutes } from './routes/llm.js';
import { registerThumbRoutes } from './routes/thumb.js';
import { registerIntelRoutes } from './routes/intel.js';
import { registerReportsRoutes } from './routes/reports.js';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerWatchRoutes } from './routes/watch.js';
import { registerArchiveRoutes } from './routes/archive.js';
import { registerShareRoutes } from './routes/share.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerEgressRoutes } from './routes/egress.js';
import { registerAdviceRoutes } from './routes/advice.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerVdbRoutes } from './routes/vdb.js';
// The live half of the privacy page: what this install contacts and where its data lives. See the module header
// for the two rules it exists to keep (the field list is data; a webhook URL is a credential).
import { DATA_DIRS, measureDir, privacyFacts, privacyMarkdown } from './privacy.js';
import {
  accountsForTarget,
  applyShareSettings,
  appendAudit,
  buildBundle,
  buildHandoff,
  bundleFilename,
  checkLoginState,
  contentDisposition,
  guardPost,
  IMAGE_COUNT_LABEL,
  IMAGE_MODES,
  LOGIN_KINDS,
  pickAccountId,
  readAudit as readShareAudit,
  renderBundle,
  renderSiteText,
  resolveLoginProbe,
  resolveSiteBody,
  shareImageSetting,
  siteProfileById,
  stagesReport,
  targetById,
  toPlainText,
  truncateForSite,
  verificationStore,
} from './share.js';
import { openResolvedPath, openResultNote, resolveEditorCommand, resolveOpenPath } from './openfile.js';
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
import { listProfiles, pickerFor, resolveProfileTarget } from './browser-target.js';
import { browserTargetReport } from './browser-consumers.js';

/**
 * The "why is this one event" summary the events API serves.
 *
 * Kept here rather than in cluster.js because it is a *view*: cluster.js answers with the full evidence
 * (per-item reasons, every shared key, the similarity of every pair), and an HTTP response should not
 * carry that for 60 events at a time. The layer name and the key are what a person debugging a wrong
 * merge needs; the counts say whether the guards were doing anything at all.
 */
function eventWhy(cluster) {
  const e = cluster?.evidence;
  if (!e) return null;
  return {
    by: e.by,
    layers: (e.layers ?? []).map((l) => ({
      layer: l.layer,
      label: l.label,
      key: l.key,
      items: l.items?.length ?? 0,
      scores: l.scores ?? undefined,
    })),
    merges: e.merges ?? null,
    refused: e.refused ?? null,
  };
}

export function createApp({ getConfig, setConfig, log, onConfigChanged }) {
  const app = express();
  // Before anything else, and before the body parser: a request that fails the loopback check must not be
  // parsed, routed or answered with data. This is what closes DNS rebinding — see request-guard.js for why
  // the Host header, and not the bind address, is the decision point.
  app.use(requestGuard());
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
  // Every config write goes through here, for one reason: the client now reads a **masked** config, so the
  // object it sends back carries '***' where a secret used to be. Storing that would destroy the user's key
  // on the first save of the settings page. `preserveSecretStrings` puts the stored value back at every
  // position that arrived masked or blank (see the secrets section of config.js); the route handlers below
  // therefore stay as they were and keep their own semantics — a narrow PUT stays a narrow PUT.
  const persist = (next) => setConfig(preserveSecretStrings(next, getConfig()));

  /**
   * A change that arrived from a client, with every secret the client only knows as a mask replaced by the
   * stored one. Applied to the **request body** and before the handler touches it, because the two
   * alternatives are both wrong: restoring after the write would store the mask first (the handlers call
   * setConfig themselves in a few places), and restoring after a sanitiser has already run would find the
   * mask sitting where the real value used to be.
   *
   * No key is invented: only keys the client actually sent are returned, so "PUT {watch:{enabled:false}}"
   * still means "change that one thing".
   */
  const preserveSecretsIn = (body) => {
    const stored = getConfig();
    const out = {};
    for (const [k, v] of Object.entries(body ?? {})) out[k] = preserveSecretStrings(v, stored?.[k]);
    return out;
  };

  const patchConfig = (cfg, patch) => {
    const next = persist({ ...cfg, ...patch });
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
  // The whole config, minus its secrets: this route is what a DNS-rebound page used to be able to read, and
  // it is also what every settings page round-trips. `publicConfig` masks at any depth and states which
  // fields are secret in one place (config.js); the matching write-side restore lives in `persist`.
  app.get('/api/config', (_req, res) => res.json(publicConfig(getConfig())));
  app.put('/api/config', (req, res) => {
    // The body is applied as sent (a settings page posts the whole config back), with the masked secrets
    // restored from storage first. Narrow patches go through the same helper; see preserveSecretsIn below.
    const next = persist(preserveSecretsIn(req.body ?? {}));
    onConfigChanged?.(next);
    res.json(publicConfig(next));
  });

  // ── config integrity ─────────────────────────────────────────────
  //
  // Why this is a route of its own rather than three extra fields on /api/state: "is my config file
  // damaged" and "is a run in progress" are different questions with different lifetimes, and a page
  // that greys out a settings form should not have to read the run state to find out. It is also the
  // answer a support conversation starts from, and it stays readable when the config itself is the
  // thing that is broken — the payload describes the file, never a value from it.
  //
  // The state is a property of the running process (see the durability section of config.js for why),
  // so it is read from the module rather than through getConfig(): a damaged file is exactly the case
  // where getConfig() is an in-memory default that says nothing about the disk.
  app.get('/api/config/health', (_req, res) => {
    const backup = verifyBackup();
    res.json({ ...configHealthSnapshot(), backupUsable: backup.ok, backupError: backup.ok ? null : backup.error });
  });

  // The deliberate half of "never silently": the app runs on defaults after a damaged config and does
  // **not** put the backup back on its own, because a config that changes itself is the failure this
  // release is about. This is the one call that restores it, and the answer states what happened.
  app.post('/api/config/recover', (_req, res) => {
    const result = recoverConfigFromBackup();
    const { config, ...rest } = result;
    res.status(result.ok ? 200 : 409).json({ ...rest, health: configHealthSnapshot() });
    if (result.ok) onConfigChanged?.(config);
  });

  // Moved to server/src/routes/sources.js (see its header for the shape the remaining groups follow).
  registerSourcesRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn });



  // ── custom sources ───────────────────────────────────────────────
  app.post('/api/sources/custom', (req, res) => {
    let cfg = getConfig();
    // A user-added source carries free-form keys (url / proxy / note), so the mask rule is applied before
    // the sanitiser picks the fields out.
    const s = sanitizeCustomSource(preserveSecretsIn(req.body ?? {}));
    if (!s.id) return res.status(400).json({ error: 'id is required' });
    // Every fetch kind this build offers reads a url: the uid-only kind (an account-id feed) was removed
    // with its platform, and a source that carries nothing to fetch would be refused by the fetch stage anyway.
    if (!s.url) return res.status(400).json({ error: 'url is required' });
    if (effectiveSources(cfg).some((x) => x.id === s.id)) return res.status(409).json({ error: `source already exists: ${s.id}` });
    cfg.customSources = [...(cfg.customSources ?? []), s];
    cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
    res.json({ ok: true, source: s, sources: effectiveSources(cfg) });
  });

  app.delete('/api/sources/custom/:id', (req, res) => {
    let cfg = getConfig();
    const before = (cfg.customSources ?? []).length;
    cfg.customSources = (cfg.customSources ?? []).filter((s) => s.id !== req.params.id);
    if (cfg.sources?.[req.params.id]) delete cfg.sources[req.params.id];
    cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
    res.json({ ok: true, removed: before - cfg.customSources.length, sources: effectiveSources(cfg) });
  });

  // Moved to server/src/routes/browser.js (see its header for the shape the remaining groups follow).
  registerBrowserRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/browsers.js (see its header for the shape the remaining groups follow).
  registerBrowsersRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/cookies.js (see its header for the shape the remaining groups follow).
  registerCookiesRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/open.js (see its header for the shape the remaining groups follow).
  registerOpenRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/proxy.js (see its header for the shape the remaining groups follow).
  registerProxyRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/llm.js (see its header for the shape the remaining groups follow).
  registerLlmRoutes(app, { getConfig, patchConfig, log, persist });



  // Moved to server/src/routes/watch.js (see its header for the shape the remaining groups follow).
  registerWatchRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn });



  // Moved to server/src/routes/run.js (see its header for the shape the remaining groups follow).
  registerRunRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/state.js (see its header for the shape the remaining groups follow).
  registerStateRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/preflight.js (see its header for the shape the remaining groups follow).
  registerPreflightRoutes(app, { getConfig, patchConfig, log });



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
  // A **function declaration**, not an arrow on a `const`: routes register from the top of createApp
  // downwards, so a route written above this block would reach a `const` while it is still in its temporal
  // dead zone -- `ReferenceError: Cannot access 'busyGuard' before initialization` at registration time, which
  // takes the whole application down before it serves anything (measured: the watch login-check route did
  // exactly that, and `verify:fast` stayed green because nothing in the gate constructs the app).
  // `inFlight` may stay a `const`: the middleware only reads it when a request arrives, long after createApp
  // has returned. Do not convert this back to an arrow, whatever the style around it looks like.
  function busyGuard(name) {
    return (req, res, next) => {
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
  }

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

  // Moved to server/src/routes/advice.js (see its header for the shape the remaining groups follow).
  registerAdviceRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/intel.js (see its header for the shape the remaining groups follow).
  registerIntelRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/probe.js (see its header for the shape the remaining groups follow).
  registerProbeRoutes(app, { getConfig, patchConfig, log, busyGuard });



  // Moved to server/src/routes/health.js (see its header for the shape the remaining groups follow).
  registerHealthRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/thumb.js (see its header for the shape the remaining groups follow).
  registerThumbRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/schedule.js (see its header for the shape the remaining groups follow).
  registerScheduleRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/notify.js (see its header for the shape the remaining groups follow).
  registerNotifyRoutes(app, { getConfig, patchConfig, log, persist });



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
  // This route keeps its own blank-the-fields redaction on purpose, and it is the precedent the read-side
  // rule was built to match: an export is a *file*, `?secrets=1` is the deliberate "give me the backup with
  // keys" switch, and the blank form is what `/api/config/import` documents ("apiKey:'' must not overwrite a
  // stored value") — a masked '***' in a file would read as a value to anyone opening it in an editor.
  // The blanket `publicConfig` pass afterwards is not decoration: the hand-kept list below covered the LLM key
  // and the wiki password but **not** `proxy.controlSecret`, so a redacted export still carried a live
  // credential for the mihomo/Clash control API (found by tools/config-secrets-test.mjs). Layering the
  // serializer over the blanking covers every secret the rule knows about, while the fields the list does
  // blank keep their '' shape — which is what the import path and its traversal check depend on.
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
      {
        app: "Vtuber's Monitor Link",
        version: 2,
        exportedAt: new Date().toISOString(),
        secrets: withSecrets,
        // ?secrets=1 is the deliberate "back up everything" switch and stays verbatim.
        config: withSecrets ? clone : publicConfig(clone),
      },
      null,
      2
    );
    res.setHeader('content-disposition', `attachment; filename="vml-config-${todayIn(cfg)}.json"`);
    res.type('application/json; charset=utf-8').send(body);
  });

  app.post('/api/config/import', (req, res) => {
    const raw = req.body?.config ?? req.body;
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'expected a config object' });
    const cur = getConfig();
    // A masked import (the UI can post back what /api/config just handed it) means "unchanged" for every
    // secret, the same rule the '':''-does-not-overwrite behaviour below expresses.
    const incoming = preserveSecretsIn(raw);

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
    const next = persist(merge(cur, incoming));
    onConfigChanged?.(next);
    // The merged config is answered masked: an import is usually fed back by the UI, and this response is a
    // config object like any other. The import itself still stores the real values (`persist` restored them).
    res.json({ ok: true, config: publicConfig(next) });
  });

  // Moved to server/src/routes/search.js (see its header for the shape the remaining groups follow).
  registerSearchRoutes(app, { getConfig, patchConfig, log });



  // ── Office export / Word & Excel ─────────────────────────────────
  // OOXML hand-written in pure Node, with no dependency on Office / COM / Python — a portable exe cannot assume what the target machine has installed.
  app.get('/api/intel/export', (req, res) => {
    const cfg = getConfig();
    const format = ['xlsx', 'docx', 'md', 'html'].includes(String(req.query.format)) ? String(req.query.format) : 'xlsx';
    const data = latestIntel(cfg, Number(req.query.limit ?? 500));
    const items = applyFeatures(data.items ?? [], loadFeatureCache(cfg));
    const stamp = todayIn(cfg);
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

  // Moved to server/src/routes/features.js (see its header for the shape the remaining groups follow).
  registerFeaturesRoutes(app, { getConfig, patchConfig, log, busyGuard });



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

  // Moved to server/src/routes/client-log.js (see its header for the shape the remaining groups follow).
  registerClientLogRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/entities.js (see its header for the shape the remaining groups follow).
  registerEntitiesRoutes(app, { getConfig, patchConfig, log });



  // ── bulk source toggles ──────────────────────────────────────────
  // Clicking 30 sources one by one is tiring, and it is very easy to forget to turn them back off in tests (this feature exists because of exactly that trap)
  app.post('/api/sources/bulk', (req, res) => {
    let cfg = getConfig();
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
    cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
    res.json({ ok: true, changed: picked.length, action, sources: effectiveSources(cfg) });
  });

  // Moved to server/src/routes/reports.js (see its header for the shape the remaining groups follow).
  registerReportsRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/egress.js (see its header for the shape the remaining groups follow).
  registerEgressRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/vision.js (see its header for the shape the remaining groups follow).
  registerVisionRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/share.js (see its header for the shape the remaining groups follow).
  registerShareRoutes(app, { getConfig, patchConfig, log, busyGuard });



  // Moved to server/src/routes/archive.js (see its header for the shape the remaining groups follow).
  registerArchiveRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/readme.js (see its header for the shape the remaining groups follow).
  registerReadmeRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/vdb.js (see its header for the shape the remaining groups will follow).
  registerVdbRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/cost.js (see its header for the shape the remaining groups follow).
  registerCostRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/groups.js (see its header for the shape the remaining groups follow).
  registerGroupsRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/silence.js (see its header for the shape the remaining groups follow).
  registerSilenceRoutes(app, { getConfig, patchConfig, log });



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
        daily: series(db, { days, cfg }),
        bySource: series(db, { days, groupBy: 'source', cfg }),
        people: peopleSeries(db, { days, cfg }),
        keywords: keywordSeries(db, { days, limit: Number(req.query.keywords ?? 12), cfg }),
        health: healthSeries(db, { days, cfg }),
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
    // The fallback is the **local** day, for the same reason the run's own date is (see runner.js): this
    // day becomes the bucket for every item in the batch that carries no timestamp of its own.
    const fallbackDay = todayIn(cfg) ?? String(data.date ?? '').slice(0, 10);
    const r = archiveRun(cfg, { date: data.date ?? fallbackDay, items: data.items ?? [] });
    res.json({ ok: r.ok, ...r });
  });

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

  // Moved to server/src/routes/people.js (see its header for the shape the remaining groups follow).
  registerPeopleRoutes(app, { getConfig, patchConfig, log });



  // The countdown endpoints live in their own module now (server/src/routes/calendar.js), which is the shape the
  // remaining groups will follow: a registrar that receives the live configuration and the one place that
  // persists a patch of it, and imports everything else from the module that owns it.
  registerCalendarRoutes(app, { getConfig, patchConfig, log });

  // once a probe succeeds the verdict is recomputed immediately, so the UI does not have to wait for the next run

  // ── JSON error fallback ──────────────────────────────────────────
  // When a route throws, Express replies with an HTML error page by default — the frontend's JSON.parse of it
  // only ever yields "Unexpected token '<'", which is very hard to debug. Here it is uniformly turned into JSON.
  //
  // This middleware is also **the route-level error boundary**, and it is the reason the uncaught-exception
  // handler in index.js is allowed to end the process (see the comment on it there): a handler that throws
  // synchronously lands here, becomes a 500 with the route named, and the process keeps serving. Only a throw
  // that gets past every boundary — an async callback, a timer, an unawaited promise — reaches
  // `uncaughtException`, and that one means the state is no longer vouched for. Removing this middleware
  // would silently move every route bug into the "ends the process" bucket.
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
