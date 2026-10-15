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

  // ── browser / profile targeting ──────────────────────────────────
  //
  // The page that owns the browser setting (web/src/pages/Browser.jsx) is rendered from this one answer:
  // the installed executables, the **discovered profiles** (so nobody hand-writes a path), what the setting
  // currently resolves to (through the same function every feature uses, see server/src/browser-target.js),
  // and one status row per feature that depends on it (server/src/browser-consumers.js).
  //
  // `profiles: false` skips the discovery for callers that only want the detected browsers; the discovery
  // itself is a directory listing and reads no cookie.
  app.get('/api/browser/target', (req, res) => {
    const cfg = getConfig();
    const discovered = listProfiles();
    const picker = pickerFor(discovered, cfg);
    res.json({
      // `paths.browsersDir` is handed in as an extra root: it is the setting that decides where engines live
      // when PLAYWRIGHT_BROWSERS_PATH was not already set at startup, and an engine the page cannot see is an
      // engine the user cannot pick.
      detected: detectBrowsers({ extraRoots: [cfg?.paths?.browsersDir] }),
      target: resolveProfileTarget(cfg),
      report: browserTargetReport(cfg),
      profiles: picker.options,
      // Entries the discovery refused (a row with no usable path) and rows the picker could not offer: the
      // page shows the count rather than quietly presenting a shorter list.
      unusableProfiles: picker.unusable,
      selected: picker.selected,
    });
  });

  // The older name of the route above, kept because a page may still ask for it: same detection, and the
  // browser config it used to return (the target answers everything it did, and more).
  app.get('/api/browsers', (_req, res) => {
    const cfg = getConfig();
    res.json({ detected: detectBrowsers({ extraRoots: [cfg?.paths?.browsersDir] }), config: cfg.browser });
  });

  // ── login availability ───────────────────────────────────────────
  // Only reports "which cookie names were read", and **never sends back any value**.
  //
  // The profile is resolved exactly like every feature's own read (server/src/browser-target.js): a request
  // that names one is an explicit hand-in, anything else follows the shared setting. This route used to read
  // `cfg.browser.profileDir` on its own, which is how the settings page and the share page could answer
  // differently about the same machine.
  app.post('/api/cookies/check', async (req, res) => {
    const cfg = getConfig();
    const profile = resolveProfileTarget(cfg, { profileDir: req.body?.profileDir });
    const domains = Array.isArray(req.body?.domains) && req.body.domains.length ? req.body.domains : ['reddit.com'];
    const { readBrowserCookies, hasSessionCookie } = await import('./cookies.js');
    const r = await readBrowserCookies(profile.dir, domains);
    res.json({
      ok: r.ok,
      error: r.error ?? null,
      warning: r.warning ?? null,
      profile: r.profile ?? null,
      profileDir: profile.dir || null,
      profileSource: profile.source,
      profileReason: profile.dir ? null : 'no-profile-configured',
      domains,
      cookieCount: (r.names ?? []).length,
      // The same predicate every other login check uses (server/src/cookies.js), so this route cannot answer
      // "signed in" while the share page answers "probably not" about the same store.
      hasSession: hasSessionCookie(r.names),
      names: r.names ?? [],
    });
  });

  // "Open this file in an editor" -- the app is local, so the person who generated a report can look at it
  // in the tool they actually use.
  //
  // This is the one endpoint in the app whose request names a file that is then handed to an external
  // program, so the request carries a **kind and an id** and the path is resolved here, from the app's own
  // output roots (see server/src/openfile.js for the three defences: a plain file name, a resolved-prefix
  // test, and a symlink test). The invocation is an argv array handed to execFile with `shell: false`, so no
  // file name can ever become command syntax. It is not a long operation and needs no in-flight guard: it
  // starts a program and returns.
  app.post('/api/open', (req, res) => {
    const cfg = getConfig();
    const kind = String(req.body?.kind ?? '');
    // A request that carries a path is refused by name rather than quietly ignored -- resolveOpenPath says so.
    const id = String(req.body?.id ?? req.body?.file ?? '');
    const r = resolveOpenPath(cfg, kind, id);
    if (!r.ok) return res.status(400).json({ ok: false, code: r.code, error: r.error });
    const editor = resolveEditorCommand(cfg.open?.editor);
    if (!editor.program) {
      return res.status(400).json({
        ok: false,
        code: 'no-editor',
        error: 'no editor found: install VS Code (the `code` command) or set an editor command in Settings',
        editor,
      });
    }
    const name = path.basename(r.path);
    openResolvedPath({ file: r.path, editor, displayName: name, platform: process.platform })
      .then((out) => {
        const note = openResultNote(out, editor);
        log?.[out.ok ? 'info' : 'warn'](`open ${kind}/${name}: ${note.en}`);
        res.status(out.ok ? 200 : 500).json({ ok: out.ok, code: out.code ?? null, error: out.error ?? null, kind, name, editor: { program: editor.program, source: editor.source }, command: out.command ?? editor.program, args: out.args ?? null, note });
      })
      .catch((e) => res.status(500).json({ ok: false, code: 'launch-failed', error: e.message }));
  });

  // Moved to server/src/routes/proxy.js (see its header for the shape the remaining groups follow).
  registerProxyRoutes(app, { getConfig, patchConfig, log });



  // ── LLM providers ────────────────────────────────────────────────
  app.get('/api/llm/presets', (_req, res) => {
    const cfg = getConfig();
    const p = activeProvider(cfg);
    res.json({
      // The model lists go out as they are, and that is a decision with a measurement behind it rather than an
      // omission. A preset list is a **fallback for a provider that cannot be queried**, and the only predicate
      // available offline is the id pattern - which does not recognise `deepseek-flash`, the one model this
      // provider actually serves that can see (its capability is stated in metadata, not in its name). Filtering
      // these lists with that predicate would therefore delete the correct entry and keep the doubtful ones.
      // The pull path is where the rule belongs, and there the answer comes from the provider: listModels()
      // keeps only what the metadata or the id can show to be multimodal.
      presets: PRESETS,
      // The masked profile list, not `cfg.llm.providers` verbatim: masking only `active` (which this route
      // did at first) left every *other* profile's apiKey in the response — the same leak as /api/config,
      // one endpoint over. `publicConfig` is the one place the rule lives; the masker here is the same
      // function applied to the single active profile, so the two can never disagree.
      providers: publicConfig({ providers: cfg.llm?.providers ?? [] }).providers,
      activeId: cfg.llm?.activeId ?? '',
      // Never send the plaintext key back. `active` is wrapped in a one-key object so the walk has a field
      // *name* to judge (the rule is name-based, see config.js) instead of treating the profile itself as
      // the value under a nameless root.
      active: publicConfig({ provider: p }).provider,
      hasKey: !!p.apiKey,
    });
  });

  app.post('/api/llm/new', (req, res) => {
    let cfg = getConfig();
    const p = newProvider(req.body?.preset ?? 'deepseek', req.body?.overrides ?? {});
    cfg.llm = cfg.llm ?? {};
    cfg.llm.providers = [...(cfg.llm.providers ?? []), p];
    cfg.llm.activeId = p.id;
    cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
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

  // Moved to server/src/routes/watch.js (see its header for the shape the remaining groups follow).
  registerWatchRoutes(app, { getConfig, patchConfig, log, persist, busyGuard, preserveSecretsIn });



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
        // The allowance travels from the entry being probed (a custom source or a watch target carries it);
        // nothing is probed with an allowance it did not itself declare.
        const r = await probeUrl(t.url, {
          cfg,
          samples,
          modes: perTarget.get(t.id) ?? effectiveModes ?? modes,
          subject: t.source ?? null,
        });
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
    let cfg = getConfig();
    const t = newTarget(req.body?.kind ?? 'bark', req.body?.overrides ?? {});
    cfg.notify = cfg.notify ?? {};
    cfg.notify.targets = [...(cfg.notify.targets ?? []), t];
    cfg = persist(cfg); // write through the secret-preserving path; the handler keeps using what was stored
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
      // Same rule as everywhere else, now through the one shared predicate: a masked field means "the saved
      // one". The local regex it replaces only recognised a run of asterisks, so the partial mask the
      // notifier sends for a webhook URL ('https://host/***') was pushed as a live URL.
      if (!wanted[k] || isMaskedSecret(wanted[k])) merged[k] = saved?.[k] ?? wanted[k] ?? '';
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

  // Moved to server/src/routes/egress.js (see its header for the shape the remaining groups follow).
  registerEgressRoutes(app, { getConfig, patchConfig, log });



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

  // Moved to server/src/routes/share.js (see its header for the shape the remaining groups follow).
  registerShareRoutes(app, { getConfig, patchConfig, log, busyGuard });



  // Moved to server/src/routes/archive.js (see its header for the shape the remaining groups follow).
  registerArchiveRoutes(app, { getConfig, patchConfig, log });



  // ── README (shown inside the app) ────────────────────────────────
  // The UI has an "About" panel that renders these files and switches language instantly, so a
  // reader never has to leave the app (and never has to find the file on disk).
  //
  // Which documents it may show, and what each one is called, is `server/src/docs.js`: a fixed allowlist, so the
  // caller picks a *key* in it and never a path. `privacy` and `security` joined the Readme there, which is what
  // makes the privacy posture readable inside the app rather than only in the package folder. The document's
  // title is its own first heading, so the panel needs no new i18n key and the label cannot drift from the file.
  // In a packaged build the files sit next to app/ (build-portable copies them); from a source checkout they are
  // at the repo root. Both candidates are tried, nothing else.
  app.get('/api/readme', (req, res) => {
    const lang = docLang(req.query.lang);
    const roots = [APP_ROOT, path.join(APP_ROOT, '..'), process.cwd()];
    // The one generated document: what *this* install is configured to contact and where its data lives. Measured
    // per request (directory sizes are read-only and bounded) and never cached, because the answer changes the
    // moment the user edits a setting - a stale privacy page would be worse than none.
    const cfg = getConfig();
    const sizes = {};
    for (const d of DATA_DIRS) {
      const m = measureDir(d.configured ? resolveDir(cfg, d.key) : '', { fs });
      if (m) sizes[d.key] = m;
    }
    const generated = { machine: () => privacyMarkdown(privacyFacts(cfg), { sizes }) };
    const result = readDocs(req.query.doc, lang, roots, generated);
    if (!result.found) {
      return res.status(404).json({
        ok: false,
        error: `no ${result.wanted} document next to the app`,
        documents: result.available,
      });
    }
    const requested = pickDoc(req.query.doc);
    res.json({
      ok: true,
      doc: result.wanted,
      lang: result.lang,
      file: result.found.file,
      title: result.found.title,
      // The languages this *document* exists in: the Readmes in two, everything else in one. The panel's language
      // switch is built from this, which is why a single-language document offers no switch rather than offering
      // one that would silently show the other file.
      available: Object.keys(requested.files),
      documents: result.available,
      bytes: Buffer.byteLength(result.found.markdown, 'utf8'),
      markdown: result.found.markdown,
    });
  });

  // Moved to server/src/routes/vdb.js (see its header for the shape the remaining groups will follow).
  registerVdbRoutes(app, { getConfig, patchConfig, log });



  // ── LLM usage & budget ───────────────────────────────────────────
  // Before this no usage was visible in the UI at all (the usage was being fetched but nobody aggregated it), yet this is where the money goes.
  // Report only **what is visible**: a call whose usage cannot be read is counted separately, never guessed at.
  app.get('/api/cost', (req, res) => {
    const cfg = getConfig();
    const days = Math.max(1, Math.min(90, Number(req.query.days ?? 14)));
    try {
      const { rows, badLines } = loadUsage(cfg);
      const summary = summarizeUsage(rows, { days, cfg });
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
      const series = peopleSeries(db, { days, cfg });
      const view = groupView({
        byDay: series.byDay,
        people: cfg.people ?? [],
        days,
        rules: cfg.silence ?? {},
        now: new Date(),
        cfg,
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
      const series = peopleSeries(db, { days, cfg });
      const result = detectSilence({
        byDay: series.byDay,
        people: cfg.people ?? [],
        rules: cfg.silence ?? {},
        now: new Date(),
        cfg,
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
