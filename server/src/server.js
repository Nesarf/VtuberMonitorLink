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
import { registerConfigRoutes } from './routes/config.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerSourcesDiagnoseRoutes } from './routes/sources-diagnose.js';
import { registerSourcesExtraRoutes } from './routes/sources-extra.js';
import { registerProxyExtraRoutes } from './routes/proxy-extra.js';
import { registerIntelRestRoutes } from './routes/intel-rest.js';
import { registerProxyRestRoutes } from './routes/proxy-rest.js';
import { registerArchiveRestRoutes } from './routes/archive-rest.js';
import { registerSourcesCustomRoutes } from './routes/sources-custom.js';
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

  // Moved to server/src/routes/config.js (see its header for the shape the remaining groups follow).
  registerConfigRoutes(app, { getConfig, patchConfig, log, onConfigChanged, persist, preserveSecretsIn });



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



  // Moved to server/src/routes/sources-custom.js (see its header for the shape the remaining groups follow).
  registerSourcesCustomRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn });



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

  // Moved to server/src/routes/sources-extra.js (see its header for the shape the remaining groups follow).
  registerSourcesExtraRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn, busyGuard });



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



  // Moved to server/src/routes/proxy-rest.js (see its header for the shape the remaining groups follow).
  registerProxyRestRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn });



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



  // Moved to server/src/routes/intel-rest.js (see its header for the shape the remaining groups follow).
  registerIntelRestRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/features.js (see its header for the shape the remaining groups follow).
  registerFeaturesRoutes(app, { getConfig, patchConfig, log, busyGuard });



  // Moved to server/src/routes/proxy-extra.js (see its header for the shape the remaining groups follow).
  registerProxyExtraRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn });



  // Moved to server/src/routes/client-log.js (see its header for the shape the remaining groups follow).
  registerClientLogRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/entities.js (see its header for the shape the remaining groups follow).
  registerEntitiesRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/sources-diagnose.js (see its header for the shape the remaining groups follow).
  registerSourcesDiagnoseRoutes(app, { getConfig, patchConfig, log, persist, preserveSecretsIn, busyGuard });



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



  // Moved to server/src/routes/archive-rest.js (see its header for the shape the remaining groups follow).
  registerArchiveRestRoutes(app, { getConfig, patchConfig, log });



  // Moved to server/src/routes/events.js (see its header for the shape the remaining groups follow).
  registerEventsRoutes(app, { getConfig, patchConfig, log, eventWhy });



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
