// config.js — Config load & save.
// Every path is configurable: no hard-coded machine-specific path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root */
export const APP_ROOT = path.resolve(__dirname, '..', '..');
/**
 * The config file, next to `app/` in a packaged release and at the repository root in a source
 * checkout.
 *
 * `VML_CONFIG_PATH` moves it, and it exists for exactly one reason: the durability test has to drive
 * the real read/write path against a file of its own. It must never be aimed at the user's real
 * config.json, which is why the override is a full path and not a directory. Nothing in this
 * repository sets it; a process that starts without it resolves the path exactly as it always did.
 */
export const CONFIG_PATH = process.env.VML_CONFIG_PATH
  ? path.resolve(process.env.VML_CONFIG_PATH)
  : path.join(APP_ROOT, 'config.json');

export const DEFAULT_CONFIG = {
  browser: {
    // bundled: the Firefox shipped with the package | system: a Firefox already installed on the machine | custom: a user-given path
    mode: 'bundled',
    executablePath: '',
    // Points at the Firefox profile directory when reusing a login session (empty = a temporary clean profile).
    // A Firefox profile belongs to the machine rather than to one executable, so a bundled engine can reuse
    // the profile the installed Firefox is signed in with (see server/src/browser-target.js).
    profileDir: '',
    headless: true,
    waitMs: 6000,
    hardTimeoutMs: 90000,
  },
  llm: {
    // Multiple profiles: the web UI can hold several sets (a cheap one / one for reports) and switch at any time
    // Backward compatible with the old shape: a flat baseUrl/apiKey/model is treated by activeProvider() as a single profile
    activeId: '',
    providers: [],
    // Usage budget: dailyTokens = 0 means no limit. By default it only **warns**, never blocks;
    // set onExceed to 'stop' to actually block (this is the user's own tool, so blocking has to be asked for explicitly).
    budget: { dailyTokens: 0, onExceed: 'warn' },
    // Legacy fields of the old flat shape, kept so migration stays smooth
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
    maxTokens: 8192,
    temperature: 0.3,
  },
  schedule: {
    // Several scheduled tasks; the old flat shape (enabled/mode/dayOfWeek/time) is auto-migrated into one task
    enabled: false, // compatibility field — `tasks` is what actually counts
    mode: 'weekly', // weekly | daily
    dayOfWeek: 2,
    time: '23:30',
    merchEveryDays: 14,
    tasks: [],
  },
  run: {
    // Pre-fetch throttling: Reddit-like sites rate-limit by IP, so spacing requests out beats retrying in bursts
    defaultGapSeconds: 2,
    maxParallel: 3,
    // After the Nth consecutive failure, quarantine this source for M hours; once that time is up it is retried automatically (this is not a permanent block).
    // Reason: retrying an unreachable site every round wastes time and sends extra requests nobody asked for — and those requests are themselves a footprint.
    quarantine: { failures: 3, hours: 6 },
    // Whether each run also checks the watch targets
    watchWithRun: true,
    // When one exit fails, automatically try another exit (only takes effect when the source does not name an exit itself)
    autoFailover: true,
    // At the **end** of a run, self-check the sources that errored and write a diagnostic file (sources that connect fine are never touched)
    diagnoseFailed: true,
    // Use an LLM to extract structured features (person / affiliation / game / event) so search can match on attributes; cached, with a cap
    extractFeatures: true,
    featureLimit: 40,
  },
  proxy: {
    // Important: Node's fetch (undici) does **not** read the system proxy by default;
    // this tool proxies explicitly according to this config, for fetching and browser rendering alike.
    // Exception: some sites get risk-controlled *because* of a proxy, so a source can be set to direct.
    enabled: false,
    url: '',
    // Exit mode: http = use the HTTP proxy below; tor = use Tor's SOCKS5 (anonymizing)
    mode: 'http',
    // Tor's SOCKS5 address (Tor Browser defaults to 9150, a standalone tor to 9050)
    torSocks: 'socks5://127.0.0.1:9150',
    // Optional: path to the executable used by the one-click tor launch (empty = that button is not offered)
    torExe: '',
    // mihomo / Clash.Meta control API (list nodes, switch nodes, measure each node's delay to a given site)
    controlUrl: '',
    controlSecret: '',
  },

  // ── report ─────────────────────────────────────────────────
  // Dormant / graduated: the daily report answers "what is new today", so people who went quiet **never appear** —
  // even if they posted something yesterday (their only item in half a year, and exactly the one worth seeing). So everyone
  // dormant for >= 6 months is listed together at the **very end of the daily report**, each with their latest content;
  // if any of them moved again recently, that is flagged separately as a "comeback".
  report: {
    dormant: {
      enabled: true,
      months: 6, // user-specified: half a year
      maxPeople: 12, // how many people to list at most in one report (more than that is just noise)
      maxItems: 2, // how many items per person at most
      comebackDays: 3, // activity within the last few days -> treat as a "possible comeback"
    },
  },

  // ── silence detection ───────────────────────────────────
  // "No activity" is intel too: content alerts are blind to absence. Every criterion is relative to **the person's own cadence**
  // (see server/src/silence.js), never a fixed number of days — a daily poster and a monthly poster should not share one threshold.
  // Only people with an agency set in "followed people" take part in the group-level judgement (several members of one group going quiet together).
  silence: {
    enabled: true,
    sampleDays: 20,
    minDays: 3,
    maxDays: 90,
    factor: 2.5,
    groupQuietDays: 5,
    minMembers: 3,
    basisDays: 60, // how many days of history to take from the archive when estimating the cadence
  },

  // ── observation mode ────────────────────────────────────
  // Goal: see the state of a whole group without leaving the trace that "someone is watching the whole group".
  // Four things: sampling (only part of the sources each round, filled in by rotation), jitter (random intervals and start),
  // allocating exits by "whose log it is" (only group-self-hosted sites go through Tor), and skipping sources that need a login.
  // Detailed criteria and the measured evidence are in the top comment of server/src/observe.js.
  observation: {
    enabled: false,
    // How much to take each round (ratio); combined with rotation, a few rounds add up to full coverage
    sampleRatio: 0.5,
    minSources: 2,
    minWatch: 1,
    // Request-interval jitter range (seconds): replaces the fixed defaultGapSeconds in observation mode
    jitterSeconds: [3, 12],
    // Group-self-hosted sites go through Tor (that is the only kind of entry where "the log is in their hands")
    torForAgency: true,
    // Sources that need a login are not run in this mode (so a real identity is never tied to observation behaviour)
    skipLoginSources: true,
    // Use a fresh Tor circuit for every selection (SOCKS username isolation -> a different exit IP), so a whole round does not leave through one exit
    rotateExit: true,
  },
  // Following by "person": the list itself is the config (whose name, aliases, where the accounts are)
  // [{ id, name, enName, agency, aliases[], tags[], notes, links{<platform>: <account>},
  //    enabled, notifyLevel: info|alert|urgent }]
  people: [],
  peopleOptions: {
    // Whether the intel page shows followed people only by default (off by default: let people see the full stream first, then narrow it themselves)
    onlyFollowed: false,
    // On a followed-person match, notify at that person's notifyLevel
    notifyOnMatch: true,
    // List followed people's activity in the daily report
    reportMatches: true,
  },
  // one-click sharing
  share: {
    // Default format when downloading a share bundle
    defaultFormat: 'html',
    // Post targets already verified for a specific account, as { targetId: { accountId: { at, ok, ... } } }.
    // Written by /api/share/verify, which measures the credential against the site on demand.
    // Why the account is part of the key: the credential decides whether a post lands, so "this target
    // worked once" is not the same statement as "this account can post" (an older config may still hold
    // the plain list of target ids; that shape is still read, see verificationStore in share.js).
    verifiedTargets: {},
    // Which account each posting target uses, as { targetId: accountId }. A machine often holds more than one
    // login for the same site, and posting under whichever profile was scanned first is not a choice anybody
    // made; the share page writes this when the chooser is used and falls back to the automatic pick otherwise.
    accounts: {},
    // Image attachment. This is a setting rather than "whatever the items happened to carry": a bundle with
    // remote images can go blank in front of the recipient (hotlink protection), and a post that suddenly
    // carries pictures is a different act from one that carries text.
    //   mode none   -- attach nothing (default)
    //        source -- keep the original image URLs in the data only
    //        inline -- embed data: URIs (the only shape a single-file HTML may reference without going external)
    images: {
      mode: 'none',
      // How many images one bundle may carry in total
      maxPerBundle: 4,
      // How many images one public post may carry
      maxPerPost: 1,
      // Cap on a single inlined image; anything larger is left out and counted in the bundle
      inlineMaxBytes: 204800,
    },
    // Sites the user adds by hand, in the same shape as SHARE_SITES in server/src/share.js:
    //   { id, name: { zh, en }, loginKind, credential: { zh, en }, requirements: [...], implemented }
    // Declaring a site does not make it able to post: it lists what the site needs, and the app measures
    // that against the real accounts (see /api/share/verify). With no `implemented`, sending reports
    // "not implemented" instead of pretending.
    sites: [],
  },
  // image understanding tagging
  // Note: **off by default**. Turning it on means sending the images attached to intel to the model service you configured.
  // That is a privacy-relevant action, so the user has to enable it explicitly; it must never happen quietly by default.
  vision: {
    enabled: false,
    // Which profile to tag with (empty = the currently active profile)
    providerId: '',
    // How many images to tag at most per run (cached by image URL, so a repeated image never costs twice)
    runLimit: 40,
    concurrency: 2,
    maxTokens: 300,
    timeoutMs: 60000,
    // Custom prompt (empty = the built-in one)
    prompt: '',
    // Whether to keep trying when the profile is marked as "no vision support"
    requireVisionModel: true,
  },
  // Multi-source same-event merging / similarity dedupe / source weights
  cluster: {
    enabled: true,
    // IDF-weighted Dice threshold: too low merges unrelated events (information gets swallowed), too high means nothing is ever merged
    threshold: 0.52,
    // Beyond this time gap it is not the same event (so last year's edition of the same event is not merged in)
    windowHours: 72,
  },
  // Static baseline for source weights (defaults per category), overridable here per source id
  // e.g. { "news-ann": 1.4, "community-reddit": 0.6 }
  sourceWeights: {},
  notify: {
    desktop: true,
    // The same content is pushed only once per N minutes (0 = no dedupe). Report titles tend to be identical every time,
    // so without dedupe it is pure harassment.
    dedupeMinutes: 0,
    // Quiet hours: notifications are **not dropped, but queued and delivered afterwards**.
    // Crossing midnight (23:00 -> 08:00) is the most common shape, and calendar.js / notify.js both treat
    // "start > end" as crossing midnight. start === end means quiet all day.
    // bypassLevels exempts urgent by default (time-sensitive notifications such as going live cannot wait);
    // a broken config fails open (push as usual), because "a typo makes every notification disappear" is far worse.
    quietHours: {
      enabled: false,
      start: '23:00',
      end: '08:00',
      days: 'all', // all | weekdays | weekend
      timeZone: '', // empty = follow calendar.timeZone / the system time zone
      bypassLevels: ['urgent'],
    },
    // [{ id, kind, name, enabled, on: always|alerts|failures, quiet: inherit|bypass,
    //    key, server, topic, token, secret, chatId, webhookUrl }]
    targets: [],
  },
  watch: {
    enabled: true,
    targets: [],
    rules: {
      largeEditBytes: 5000,
      largeDeleteBytes: 2000,
      newPage: true,
      anonymousEdit: true,
      unpatrolled: true,
      logTypes: ['delete', 'move', 'protect', 'block', 'rights', 'abusefilter', 'upload', 'import'],
      keywords: ['毕业', '卒業', '解约', '引退', '炎上', '休止', '终止', '解散', '独立', '移籍', '道歉', '声明'],
      maxEvents: 40,
    },
  },
  ui: {
    // Dark by default (user-specified). auto = follow the system; light only shows up when light is chosen explicitly,
    // because reading pushes / the intel stream at night is the main scenario, and dark is easier on the eyes.
    theme: 'dark', // auto | light | dark
    notify: true, // compatibility field — notify.desktop is the real one
    intelPerSource: 24,
    probeSamples: 3,
    probeTtlMinutes: 30,
    // Presentation layout for reports / intel (adjustable in the web UI; 'cards' lays each entry out as
    // a tile in a multi-column wall)
    layout: {
      mode: 'cards', // cards | list | compact | timeline | table
      columns: 'auto', // auto | 1 | 2 | 3 | 4
      density: 'comfortable', // comfortable | compact
      fontScale: 1, // 0.85 ~ 1.35
      showThumbs: true,
      showStats: true,
      showTime: true,
      showSource: true,
      accent: '', // empty = use the theme accent colour
    },
  },
  privacy: {
    // Anonymous mode: never use a login session at all (no reads of browser cookies, no reuse of a profile);
    // turning it on is the easiest route for the pre-publish self-check and for "anonymizing" scenarios.
    anonymousMode: false,
    // Whether to send request headers that may carry a site identity, such as Referer / Origin
    sendReferer: true,
  },
  // Anniversary / birthday / 3D debut / debut anniversary countdown
  calendar: {
    // empty = the system time zone. To watch a Japanese group, set Asia/Tokyo so "today" follows their clock.
    timeZone: '',
    // How many days ahead to remind by default (an entry can still override it)
    remindDaysBefore: 3,
    // How many days of upcoming anniversaries to list in the daily report
    reportDays: 30,
    entries: [],
  },
  paths: {
    reportsDir: 'reports',
    feedsDir: 'feeds',
    logsDir: 'logs',
    watchDir: 'watch',
    // Temporary file directory. Empty = the system temp dir (a sane generic default for a portable build).
    // This machine has a hard rule of "never write temp files to the C: drive", so the local config points at the E: drive.
    // Used for: the copy made while reading the browser cookie database, and fetches that need to drop temp files.
    tempDir: '',
    // Playwright browser engine directory. Empty = Playwright's default location
    // (on Windows that is %LOCALAPPDATA%\ms-playwright, i.e. the C: drive).
    // Point it at the E: drive to honour the rule; it is written into PLAYWRIGHT_BROWSERS_PATH at startup.
    browsersDir: '',
  },
  reports: {
    // Daily intel output format. html by default: VSCode previews it directly, no Markdown plugin needed.
    // html = a self-styled single-file web page / adoc = AsciiDoc / md = the old behaviour / json = structured
    // Besides the main file a .json source (with the raw markdown) is always written, for Word export / search / run-to-run comparison
    format: 'html',
    keepJsonSource: true,
  },
  sources: {
    // id -> { enabled: boolean, login: 'none'|'optional'|'required' }
  },
  // How a generated file is opened on this machine. Empty means "decide it here": VS Code (`code`) when it
  // is on PATH, otherwise the platform's own opener. The value is a program plus optional arguments, split
  // without a shell (see server/src/openfile.js) -- it is never a shell fragment.
  open: {
    editor: '',
  },
  // User-defined sources (added, edited and removed visually on the "sources" page)
  customSources: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge: fill in whatever the user config is missing from defaults */
export function mergeDefaults(user, defaults = DEFAULT_CONFIG) {
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  if (!isPlainObject(user)) return out;
  for (const [k, v] of Object.entries(user)) {
    out[k] = isPlainObject(v) && isPlainObject(defaults?.[k]) ? mergeDefaults(v, defaults[k]) : v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config durability: one file, three ways it can be there, and a write that cannot truncate it
//
// The v1.0.5 audit found the config being *silently replaced*. Both halves of that are here, because
// they are one defect seen at two moments:
//
//   · `loadConfig` returned `structuredClone(DEFAULT_CONFIG)` when the file was missing **and** when
//     `JSON.parse` threw, and the only difference between the two was `console.error`, which nobody
//     reads. A file damaged by a half-finished write, a killed editor or a stray byte therefore looked
//     exactly like a fresh install — and a fresh install is a state the user is *told* to expect.
//   · `saveConfig` wrote with a bare `writeFileSync`, which truncates the target first. An interrupted
//     write left a truncated file, so the damage that produced the silent fallback was itself easy to
//     produce. Worse, the next save then persisted the **defaults** over it: the user does not
//     experience "my settings look reset", they experience "the file that could have been repaired is
//     gone". That second step is why this is the sharpest of the three findings, and it is why the
//     damaged file is moved aside rather than read once and forgotten.
//
// So there are two rules in this section, and the rest is bookkeeping for them:
//
//   R1. **A damaged config is never silently replaced.** Missing is a normal first run and stays
//       silent; corrupt and unreadable are conditions. The damaged file is moved aside as
//       `config.json.broken-<stamp>`, the condition is recorded here, reported on `/api/config/health`
//       and logged until it is resolved.
//   R2. **A write can never leave a truncated config.** Everything goes to a temp file in the same
//       directory, is flushed with `fsync`, and only then replaces the target with one `rename`; the
//       previous good file is copied to `config.json.bak` first.
//
// Why the condition is reported by a route **of the app** and not by a file on disk: the damage is a
// property of the process that is running. A `.broken-` marker file would have to be found, and the
// user who needs it most is the one who never opens the app folder. The running app already has a
// place the pages poll (see the /api/config/health route in server/src/server.js), and it can say what
// the file's name is, whether a `.bak` exists, and what to do next.
// ─────────────────────────────────────────────────────────────────────────────

/** The four states a config can be in at load time. There is no fifth "unknown, carry on". */
export const CONFIG_STATES = ['fresh', 'ok', 'corrupt', 'unreadable'];

/** Where the previous good copy lives, and how a moved-aside damaged file is named. */
export const BAK_PATH = CONFIG_PATH + '.bak';
export const brokenPathFor = (stamp = new Date().toISOString()) => `${CONFIG_PATH}.broken-${stamp.replace(/[:.]/g, '-')}`;

/** The states that mean "something is wrong", i.e. the ones that must be visible until fixed. */
export const isConfigFault = (state) => state === 'corrupt' || state === 'unreadable';

/** Error codes that mean "we were not allowed to read it", as opposed to "its bytes are not JSON". */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EISDIR']);
const permissionProblem = (err) => PERMISSION_CODES.has(String(err?.code ?? ''));
const codeOf = (err) => String(err?.code ?? err?.name ?? 'error');

/**
 * The running process's view of the config file.
 *
 * `state` is the load result, and it is the *persistent* part: until a load or a repair says
 * otherwise, it keeps saying `corrupt`. `lastWrite` is separate on purpose — a save that succeeded
 * after a corrupt load must not be able to look like "there was never a problem", and a save that
 * *failed* (a read-only folder) must not be able to look like one that worked.
 */
const health = {
  state: 'fresh',
  at: null,
  events: [],
  writeCount: 0,
  writeFailures: 0,
  lastWrite: null,
  lastWriteError: null,
  log: null,
  lastLogged: '',
  lastProblem: null,
};

/**
 * The app's logger, injected once at startup (server/src/index.js). config.js cannot import
 * logger.js: the logger needs a directory from the config, so a direct import would be a cycle.
 */
export function setConfigHealthLogger(log) {
  health.log = log ?? null;
}

/**
 * Log a condition once, at the moment it is detected or retried. The dedupe key is the *condition*
 * (`state|code|file`), not the state alone: a second, differently-broken file is news, and a
 * per-write warning that repeats is how a real problem gets filtered out as noise.
 */
function logProblem(message, detail = {}) {
  const key = `${health.state}|${detail.code ?? ''}|${detail.movedTo ?? ''}|${detail.path ?? ''}`;
  if (key === health.lastLogged) return;
  health.lastLogged = key;
  health.lastProblem = { state: health.state, code: detail.code ?? null, at: new Date().toISOString() };
  const line = `[config] ${message}`;
  if (health.log) health.log.warn(line);
  // Before the logger exists (a load failure happens before the log directory is known) the run has
  // exactly one channel left, and staying quiet there is the behaviour being fixed.
  else console.error(line);
}

function recordEvent(kind, state, detail = {}) {
  const at = new Date().toISOString();
  health.state = state;
  health.at = at;
  health.events.push({ at, kind, state, ...detail });
  // Bounded: this is a ring of "what happened to my config recently", not an audit log. A run writes
  // the config on every settings save, so an unbounded list would grow for the life of the process.
  if (health.events.length > 20) health.events.splice(0, health.events.length - 20);
  return at;
}

/** What a caller (the health route, a test) is told. Never carries a config value, only filenames. */
export function configHealthSnapshot() {
  return {
    state: health.state,
    ok: health.state === 'ok' || health.state === 'fresh',
    fault: isConfigFault(health.state),
    at: health.at,
    path: CONFIG_PATH,
    backupPath: BAK_PATH,
    backupExists: fs.existsSync(BAK_PATH),
    lastWrite: health.lastWrite,
    lastWriteError: health.lastWriteError,
    writeCount: health.writeCount,
    writeFailures: health.writeFailures,
    // When the standing condition was last announced. A page that polls this route can tell "the same
    // fault, still standing" from "a new one", which is what makes the repeat visible instead of
    // repeating itself into the background.
    lastProblem: health.lastProblem,
    events: health.events.map((e) => ({ ...e })),
  };
}

/** Tests only: forget everything, including the file paths, which a fixture overrides at import. */
export function resetConfigHealthForTest(state = 'fresh') {
  health.state = state;
  health.at = null;
  health.events = [];
  health.writeCount = 0;
  health.writeFailures = 0;
  health.lastWrite = null;
  health.lastWriteError = null;
  health.lastLogged = '';
  health.lastProblem = null;
}

/**
 * Put the damaged file aside, under a name that keeps its bytes and its reason.
 *
 * Copy, then delete — not `rename`, although a rename is the tidier one-liner. The difference only
 * shows up on the machines this matters on: a file that cannot be deleted (Windows marks it read-only
 * when it is open in an editor, a folder ACL may forbid the delete) still has its bytes preserved by
 * the copy, and the copy is what the recovery below depends on. If the delete fails as well we keep
 * going and report `stillInPlace`, because the one thing that must not happen here is a load that
 * silently proceeds over a config we could not preserve.
 */
function moveAsideDamaged() {
  const movedTo = brokenPathFor();
  try {
    fs.copyFileSync(CONFIG_PATH, movedTo);
  } catch (err) {
    return { movedTo: null, stillInPlace: true, error: `could not preserve the damaged file: ${err.message}` };
  }
  let stillInPlace = false;
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {
    stillInPlace = true;
  }
  return { movedTo, stillInPlace, error: null };
}

/**
 * What the app runs on when the config file is not usable. It is a decision, not a fallback that
 * happens to look like one: continuing with defaults keeps a dashboard and a scheduler alive (a local
 * tool that refuses to start over one byte is worse than one that starts degraded and says so), and
 * the *record* kept above is what makes the difference visible. It is never written back without the
 * user asking — see `moveAsideDamaged` and the write path below.
 */
function defaultsOnFault() {
  return structuredClone(DEFAULT_CONFIG);
}

/**
 * Read the config file and say which of the three conditions it was in.
 *
 * A missing file is a genuine first run: defaults, no diagnostic, nothing written. It must not be
 * conflated with the two failures, which is why this no longer has a single `catch` around everything.
 */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    recordEvent('load', 'fresh', { note: 'no config file yet: this is a first run, not a fault' });
    return defaultsOnFault();
  }
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    // The file may well be perfectly good and we were simply not allowed to look. Running on
    // defaults is the only option here, but it is *reported* as what it is, and nothing is written:
    // a folder we cannot read in is a folder we must not write in either.
    const state = permissionProblem(err) ? 'unreadable' : 'corrupt';
    recordEvent('load', state, { code: codeOf(err), error: err.message, action: 'kept the file untouched' });
    logProblem(`config is ${state} (${codeOf(err)}): ${err.message}`, { code: codeOf(err), path: CONFIG_PATH });
    return defaultsOnFault();
  }
  try {
    const cfg = mergeDefaults(JSON.parse(text));
    recordEvent('load', 'ok', { bytes: Buffer.byteLength(text) });
    return cfg;
  } catch (err) {
    const aside = moveAsideDamaged(err);
    recordEvent('load', 'corrupt', {
      code: codeOf(err),
      error: err.message,
      movedTo: aside.movedTo,
      stillInPlace: aside.stillInPlace,
      preserveError: aside.error,
    });
    logProblem(
      aside.movedTo
        ? `config is not valid JSON (${err.message}) and was moved aside to ${path.basename(aside.movedTo)}; running on defaults`
        : `config is not valid JSON (${err.message}) and could not be moved aside; running on defaults`,
      { code: codeOf(err), movedTo: aside.movedTo, path: CONFIG_PATH }
    );
    return defaultsOnFault();
  }
}

/**
 * Run one fsync call, if the platform has it, and never let a refusal break the write. Returns null on
 * success and a short reason otherwise, so the snapshot can say whether the directory flush happened
 * instead of leaving the caller to guess from the absence of an error.
 */
function syncQuietly(what, run) {
  try {
    run();
    return null;
  } catch (err) {
    return `fsync of ${what} refused (${codeOf(err)})`;
  }
}

/**
 * The one way config text reaches the disk.
 *
 * Sequence, in this order and for these reasons:
 *   1. temp file **in the target's own directory** — a rename is only atomic within one filesystem,
 *      and a temp in the OS temp dir can silently degrade to copy+unlink, which is the truncation
 *      window this is here to close;
 *   2. write, then `fsync` the **file**, so the bytes are on the medium before anything points at
 *      them (otherwise a power loss can leave a correctly named file full of zeroes);
 *   3. copy the current file to `.bak` — the one step back, taken while the target is still good;
 *   4. `rename` over the target — the only step that is atomic, and the only step the outside world
 *      can observe;
 *   5. `fsync` the **directory**, so the rename itself survives a power loss. Not on Windows: opening
 *      a directory as a file and flushing it is refused (EPERM/EISDIR) there, and the refusal is
 *      recorded rather than thrown, because a rename that is already done must not be reported as a
 *      failed write.
 *
 * Any failure before the rename leaves the previous file exactly as it was, and the temp file is
 * removed in the `finally` — a failed write must not leave a partial file that the next start would
 * try to parse.
 */
export function writeConfigText(text) {
  const dir = path.dirname(CONFIG_PATH);
  let tmp = null;
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Unique per process: two processes that both rewrite the config (a second instance started by
    // hand) must not share one temp name, or one removes the other's file between its fsync and its
    // rename. The name stays in the same directory, which is the part the atomicity depends on.
    tmp = path.join(dir, `${path.basename(CONFIG_PATH)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, BAK_PATH);

    fs.renameSync(tmp, CONFIG_PATH);
    tmp = null;

    // The very first save of a fresh install has no previous file to copy, and that is exactly the
    // state a user is in on the day a config gets damaged by something else entirely. "Always one step
    // back" has to hold then too, so the backup is seeded from the file that was just written. It is
    // the same bytes as the config at that instant and therefore not a second opinion -- but it is a
    // readable file, and the day the config is truncated or half-synced it is the difference between a
    // repair and a rewrite.
    if (!fs.existsSync(BAK_PATH)) fs.copyFileSync(CONFIG_PATH, BAK_PATH);

    const dirSync = syncQuietly('the directory', () => {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    });

    health.writeCount++;
    health.lastWriteError = null;
    health.lastWrite = recordEvent('write', health.state, { bytes: Buffer.byteLength(text), dirSync });
    return { ok: true, bytes: Buffer.byteLength(text), path: CONFIG_PATH, dirSync };
  } catch (err) {
    health.writeFailures++;
    health.lastWriteError = { at: new Date().toISOString(), code: codeOf(err), error: err.message, path: CONFIG_PATH };
    recordEvent('write', health.state, { code: codeOf(err), error: err.message, failed: true });
    logProblem(`could not write ${path.basename(CONFIG_PATH)} (${codeOf(err)}): ${err.message}`, { code: codeOf(err), path: CONFIG_PATH });
    throw err;
  } finally {
    // The fd first: an unflushed handle on a file we are about to delete is how a temp file survives
    // on Windows (the delete is refused while the handle is open).
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the write has already failed; closing is best-effort */
      }
    }
    if (tmp !== null) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* leaving a .tmp behind is untidy; leaving a truncated config.json is the bug */
      }
    }
  }
}

export function saveConfig(cfg) {
  const merged = mergeDefaults(cfg);
  writeConfigText(JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Read the `.bak` copy back, as a candidate. Returns `{ ok, error, bytes }` — separating "the backup
 * is bad" from "the backup could not be read" is what lets the caller print a sentence a user can act
 * on rather than a stack trace.
 */
export function verifyBackup() {
  if (!fs.existsSync(BAK_PATH)) return { ok: false, error: `no ${path.basename(BAK_PATH)} to recover from`, bytes: 0 };
  try {
    const text = fs.readFileSync(BAK_PATH, 'utf8');
    JSON.parse(text);
    return { ok: true, error: null, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { ok: false, error: `${path.basename(BAK_PATH)} is not usable either: ${err.message}`, bytes: 0 };
  }
}

/**
 * Repair: put the `.bak` copy back as the config.
 *
 * Only for the two fault states, and deliberately **not automatic at startup**. Restoring a backup
 * without being asked is the same silent substitution this change exists to remove — the user would
 * watch their settings change and have no way to know why. An explicit call (the route, the button)
 * makes both the act and the timestamp visible.
 *
 * The target must be **absent** for this to do anything: a config.json that is already there is never
 * overwritten, including by its own backup. After a load fault the damaged file has been moved aside,
 * so this holds; and when it does not hold, refusing is the honest answer.
 */
export function recoverConfigFromBackup() {
  if (!isConfigFault(health.state)) {
    return { ok: false, error: `the config is not in a fault state (state: ${health.state}); nothing to recover` };
  }
  if (health.state === 'unreadable') {
    // A file we may not read is a file we may not replace with a copy of itself.
    return { ok: false, error: `the config is present but unreadable, so it is left alone: check the permissions of ${CONFIG_PATH}` };
  }
  if (fs.existsSync(CONFIG_PATH)) {
    return { ok: false, error: `${path.basename(CONFIG_PATH)} is in the way; it is never overwritten by a recovery` };
  }
  const check = verifyBackup();
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const text = fs.readFileSync(BAK_PATH, 'utf8');
    writeConfigText(text);
    const cfg = loadConfig(); // the state only becomes 'ok' if the restored file really parses
    recordEvent('recover', health.state, { bytes: check.bytes, from: BAK_PATH });
    return { ok: true, state: health.state, bytes: check.bytes, config: cfg };
  } catch (err) {
    return { ok: false, error: `recovery failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets: one redaction rule for every read, one restore rule for every write
//
// Why this is a *structure* and not a handful of `if (key) key = '***'` lines spread over the routes:
// `/api/config` used to answer with `getConfig()` verbatim, so `llm.providers[].apiKey` and a watch
// target's `botPassword` went out to whoever asked (a local process directly; a web page through DNS
// rebinding, which makes the call same-origin). The two endpoints that were fixed by hand first
// (`/api/llm/presets` masked `active` only; `/api/config/export` blanked three fields) each knew a
// different subset, and a *fourth* secret added later would have been visible on whichever endpoint
// nobody remembered to update.
//
// So the rule is declared **once**, by field name, and applied by walking the real config — never by a
// hand-maintained second copy of the config shape (a copy goes stale the moment a section is added, and
// the stale copy is the one that leaks).
//
// How a future secret field is meant to be marked:
//   · the default is "secret": any leaf whose name matches SECRET_NAME_RES is masked, at **any depth**,
//     inside objects and inside arrays. Adding e.g. `rtmpKey` to a new section therefore needs no code.
//   · a field that merely *looks* secret has to be declared non-secret in PUBLIC_FIELDS (its full path,
//     `[]` marking an array element) — an explicit list, so a name is never accidentally exempt just
//     because it is nested somewhere unusual.
//   · a masked value carries a `hasXxx` boolean next to it, so the UI can say "a key is set" without the
//     value having to travel.
//   · the same rule drives the write side (`preserveSecretStrings`): a masked or blank secret arriving in
//     a PUT/PATCH body means "unchanged", never "store this". Without that half, masking would silently
//     wipe the user's key the first time the settings page saved itself back.
// ─────────────────────────────────────────────────────────────────────────────

/** The redaction mark. '***' is what the LLM test/models routes already treated as "not a new value". */
export const SECRET_MASK = '***';

/**
 * Field *names* that are secret wherever they appear (case-insensitive, applied to the leaf key only).
 * `key`/`secret`/`token` are matched as suffixes or exact names, so `apiKey`, `controlSecret`,
 * `botPassword`, `webhookUrl`, `chatId` and `accessToken` are all covered without being enumerated.
 */
const SECRET_NAME_RES = [
  /(?:^|[a-z0-9])(?:apikey|secret|password|passwd|token|credential|privatekey|accesskey|signingkey)$/i,
  /^(?:key|secret|token|password|passwd|auth|authorization|cookie|cookies|session|jwt|passphrase)$/i,
  /(?:chatid|webhookurl|webhook)$/i,
];

/**
 * Paths that look like secrets but are not, so they are not turned into '***' (which would break a page
 * that needs the real value). Full path, `[]` for an array element, dot-separated.
 */
export const PUBLIC_FIELDS = ['share.images.inlineMaxBytes', 'share.images.maxPerBundle', 'share.images.maxPerPost'];

/** Field names that carry a *partially* readable secret: keep the origin, erase everything that authenticates. */
const PARTIAL_SECRET_RES = [/(?:webhookurl|webhook)$/i];

const isPlainObjectLoose = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flatten a declared path for comparison against the path built while walking (arrays are transparent). */
const flatPath = (p) => String(p).replace(/\[\]/g, '').split('.').filter(Boolean).join('.');

const PUBLIC_PATHS = new Set(PUBLIC_FIELDS.map(flatPath));

function matchesAny(res, name) {
  return res.some((r) => r.test(String(name)));
}

/** The shape of a masked field: a short value that is *deliberately* not the secret. */
export function isMaskedSecret(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '' || s === SECRET_MASK) return true;
  // The partial forms the notifier already used: 'https://host/***' and 'abcd***yz'.
  return /^\*+$/.test(s) || s.includes(SECRET_MASK);
}

/** Mask one value: for a webhook URL keep the origin (the page shows where it points), erase the rest. */
function maskValue(name, value) {
  if (!matchesAny(PARTIAL_SECRET_RES, name)) return SECRET_MASK;
  try {
    const u = new URL(String(value));
    return `${u.origin}${u.pathname && u.pathname !== '/' ? '/***' : '/'}${u.search ? '?***' : ''}`;
  } catch {
    // Not a URL: it is a bare secret (a Discord/Feishu hook id pasted without the scheme). Mask it whole,
    // never return the value "because it was not parseable".
    return SECRET_MASK;
  }
}

/**
 * Derive the client-facing config from the real one: every secret replaced by a masked form, with a
 * `hasXxx` boolean beside it. Deep by construction — the walk descends into nested objects and arrays, so
 * a secret one level down does not survive by being one level down.
 */
export function publicConfig(cfg) {
  const walk = (value, path, keyName) => {
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, `${path}[${i}]`, keyName));
    }
    if (isPlainObjectLoose(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const childPath = path ? `${path}.${k}` : k;
        if (isPlainObjectLoose(v) || Array.isArray(v)) {
          out[k] = walk(v, childPath, k);
          continue;
        }
        const declaredPublic = PUBLIC_PATHS.has(flatPath(childPath));
        if (!declaredPublic && matchesAny(SECRET_NAME_RES, k)) {
          // `hasXxx` is computed from the *real* value, before it is thrown away: the UI needs to know a
          // key is configured, and that is exactly the fact the mask alone cannot state once it is '***'
          // for both "set" and "cleared".
          out[`has${k[0].toUpperCase()}${k.slice(1)}`] = v !== undefined && v !== null && String(v) !== '';
          out[k] = v === undefined || v === null || String(v) === '' ? '' : maskValue(k, v);
          continue;
        }
        out[k] = v;
      }
      return out;
    }
    return value;
  };
  return walk(cfg ?? {}, '', '');
}

/**
 * The write-side half of the same rule: put the stored secret back wherever the body carries a masked or
 * blank secret. "A masked value sent back is not a new value" — the rule `/api/config/export` +
 * `/api/config/import` already lived by (an apiKey:'' in a redacted export must not wipe the stored key),
 * now applied to the whole config instead of only to the import merge.
 *
 * Which stored value is "the same field": for an object element carrying an `id` (an LLM provider, a watch
 * target, a notify destination) the entry with **that id**, and only falling back to the array position when
 * there is no id to match on. Matching by position alone was wrong in a way that matters: deleting one
 * provider and adding another in the same save made the new (empty) profile inherit the removed one's key.
 */
export function preserveSecretStrings(incoming, stored) {
  // `idMatched` says whether `cur` is known to be the same field as `inc`: the element carrying the same
  // `id`, or (when there is no id to match on) the element at the same position. A fallback to a *different*
  // entry is how a newly added profile came out holding a neighbour's key, so an unmatched entry is treated
  // as "nothing stored", never as "use whatever is at this index".
  const walk = (inc, cur, path, keyName, idMatched = true) => {
    if (Array.isArray(inc)) {
      // The elements inherit the array field's name: the rule is decided by the field name, and an array
      // element has none of its own. Losing it here is what made a masked provider key overwrite the stored
      // one — the element was judged as "a value with no name", so the secret rule never applied to it.
      const curList = Array.isArray(cur) ? cur : [];
      const byId = new Map(curList.filter((x) => isPlainObjectLoose(x) && typeof x.id === 'string').map((x) => [x.id, x]));
      return inc.map((v, i) => {
        const hasId = isPlainObjectLoose(v) && typeof v.id === 'string';
        const same = hasId ? byId.get(v.id) : undefined;
        const positional = curList[i];
        const positionalMatches = !hasId || (isPlainObjectLoose(positional) && positional?.id === v.id);
        return walk(v, same ?? (positionalMatches ? positional : undefined), `${path}[${i}]`, keyName, !!same || positionalMatches);
      });
    }
    if (isPlainObjectLoose(inc)) {
      const curObj = isPlainObjectLoose(cur) && idMatched ? cur : {};
      const out = {};
      for (const [k, v] of Object.entries(inc)) {
        const childPath = path ? `${path}.${k}` : k;
        // `hasXxx` is derived output, not a setting: dropping it here keeps the stored config from
        // growing a copy of the redaction metadata on every save.
        if (/^has[A-Z]/.test(k) && !(k in curObj)) continue;
        out[k] = walk(v, curObj[k], childPath, k, true);
      }
      return out;
    }
    if (keyName && !PUBLIC_PATHS.has(flatPath(path)) && matchesAny(SECRET_NAME_RES, keyName) && isMaskedSecret(inc)) {
      return typeof cur === 'string' && cur !== '' ? cur : inc;
    }
    return inc;
  };
  return walk(incoming, stored, '', '');
}

/**
 * Every string leaf in an object, with its path. This is the *checker*, deliberately independent of
 * `publicConfig`: a detector that reused the serialiser's own rules could only ever confirm that the
 * serialiser agrees with itself. A test hands it the known plaintext and requires zero hits, which is
 * the statement "this response does not contain the secret".
 */
export function stringLeaves(obj, path = '', out = {}) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => stringLeaves(v, `${path}[${i}]`, out));
    return out;
  }
  if (isPlainObjectLoose(obj)) {
    for (const [k, v] of Object.entries(obj)) stringLeaves(v, path ? `${path}.${k}` : k, out);
    return out;
  }
  if (obj !== undefined && obj !== null) out[path || '$'] = String(obj);
  return out;
}

/** Resolve a configured dir to an absolute path */
export function resolveDir(cfg, key) {
  const rel = cfg?.paths?.[key] ?? DEFAULT_CONFIG.paths[key] ?? key;
  return path.isAbsolute(rel) ? rel : path.join(APP_ROOT, rel);
}

/**
 * Upgrade the old flat config into the new shape on first save.
 * Only called when actually writing to disk; reading config never touches the file.
 */
export function migrateConfig(cfg) {
  const next = mergeDefaults(cfg);

  // ── LLM: flat -> profile list
  const llm = next.llm ?? {};
  if (!Array.isArray(llm.providers) || llm.providers.length === 0) {
    if (llm.apiKey || (llm.baseUrl && llm.baseUrl !== DEFAULT_CONFIG.llm.baseUrl)) {
      next.llm = {
        ...llm,
        providers: [
          {
            id: 'default',
            preset: 'custom',
            name: '默认',
            baseUrl: llm.baseUrl ?? '',
            apiKey: llm.apiKey ?? '',
            model: llm.model ?? '',
            models: llm.model ? [llm.model] : [],
            reasoningEffort: llm.reasoningEffort ?? '',
            maxTokens: llm.maxTokens ?? 8192,
            temperature: llm.temperature ?? 0.3,
          },
        ],
        activeId: 'default',
      };
    }
  }
  if (Array.isArray(next.llm?.providers) && next.llm.providers.length && !next.llm.activeId) {
    next.llm.activeId = next.llm.providers[0].id;
  }

  // ── schedule: flat -> task list
  const sched = next.schedule ?? {};
  if (!Array.isArray(sched.tasks) || sched.tasks.length === 0) {
    if (sched.enabled) {
      next.schedule = {
        ...sched,
        tasks: [
          {
            id: 'task-1',
            name: sched.mode === 'daily' ? '每天情报收集' : '每周情报收集',
            enabled: true,
            mode: 'daily',
            freq: sched.mode === 'daily' ? 'daily' : 'weekly',
            dayOfWeek: Number.isInteger(sched.dayOfWeek) ? sched.dayOfWeek : 2,
            time: sched.time ?? '23:30',
            catchUp: true,
          },
        ],
      };
    }
  }

  // ── desktop notification switch moved: ui.notify -> notify.desktop
  if (next.notify && next.ui && next.ui.notify === false && next.notify.desktop === DEFAULT_CONFIG.notify.desktop) {
    next.notify = { ...next.notify, desktop: false };
  }

  return next;
}
