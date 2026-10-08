// watch.js — watch targets / watch targets
//
// The design borrows the watch techniques from Moegirlpedia (MediaWiki's watchlist-brief and
// recent-changes-brief): upgrade "did it change" into "what changed, how much changed, is it worth reading".
//
// Four kinds of watch targets:
//   url                    any web page/API: fetch body -> normalize -> hash baseline -> line-level diff
//   mediawiki-page         revisions of a given page: revid comparison + the compare API for the diff
//   mediawiki-recentchanges the recent-changes stream: filter out the changes worth attention by rule
//   mediawiki-watchlist    the watchlist after logging in: requires BotPassword (stored locally only)
//
// Alarm rules (copied from that Moegirlpedia set, thresholds configurable):
//   large edit / large delete / new page / anonymous edit / unpatrolled / specific log types / suspicious keywords
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, resolveDir } from './config.js';
import { netFetch, resolveProxyMode } from './net.js';
import { gapWithJitter } from './observe.js';
import { remoteUrlShapeProblem, validateRemoteUrl } from './remote-url.js';
import { setTimeout as sleep } from 'node:timers/promises';

// ─────────────────────────────────────────────────────────────────────────────
// The User-Agent this module sends: two values, because there are two callers
//
// What the audit found: one module constant
//
//     const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
//                 Chrome/126.0.0.0 Safari/537.36';
//
// used by **every** request this module makes, with nothing anywhere saying whether `126` meant anything. It
// did not. The string was a copy of the one the RSS fetcher carries (server/src/fetchers/rss.js) and it dated
// from when the product rendered with Chromium; it went stale the moment the engine became Playwright Firefox
// in v1.0.4, and it went stale silently, because a version number in a header is read by nobody.
//
// The callers do not want the same thing, and saying so is the fix:
//
//   • A **MediaWiki API** request is not a browser. It fetches `api.php?…&format=json` — one JSON document, and
//     no wiki serves a different one to a non-browser. What an operator wants from a UA is a name they can look
//     up, throttle or contact, which is what the `VML/<version>` product token is for. It is also the honest
//     thing to send when the request carries a `BotPassword` credential (see `buildWikiLoginRequest` below):
//     claiming to be somebody's browser while using their account is a claim that cannot be backed up.
//
//   • A **web page** (`kind: 'url'`) is a page, and may well serve something different to a non-browser. This
//     module is deliberately *not* the browser engine — that is server/src/fetchers/browser.js, which renders
//     through Playwright Firefox and sends that engine's own truthful UA — so for a plain HTTP GET the least
//     surprising thing to send is a browser token, and the engine this product actually drives is Firefox.
//
// Neither value pins a version, and that is the point of the change rather than an implementation detail. The
// version of the rendering engine lives in the Playwright payload and moves with it; a number typed here would
// be wrong on the next release and nothing would notice, which is exactly how the string above became a lie.
// A sentinel is used (`rv:0.0`) so that "this browser token makes no version claim" is visible to anyone
// reading the header, rather than looking like a version somebody forgot to update.
//
// Scope: the audit named this module. The same Chrome/126 literal also lives in
// server/src/fetchers/rss.js, server/src/fetchers/mediawiki.js, server/src/probe.js and server/src/thumbs.js,
// and those are **not** changed here (they are outside this change's surface and one of them is the mediawiki
// fetcher that another change in this release owns). The rule stated above is what they should follow; the
// duplication is recorded rather than quietly half-fixed. tools/watch-ua-test.mjs asserts that this module no
// longer carries a versioned Chrome literal, and names the remaining sites so the next reader finds them.
// ─────────────────────────────────────────────────────────────────────────────

/** The package version, read once, for the product token. Never used as a claim about an engine. */
const PRODUCT_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    // An unreadable package.json must not stop a watch run, and 0.0.0 is obviously not a version claim.
    return '0.0.0';
  }
})();

/**
 * The User-Agent for the MediaWiki API requests: a product token, not a browser.
 *
 * This is the shape MediaWiki's own User-Agent policy asks for, and it survives a version bump because the
 * version is read from package.json at runtime instead of being typed into a string here.
 */
export const API_UA = `VtuberMonitorLink/${PRODUCT_VERSION} (+watch-target; MediaWiki API)`;

/**
 * The User-Agent for `kind: 'url'` page fetches: a Firefox token with an explicit **no-version** sentinel.
 *
 * Why Firefox and not Chrome: the engine this product drives is Playwright Firefox (v1.0.4 onward), so saying
 * Firefox is the true statement about what is at the other end. Why `rv:0.0`: see the block above — the version
 * belongs to the engine, and copying it here is the rot this change removes.
 */
export const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:0.0) Gecko/20100101 Firefox/0.0';

export const TARGET_KINDS = [
  { id: 'url', zh: '任意网页', en: 'Any web page', login: 'none' },
  { id: 'mediawiki-page', zh: 'MediaWiki 条目', en: 'MediaWiki page', login: 'none' },
  { id: 'mediawiki-recentchanges', zh: 'MediaWiki 最近更改', en: 'MediaWiki recent changes', login: 'none' },
  { id: 'mediawiki-watchlist', zh: 'MediaWiki 监视列表', en: 'MediaWiki watchlist', login: 'required' },
];

/** Fields a watch target may carry (an allowlist, so the front end cannot write arbitrary things into the config) */
export const TARGET_FIELDS = [
  'id',
  'kind',
  'label',
  'enabled',
  'url',
  'proxy',
  'mode',
  'ignorePatterns',
  'apiUrl',
  'page',
  'namespaces',
  'limit',
  'username',
  'botPassword',
  'executablePath',
  'profileDir',
  // The explicit, per-target allowance for the loopback rule (see server/src/remote-url.js). Off unless it is
  // written on the target itself: the traversals' watch fixture is on 127.0.0.1, and nothing else should be.
  'allowLoopback',
];

export function sanitizeTarget(input = {}, index = 0) {
  const out = {};
  for (const k of TARGET_FIELDS) if (input[k] !== undefined) out[k] = input[k];
  out.kind = TARGET_KINDS.some((k) => k.id === out.kind) ? out.kind : 'url';
  out.id = String(out.id ?? `target-${index + 1}`)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 60);
  out.label = String(out.label ?? out.url ?? out.page ?? out.uid ?? out.id).slice(0, 120);
  out.enabled = out.enabled !== false;
  if (Array.isArray(out.ignorePatterns)) out.ignorePatterns = out.ignorePatterns.filter((x) => typeof x === 'string').slice(0, 50);
  if (Array.isArray(out.namespaces)) out.namespaces = out.namespaces.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (out.limit !== undefined) out.limit = Math.max(1, Math.min(500, Number(out.limit) || 50));
  // The allowance is a boolean or it is absent: a string 'false' from a hand-written request must not read as
  // "on". Then the addresses this target can carry are checked for shape, at store time, for the same reason
  // the sources sanitiser does it — a target that can never be fetched is a setting that looks like it works.
  // Only the synchronous half runs here (scheme, userinfo, an address literal); a name is judged where it is
  // resolved, which is the only place the answer is current.
  if (out.allowLoopback !== undefined) out.allowLoopback = out.allowLoopback === true;
  const policy = { allowLoopback: out.allowLoopback === true };
  delete out.urlProblem;
  for (const key of ['url', 'apiUrl']) {
    if (out[key] === undefined) continue;
    const problem = remoteUrlShapeProblem(out[key], policy);
    if (problem) out.urlProblem = { field: key, code: problem.code, reason: problem.reason };
  }
  return out;
}

export const DEFAULT_RULES = {
  largeEditBytes: 5000,
  largeDeleteBytes: 2000,
  newPage: true,
  anonymousEdit: true,
  unpatrolled: true,
  logTypes: ['delete', 'move', 'protect', 'block', 'rights', 'abusefilter', 'upload', 'import'],
  keywords: ['毕业', '卒業', '解约', '引退', '炎上', '休止', '终止', '解散', '独立', '移籍', '道歉', '声明'],
  maxEvents: 40,
};

// ───────────────────────────────────────────── storage / storage

export function watchDir(cfg) {
  const dir = resolveDir(cfg, 'watchDir');
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  return dir;
}

function baselinesPath(cfg, id) {
  if (id) return path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.baseline.json`);
  return path.join(watchDir(cfg), 'baselines.json');
}

export function sanitizeId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'target';
}

// ─────────────────────────────────────────────────────────────────────────────
// The baseline: three ways it can be missing, and only two of them are "no baseline"
//
// The v1.0.5 audit found this shape:
//
//     export function getBaseline(cfg, id) {
//       const f = baselinesPath(cfg, id);
//       try {
//         if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
//       } catch {
//         /* corrupt file: treat as absent */
//       }
//       return null;
//     }
//
// One `catch` covering two different facts, and the comment states the decision that is wrong: a **damaged**
// baseline is treated as one that was never there. The consequence is not a hiccup, it is the opposite of what a watch
// feature is for — the run silently rebuilds the baseline from the *current* content of the page, so the
// first comparison after the damage is against bytes that were written a moment ago. Nothing can be
// reported, the target looks quiet, and the change that happened during the damage is the one change that
// can never be reported again. The damaged file is also gone in the sense that matters: the next check
// writes over it, so the evidence cannot be looked at afterwards.
//
// config.js settled the same question for its own file (see the "Config durability" block there), and the
// rule is followed here rather than invented again:
//
//   missing     -> 'first-run'    a genuine first check of this target. Initialize silently, no diagnostic:
//                                 this is the state every new watch target is in, and making it a warning
//                                 would train the reader to ignore the warning that matters.
//   not JSON    -> 'corrupt'      the damaged file is **copied aside** as `<id>.baseline.json.corrupt-<stamp>`
//                                 and reported (`fault: true`); the target's baseline is then rebuilt in the
//                                 same pass that reports the damage, so a watch does not stop working over it.
//                                 The rebuild writes the new baseline *and* the preserved copy keeps the old
//                                 bytes, which is what makes "what did I miss" answerable by hand afterwards.
//   unreadable  -> 'unavailable'  the file is there and we were not allowed to look (EACCES/EPERM/EISDIR).
//                                 Nothing is written: a file we may not read is a file we may not replace —
//                                 and this is the state where writing would be most likely to destroy
//                                 something, for the same reason config.js refuses to recover over it.
//   parses      -> 'ok'
//
// Where the condition is *visible*: on the running process (this module's `baselineHealthSnapshot`, served
// by GET /api/watch, in the same way config.js serves /api/config/health), and in the run report — every
// check result carries a `baseline` field, and the run's `lastResult` carries the whole picture. A log line
// alone was the failure: it scrolls past in a run that also prints twenty other lines.
// ─────────────────────────────────────────────────────────────────────────────

/** The four states a baseline can be in at read time. There is no fifth "unknown, carry on". */
export const BASELINE_STATES = ['ok', 'first-run', 'corrupt', 'unavailable'];

/** The states that mean "something is wrong", i.e. the ones that stay visible until they are dealt with. */
export const isBaselineFault = (state) => state === 'corrupt' || state === 'unavailable';

/** Error codes that mean "we were not allowed to read it", as opposed to "its bytes are not JSON". */
const BASELINE_PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'EISDIR']);

/**
 * The one sentence each fault state is reported with, **never** the error message itself.
 *
 * This is not tidiness. A `JSON.parse` failure in current node quotes the offending input — the message is
 * literally `Unexpected token 'o', "nope{" is not valid JSON` — and a baseline file holds a page's text or a
 * wiki title. Echoing the parse message into the record that `GET /api/watch` serves would put a slice of the
 * user's own watched content on a route, which is the same class of mistake as echoing a config secret. The
 * raw message goes to the log, where it is wanted and where it stays; the record says which state the file
 * is in, which is what the reader needs in order to act.
 */
const BASELINE_ERROR_REASONS = {
  corrupt: 'the baseline is not valid JSON',
  unavailable: 'the baseline could not be read (permissions or an unreadable path)',
};
const baselineCodeOf = (err) => String(err?.code ?? err?.name ?? 'error');

/** Where a damaged baseline is preserved. Same stamp shape as config.js's `brokenPathFor`. */
export const corruptBaselinePathFor = (file, stamp = new Date().toISOString()) =>
  `${file}.corrupt-${stamp.replace(/[:.]/g, '-')}`;

/**
 * The process's view of the baselines.
 *
 * `faults` is keyed by **file path**, and that is the part that makes the state persistent in the way the
 * problem needs: a corrupt file that was repaired and then read fine on the next check is `ok` again; a file
 * that is unreadable stays in this map until it is not, so a rebuild that could not happen is not forgotten
 * between two runs.
 */
const baselineHealth = {
  events: [],
  /** Per baseline file: what the most recent read *or write* of it said. This is what the route and the
   *  report read, and it is the single record the fault states are derived from. */
  reports: new Map(),
  log: null,
  lastLogged: '',
};

/**
 * The app's logger, injected once at startup (server/src/index.js).
 *
 * Injected rather than imported for the reason config.js states for the same arrangement: logger.js writes
 * to a directory the config names, so importing it here would be a cycle (config.js -> logger.js -> config).
 */
export function setBaselineHealthLogger(log) {
  baselineHealth.log = log ?? null;
}

/**
 * Log a standing condition **once**, and again only when the condition itself changes. The dedupe key is
 * `state|file|code`, not the state alone: a second, differently-damaged baseline is news, and a warning
 * repeated on every check is how a real problem gets filtered out as noise.
 */
function logBaselineProblem(message, detail = {}) {
  const key = `${detail.state ?? ''}|${detail.file ?? ''}|${detail.code ?? ''}`;
  if (key === baselineHealth.lastLogged) return;
  baselineHealth.lastLogged = key;
  const line = `[watch] ${message}`;
  if (baselineHealth.log?.warn) baselineHealth.log.warn(line);
  else console.error(line);
}

function recordBaselineEvent(kind, state, detail = {}) {
  const at = new Date().toISOString();
  baselineHealth.events.push({ at, kind, state, ...detail });
  // Bounded: this is a ring of "what happened to my baselines lately", not an audit log. A run reads one
  // baseline per target per check, so an unbounded list would grow for the life of the process.
  if (baselineHealth.events.length > 20) baselineHealth.events.splice(0, baselineHealth.events.length - 20);
  // The per-file picture the route and the report read. Kept apart from the event ring on purpose: the ring
  // answers "what happened recently", this answers "what is the state of this file now", and a check that
  // wants the second question answered must not have to scan the first.
  if (detail.file) {
    const prev = baselineHealth.reports.get(detail.file) ?? {};
    baselineHealth.reports.set(detail.file, { ...prev, ...detail, state, kind, at });
  }
  return at;
}

/**
 * One record as it may be served: everything except the raw diagnostic message.
 *
 * Written as its own function so "no baseline content leaves this module" is a property a reader and a test can
 * point at, rather than a rule three call sites have to remember.
 */
function servedRecord(record) {
  const { logError, ...safe } = record ?? {};
  void logError;
  return safe;
}

/**
 * What a caller (the watch route, the run report, a test) is told. Never carries baseline content, only the
 * states, the file names and what to do next — the same rule as `configHealthSnapshot`.
 */
export function baselineHealthSnapshot() {
  // Everything that leaves here goes through `servedRecord`: a read failure's raw message is kept on the
  // record as `logError` for the log, and it quotes the file's own bytes (a JSON syntax error says
  // `Unexpected token 'o', "nope{" is not valid JSON`). This answer is served by `GET /api/watch`, and a
  // baseline file holds a page's text or a wiki title — so the one field is stripped here, at the single
  // boundary every served shape passes through, rather than being remembered at each of the three.
  const reports = [...baselineHealth.reports.values()].map(servedRecord);
  const faults = reports.filter((r) => isBaselineFault(r.state));
  return {
    // The one question a reader of this field has: "do I have to do something". A target that has never been
    // checked is not a fault, and neither is a first run; only the two damaged states are.
    state: faults.some((f) => f.state === 'unavailable') ? 'unavailable' : faults.length ? 'corrupt' : 'ok',
    fault: faults.length > 0,
    // The files that are still in a fault state, with the place the damaged bytes were preserved and what to
    // do next. Same shape and same restraint as `configHealthSnapshot`: states and file names, never content.
    faults: faults.map((f) => {
      const r = servedRecord(f);
      return {
        file: r.file,
        state: r.state,
        at: r.at,
        code: r.code ?? null,
        error: r.error ?? null,
        movedTo: r.movedTo ?? null,
        stillInPlace: !!r.stillInPlace,
        preserveError: r.preserveError ?? null,
        note: r.note ?? null,
      };
    }),
    reports,
    // The ring is mapped, not spread: a read failure's raw message is kept on the event as `logError` for the
    // log, and it quotes the file's own bytes (a JSON syntax error says `Unexpected token 'o', "nope{" is not
    // valid JSON`). What goes out on the route is the state, the file name and where the bytes were preserved.
    events: baselineHealth.events.map(servedRecord),
  };
}

/**
 * Forget everything. Tests only: the work directory is a fixture, and one case's damage must not colour the
 * next case's state.
 */
export function resetBaselineHealthForTest() {
  baselineHealth.events = [];
  baselineHealth.reports.clear();
  baselineHealth.lastLogged = '';
}

/**
 * Read a baseline and say which of the four conditions it was in.
 *
 * This is the one place the file is interpreted; `getBaseline` below is kept as the shape the existing
 * callers use (a baseline or null) so that every handler's "is there a previous value" test stays a
 * one-liner, and the *reason* travels separately in the result rather than having to be re-derived.
 *
 * @returns {{state:'ok'|'first-run'|'corrupt'|'unavailable', data:object|null, file:string,
 *            movedTo?:string|null, stillInPlace?:boolean, code?:string, error?:string}}
 */
export function readBaseline(cfg, id) {
  const file = baselinesPath(cfg, id);
  if (!fs.existsSync(file)) {
    // The deliberate non-alarm: a genuine first check, recorded as such and nothing else. Making this a
    // warning (or, worse, reporting it as damage) is what the control in tools/watch-baseline-test.mjs
    // exists to prevent.
    recordBaselineEvent('read', 'first-run', { file, note: 'no baseline file yet: this is a first check, not a fault' });
    return { state: 'first-run', data: null, file };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const state = BASELINE_PERMISSION_CODES.has(baselineCodeOf(err)) ? 'unavailable' : 'corrupt';
    const code = baselineCodeOf(err);
    // The message is logged, and it is **not** put in the record that the route serves. A read error's
    // message can quote the file's own bytes (a JSON syntax error says `"<snippet>" is not valid JSON`), and
    // these files carry page text and wiki titles — the same class of thing the config snapshot refuses to
    // echo for its own file. The snapshot describes the *condition*; the log keeps the diagnosis.
    const detail = {
      file,
      code,
      error: BASELINE_ERROR_REASONS[state] ?? BASELINE_ERROR_REASONS.corrupt,
      action: 'left exactly where it is',
      note:
        state === 'unavailable'
          ? 'the file is present but the process was not allowed to read it, so nothing was written: a file we may not read is a file we may not replace'
          : 'the file could not be read, so nothing was written',
    };
    recordBaselineEvent('read', state, { ...detail, logError: err.message });
    logBaselineProblem(
      `baseline ${path.basename(file)} is ${state} (${code}): ${err.message} — nothing was written, so this target keeps reporting the condition instead of quietly re-baselining`,
      { ...detail, state }
    );
    return { state, data: null, code, error: err.message, file };
  }
  try {
    const data = JSON.parse(text);
    recordBaselineEvent('read', 'ok', { file, bytes: Buffer.byteLength(text) });
    return { state: 'ok', data, file };
  } catch (err) {
    // Preserve, then report. The copy is what makes this different from the old behaviour: after the run
    // the damaged bytes are still on disk under their own name, so "what changed while the baseline was
    // broken" can be answered by hand even though the automated answer is gone.
    const movedTo = corruptBaselinePathFor(file);
    let stillInPlace = false;
    let preserveError = null;
    try {
      fs.copyFileSync(file, movedTo);
    } catch (e) {
      preserveError = `could not preserve the damaged baseline: ${e.message}`;
    }
    if (!preserveError) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Copy, then delete — not `rename`, for the reason config.js gives for the same choice: a file that
        // cannot be deleted (read-only in an editor, a folder ACL) still has its bytes preserved by the
        // copy, and the copy is what a person repairs from.
        stillInPlace = true;
      }
    }
    const code = baselineCodeOf(err);
    // Same restraint as above, and it matters more here: a JSON syntax error quotes the file's bytes, and this
    // file is a page's text. The parse message goes to the log; the record says what state it is in and where
    // the damaged bytes went, which is what the reader needs in order to act.
    const detail = {
      file,
      code,
      error: BASELINE_ERROR_REASONS.corrupt,
      movedTo: preserveError ? null : movedTo,
      stillInPlace,
      preserveError,
      // What the reader has to understand: the rebuild below is real, but it cannot report the change that
      // happened while the file was broken. That change is preserved in the copy, not in the next diff.
      note: 'the baseline was rebuilt from the current content, so the first comparison after this cannot be a diff of what was missed',
    };
    // `logError` is the raw message and is deliberately *not* part of what the route serves: it quotes the
    // file's bytes (see BASELINE_ERROR_REASONS). The snapshot strips it, and the log below keeps it.
    recordBaselineEvent('read', 'corrupt', { ...detail, logError: err.message });
    logBaselineProblem(
      preserveError
        ? `baseline ${path.basename(file)} is not valid JSON (${err.message}) and could not be preserved: ${preserveError} — it will be rebuilt, and the damaged bytes are gone`
        : `baseline ${path.basename(file)} is not valid JSON (${err.message}); the damaged file was kept as ${path.basename(detail.movedTo)} (${stillInPlace ? 'the original could not be removed and is still in place' : 'and removed'}) and the baseline will be rebuilt`,
      { ...detail, state: 'corrupt' }
    );
    return { state: 'corrupt', data: null, movedTo: detail.movedTo, stillInPlace, code, error: err.message, file };
  }
}

/**
 * The baseline for one target, or `null` when there is nothing usable to compare against.
 *
 * `null` is returned for 'first-run' **and** for the two fault states, because the caller's question here is
 * only "is there a previous value" — the difference between them is a property of the *check result*, not of
 * this return value, and it is reported through `ctx.baselineState` / the result's `baseline` field, which
 * every handler's caller can read. Folding the two into one silent `null` here and nowhere stating it is
 * exactly the defect.
 */
export function getBaseline(cfg, id) {
  const r = readBaseline(cfg, id);
  return r.data ?? null;
}

export function setBaseline(cfg, id, data) {
  const f = baselinesPath(cfg, id);
  // A baseline we were not allowed to read is not replaced. This is the same rule config.js applies to an
  // unreadable config, and it is the state where a write does the most damage: the file may be perfectly
  // good and merely locked, and overwriting it loses whatever it held.
  const standing = baselineHealth.reports.get(f);
  if (standing?.state === 'unavailable') {
    logBaselineProblem(
      `baseline ${path.basename(f)} is present but unreadable, so it is left alone: no new baseline was written for ${id} (fix the permissions, or delete the file to start over)`,
      { state: 'unavailable', file: f, code: standing.code }
    );
    return null;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  // A successful write is what clears a corrupt state (the damaged bytes are already preserved elsewhere by
  // then). An `unavailable` one is not cleared by a write, because there was no write.
  recordBaselineEvent('write', 'ok', { file: f, target: id });
  return data;
}

export function allBaselines(cfg) {
  const dir = path.join(watchDir(cfg), 'history');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(.+)\.baseline\.json$/.exec(f);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function appendHistory(cfg, id, entry) {
  const f = path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

export function readHistory(cfg, id, limit = 50) {
  const f = path.join(watchDir(cfg), 'history', `${sanitizeId(id)}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
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

// ───────────────────────────────────────────── text / text

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeText(text, ignorePatterns = []) {
  let lines = String(text ?? '').split(/\r?\n/);
  const res = ignorePatterns
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (res.length) lines = lines.filter((l) => !res.some((re) => re.test(l)));
  return lines.join('\n').trim();
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

function truncate(s, max = 200_000) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}\n…（已截断，原文 ${t.length} 字符）` : t;
}

// ───────────────────────────────────────────── alarm rules / alarm rules

/**
 * Apply the alarm rules to one change
 * @returns {{alert:boolean, reasons:string[]}}
 */
export function applyRules(change, rules = DEFAULT_RULES) {
  const reasons = [];
  const r = { ...DEFAULT_RULES, ...(rules ?? {}) };

  if (typeof change.delta === 'number') {
    if (change.delta <= -Math.abs(r.largeDeleteBytes ?? 0)) reasons.push(`大量删除 ${-change.delta} 字节`);
    else if (change.delta >= Math.abs(r.largeEditBytes ?? 0)) reasons.push(`大量新增 ${change.delta} 字节`);
  }
  if (r.newPage && change.isNew) reasons.push('新建页面');
  if (r.anonymousEdit && change.anon) reasons.push('匿名用户编辑');
  if (r.unpatrolled && change.unpatrolled) reasons.push('未巡查编辑');
  if (change.logType && (r.logTypes ?? []).includes(change.logType)) reasons.push(`日志：${change.logType}`);

  const hay = `${change.comment ?? ''} ${change.title ?? ''} ${change.text ?? ''}`.toLowerCase();
  const hit = (r.keywords ?? []).filter((k) => k && hay.includes(String(k).toLowerCase()));
  if (hit.length) reasons.push(`关键词：${hit.join('、')}`);

  return { alert: reasons.length > 0, reasons };
}

// ───────────────────────────────────────────── per-kind checks / checks

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

/**
 * The policy object for one watch target: the single place its allowance is read, so an added request path
 * cannot forget it. `skipDns` is left to net.js, which is the one that knows which egress will be used.
 */
export function targetPolicy(target = {}) {
  return { allowLoopback: target?.allowLoopback === true };
}

/**
 * The profile for one request.
 *
 * The decision belongs here, next to the code that makes the request, rather than being imported from a
 * constant that names no caller: `kind === 'url'` is a page and gets the page profile; every other kind talks
 * to `api.php` and gets the product token. Written as a function of the *target* rather than of the URL so that
 * "which profile does this request use" is answerable without reading the string.
 */
export function userAgentFor(target = {}) {
  return target?.kind === 'url' ? PAGE_UA : API_UA;
}

async function jget(url, { cfg, target, timeout = 25000, headers } = {}) {
  const r = await netFetch(
    url,
    {
      headers: {
        'user-agent': userAgentFor(target),
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(headers ?? {}),
      },
      signal: withTimeout(timeout),
    },
    { cfg, subject: target, policy: targetPolicy(target) }
  );
  return r;
}

function apiOf(apiUrl) {
  const u = String(apiUrl ?? '').trim();
  if (!u) throw new Error('缺少 apiUrl / missing apiUrl');
  return u.includes('?') ? `${u}&format=json` : `${u}?format=json`;
}

// ── 1) Any web page
async function checkUrl(target, ctx) {
  // The baseline is read **first**, before the address check inside `jget` and before the network. The state
  // of the baseline is a fact about this check whatever else happens to it, and reading it here is what puts
  // that fact on the result of a check that never reached the page — the case where a reader most needs to
  // know that the comparison half is unavailable too. Reading it late is how "the baseline was damaged" became
  // a property of "everything else went well", which is the wrong way round. It is also the order the words
  // suggest: read what we are comparing against, then go and fetch.
  const prev = baselineFor(target, ctx);
  const r = await jget(target.url, { cfg: ctx.cfg, target });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const raw = await r.text();
  const text = truncate(normalizeText(target.mode === 'html' ? raw : stripHtml(raw), target.ignorePatterns));
  const hash = sha256(text);

  if (!prev) {
    setBaseline(ctx.cfg, target.id, { kind: 'url', hash, text, url: target.url });
    return { target, first: true, changed: false, events: [], summary: '已建立基线 / baseline created' };
  }
  if (prev.hash === hash) return { target, changed: false, events: [], summary: '无变化 / unchanged' };

  const { diffLines, diffStats, diffHunks } = await import('./diff.js');
  const lines = diffLines(prev.text ?? '', text);
  const stats = diffStats(lines);
  const hunks = diffHunks(lines, 3);
  const added = hunks.filter((l) => l.op === '+').map((l) => l.text).join('\n');
  const event = {
    kind: 'change',
    url: target.url,
    stats,
    hunks,
    before: (prev.text ?? '').slice(0, 4000),
    after: text.slice(0, 4000),
    title: target.label ?? target.url,
    text: added.slice(0, 4000),
    delta: text.length - (prev.text ?? '').length,
  };
  // Keyword alarms must be judged over "the whole of the new content"; looking only at added lines misses a reworded line that adds no lines
  const verdict = applyRules({ ...event, text: `${added}\n${text.slice(0, 1500)}` }, ctx.rules);
  setBaseline(ctx.cfg, target.id, { kind: 'url', hash, text, url: target.url });
  return {
    target,
    changed: true,
    events: [{ ...event, reasons: verdict.reasons }],
    summary: `内容变化 +${stats.added}/-${stats.removed} 行${verdict.reasons.length ? `（告警：${verdict.reasons.join('、')}）` : ''}`,
  };
}

// ── 2) MediaWiki page
async function fetchPageRev(target, ctx) {
  const url = `${apiOf(target.apiUrl)}&action=query&prop=revisions&rvprop=ids%7Ctimestamp%7Cuser%7Ccomment%7Csize%7Cflags&rvlimit=1&titles=${encodeURIComponent(target.page)}`;
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  const pages = j?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) throw new Error(`条目不存在 / page not found: ${target.page}`);
  const rev = (page.revisions ?? [])[0];
  if (!rev) throw new Error('取不到修订 / no revision');
  return { rev, title: page.title };
}

async function checkMediaWikiPage(target, ctx) {
  const prev = baselineFor(target, ctx);
  const { rev, title } = await fetchPageRev(target, ctx);

  if (!prev) {
    setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-page', revid: rev.revid, size: rev.size, title, timestamp: rev.timestamp });
    return { target, first: true, changed: false, events: [], summary: `已建立基线 revid=${rev.revid}` };
  }
  if (prev.revid === rev.revid) return { target, changed: false, events: [], summary: `无变化（revid=${rev.revid}）` };

  let hunks = [];
  try {
    const cmpUrl = `${apiOf(target.apiUrl)}&action=compare&fromrev=${encodeURIComponent(prev.revid)}&torev=${encodeURIComponent(rev.revid)}`;
    const cr = await jget(cmpUrl, { cfg: ctx.cfg, target });
    const cj = await cr.json().catch(() => null);
    const html = cj?.compare?.['*'] ?? '';
    const lines = stripHtml(html).split('\n').filter(Boolean);
    hunks = lines
      .filter((l) => /^[-+]/.test(l) || l.startsWith('&#160;') === false)
      .slice(0, 400)
      .map((l) => ({ op: /^\+/.test(l) ? '+' : /^-/.test(l) ? '-' : ' ', text: l.replace(/^[-+]\s?/, ''), aLine: null, bLine: null }));
  } catch {
    /* if compare fails, only report "it changed" */
  }

  const delta = typeof rev.size === 'number' && typeof prev.size === 'number' ? rev.size - prev.size : undefined;
  const event = {
    kind: 'revision',
    title,
    url: `${String(target.apiUrl).replace(/\/api\.php.*$/, '')}/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
    from: prev.revid,
    to: rev.revid,
    delta,
    user: rev.user,
    comment: rev.comment,
    anon: !!rev.anon,
    timestamp: rev.timestamp,
    hunks,
    text: String(rev.comment ?? ''),
  };
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-page', revid: rev.revid, size: rev.size, title, timestamp: rev.timestamp });
  const verdict = applyRules(event, ctx.rules);
  return { target, changed: true, events: [{ ...event, reasons: verdict.reasons }], summary: `条目已修订 revid ${prev.revid} → ${rev.revid}${delta !== undefined ? `（${delta >= 0 ? '+' : ''}${delta} 字节）` : ''}` };
}

// ── 3) MediaWiki recent changes
function rcToEvents(rows, rules) {
  const out = [];
  for (const r of rows) {
    const event = {
      kind: 'recentchange',
      title: r.title,
      rcid: r.rcid,
      type: r.type,
      logType: r.logtype,
      user: r.user,
      comment: r.comment,
      timestamp: r.timestamp,
      anon: !!r.anon,
      bot: !!r.bot,
      // MediaWiki flags unpatrolled edits with `unpatrolled` in flags
      unpatrolled: Object.prototype.hasOwnProperty.call(r, 'unpatrolled'),
      isNew: !!r.new,
      delta: typeof r.newlen === 'number' && typeof r.oldlen === 'number' ? r.newlen - r.oldlen : undefined,
      url: r.title ? `https://${String(r.wiki ?? '').replace(/^https?:\/\//, '')}` : '',
    };
    const v = applyRules(event, rules);
    if (v.alert) out.push({ ...event, reasons: v.reasons });
  }
  return out;
}

async function checkRecentChanges(target, ctx) {
  const prev = baselineFor(target, ctx);
  const ns = (target.namespaces ?? [0]).join('|');
  const url =
    `${apiOf(target.apiUrl)}&action=query&list=recentchanges` +
    `&rcprop=title%7Ctimestamp%7Cuser%7Ccomment%7Csize%7Cflags%7Cids%7Cloginfo` +
    `&rclimit=${Number(target.limit ?? 50)}&rctype=edit%7Cnew%7Clog` +
    (ns ? `&rcnamespace=${encodeURIComponent(ns)}` : '');
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  const rows = j?.query?.recentchanges ?? [];
  const since = prev?.lastTimestamp ? Date.parse(prev.lastTimestamp) : 0;

  const fresh = since ? rows.filter((x) => Date.parse(x.timestamp) > since) : rows;
  const events = rcToEvents(fresh, ctx.rules);
  const lastTimestamp = rows[0]?.timestamp ?? prev?.lastTimestamp ?? new Date().toISOString();
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-recentchanges', lastTimestamp });

  return {
    target,
    first: !prev,
    changed: events.length > 0,
    events,
    summary: prev
      ? `${fresh.length} 条新更改，其中 ${events.length} 条命中规则`
      : `已建立基线（首次抓取 ${rows.length} 条，不计为变更）`,
  };
}

// ── 4a) "does this wiki credential work?" -- a pure request builder and a pure parser
//
// Why this exists as its own pair of pure functions rather than as three lines inside a route: the
// target configures a **real login credential** (a wiki `username` + `botPassword`, used by the
// watchlist check below), and until now nothing in the application ever measured whether it works --
// the first thing that found out was a watch run, whose failure reads as "the wiki changed".
//
// Two rules shape the request, and both come from the credential being secret:
//   • the password travels **only** in the Authorization header. A basic-auth credential put in the
//     URL would be echoed by proxies, redirect targets and error messages, and this project logs the
//     URLs it fetches;
//   • the call is **read-only**: `meta=userinfo` with `assert=user` answers "who am I" in one request
//     and can never write. There is no write action anywhere in this pair of functions.
// The returned "safe request" carries no credential at all, so it is the one thing that may be logged.

/** The wiki host of an api.php address ('' when the address has no parseable host) */
// The reference is the reason this module is in URL_POLICY_CALLERS as 'direct': the verdict on a target's
// address comes from remote-url.js, through netFetch and through the login checker below.
void validateRemoteUrl;

export function wikiHostOf(apiUrl) {
  try {
    return new URL(String(apiUrl ?? '').trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Build the MediaWiki "who am I, and am I logged in" request.
 *
 * Pure: nothing is sent here. The caller hands the result to netFetch.
 * @param {{apiUrl?:string, username?:string, botPassword?:string, proxy?:string}} target
 * @returns {{ok:true, url:string, headers:object, host:string, domain:string}
 *          |{ok:false, error:string, missing:string}}
 */
export function buildWikiLoginRequest(target = {}) {
  const apiUrl = String(target.apiUrl ?? '').trim();
  const username = String(target.username ?? '').trim();
  const password = String(target.botPassword ?? '');
  // Refuse politely rather than firing a request with a blank password: a blank credential is not a
  // failed login, it is a question that was never asked, and an anonymous answer would be read as
  // "your credential does not work".
  const missing = [];
  if (!apiUrl) missing.push('apiUrl');
  if (!username) missing.push('username');
  if (!password) missing.push('botPassword');
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: `missing ${missing.join(' / ')} -- nothing was requested`,
    };
  }
  const host = wikiHostOf(apiUrl);
  if (!host) return { ok: false, missing: ['apiUrl'], error: 'the api url has no usable host -- nothing was requested' };
  // `format=json` is appended the same way apiOf() does it, but this builder must stay usable on its
  // own (the route and the tests both call it directly).
  const url =
    `${apiUrl}${apiUrl.includes('?') ? '&' : '?'}format=json` +
    '&action=query&meta=userinfo&uiprop=rights%7Cgroups&assert=user';
  return {
    ok: true,
    url,
    host,
    // The label the UI shows next to a result: the same host the credential was read for. Kept apart
    // from `host` because the cookie probe lower-cases and may strip a leading `www.`.
    domain: host.replace(/^www\./, ''),
    headers: {
      // Always the product token: this is `api.php`, and this request carries a credential — see the block at
      // the top of this file. A browser string here would be a claim about an engine that has nothing to do
      // with the request.
      'user-agent': API_UA,
      accept: 'application/json',
      // BotPassword credentials are sent as basic auth (`BotName@TaskName:password`).
      authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      // No cookie jar: one request, one credential, nothing to persist at the site.
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
}

/**
 * The log-safe view of a built request: **no credential**. Written as its own function so "nothing
 * secret is logged" is a property a test can assert rather than a habit.
 */
export function safeLoginRequestSummary(req) {
  if (!req?.ok) return { ok: false, error: req?.error ?? 'request not built' };
  return { ok: true, url: req.url, host: req.host, method: 'GET', hasAuthorization: true };
}

/**
 * Parse the answer to that request.
 *
 * Pure. Three outcomes are kept apart on purpose, because they send the person in different
 * directions: an authenticated answer names the account, `anon` means the site ignored the
 * credential (for a basic-auth request that means the Wiki does not accept BotPassword over
 * Authorization), and `error` is the site's own reason -- userinfo plus `assert=user` answers
 * `assertuserfailed` when the credential is wrong, and that code is more useful than anything this
 * module could invent.
 * @returns {{ok:boolean, status:'ok'|'anon'|'error', user?:string, anon?:boolean, groups?:string[],
 *            rights?:string[], code?:string, reason:string}}
 */
export function parseWikiLoginResponse(payload) {
  const j = payload && typeof payload === 'object' ? payload : null;
  if (!j) return { ok: false, status: 'error', code: 'bad-response', reason: 'the wiki did not return JSON' };
  if (j.error) {
    const code = String(j.error.code ?? 'error');
    const info = String(j.error.info ?? '').trim();
    return { ok: false, status: 'error', code, reason: info ? `${code}: ${info}` : code };
  }
  const u = j.query?.userinfo;
  if (!u) return { ok: false, status: 'error', code: 'no-userinfo', reason: 'the answer carried no userinfo block' };
  if (u.anon === true || u.id === 0) {
    return {
      ok: false,
      status: 'anon',
      anon: true,
      reason: 'the wiki answered as an anonymous user: the credential was not accepted',
    };
  }
  const user = String(u.name ?? '').trim();
  if (!user) return { ok: false, status: 'error', code: 'no-name', reason: 'the answer named no account' };
  return {
    ok: true,
    status: 'ok',
    user,
    anon: false,
    groups: Array.isArray(u.groups) ? u.groups : [],
    rights: Array.isArray(u.rights) ? u.rights : [],
    reason: '',
  };
}

/**
 * Measure the configured wiki credential with one read-only request.
 *
 * The password is never returned, logged or echoed: the result carries the account name or the
 * site's own reason, and nothing else. A failure to reach the wiki is reported as such rather than
 * as "the credential is wrong" -- the two are different facts.
 * @param {{apiUrl?:string, username?:string, botPassword?:string, proxy?:string}} target
 * @param {{cfg?:object, log?:object}} ctx
 * @param {{fetchImpl?:Function}} [opts] injectable for tests
 */
export async function checkWatchLogin(target = {}, ctx = {}, opts = {}) {
  const built = buildWikiLoginRequest(target);
  if (!built.ok) return { ok: false, checked: false, status: 'incomplete', missing: built.missing, reason: built.error };
  const doFetch = opts.fetchImpl ?? jget;
  let res;
  try {
    res = await doFetch(built.url, {
      cfg: ctx.cfg,
      target: { ...target, botPassword: undefined },
      headers: { authorization: built.headers.authorization },
    });
  } catch (e) {
    const cause = e?.cause?.message ?? e?.cause?.code ?? '';
    return { ok: false, checked: true, status: 'error', domain: built.domain, reason: `could not reach the wiki: ${e.message}${cause ? ` (${cause})` : ''}` };
  }
  if (!res?.ok) {
    return { ok: false, checked: true, status: 'error', domain: built.domain, httpStatus: res?.status ?? null, reason: `the wiki answered HTTP ${res?.status ?? '?'}` };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const parsed = parseWikiLoginResponse(payload);
  return { ok: parsed.ok, checked: true, domain: built.domain, ...parsed };
}

// ── 4) MediaWiki watchlist (requires login)
async function mwLogin(target, ctx) {
  const api = apiOf(target.apiUrl);
  const tokRes = await jget(`${api}&action=query&meta=tokens&type=login`, { cfg: ctx.cfg, target });
  const tok = await tokRes.json().catch(() => null);
  const loginToken = tok?.query?.tokens?.logintoken;
  if (!loginToken) throw new Error('取不到 login token / cannot obtain login token');

  const body = new URLSearchParams({
    action: 'login',
    lgname: target.username ?? '',
    lgpassword: target.botPassword ?? '',
    lgtoken: loginToken,
    format: 'json',
  });
  const r = await netFetch(
    api,
    {
      method: 'POST',
      // The product token again, for the reason stated on the builder above: this POST carries a password.
      headers: { 'user-agent': API_UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: withTimeout(25000),
    },
    { cfg: ctx.cfg, subject: target, policy: targetPolicy(target) }
  );
  const j = await r.json().catch(() => null);
  const result = j?.login?.result;
  if (result !== 'Success') throw new Error(`登录失败 / login failed: ${result ?? 'unknown'}${j?.login?.reason ? ` (${j.login.reason})` : ''}`);
  return true;
}

async function checkWatchlist(target, ctx) {
  const prev = baselineFor(target, ctx);
  if (!target.username || !target.botPassword) {
    throw new Error('监视列表需要 username 与 botPassword / username & botPassword required');
  }
  await mwLogin(target, ctx);
  const url =
    `${apiOf(target.apiUrl)}&action=query&list=watchlist` +
    `&wlprop=title%7Ctimestamp%7Cuser%7Ccomment%7Csizes%7Cflags%7Cids&wllimit=${Number(target.limit ?? 50)}&wlallrev=0`;
  const r = await jget(url, { cfg: ctx.cfg, target });
  const j = await r.json().catch(() => null);
  if (j?.error) throw new Error(`watchlist 报错 / error: ${j.error.info ?? j.error.code}`);
  const rows = j?.query?.watchlist ?? [];
  const since = prev?.lastTimestamp ? Date.parse(prev.lastTimestamp) : 0;
  const fresh = since ? rows.filter((x) => Date.parse(x.timestamp) > since) : rows;
  const events = rcToEvents(fresh, ctx.rules);
  const lastTimestamp = rows[0]?.timestamp ?? prev?.lastTimestamp ?? new Date().toISOString();
  setBaseline(ctx.cfg, target.id, { kind: 'mediawiki-watchlist', lastTimestamp });
  return {
    target,
    first: !prev,
    changed: events.length > 0,
    events,
    summary: prev ? `监视列表 ${rows.length} 条，${fresh.length} 条新增，${events.length} 条命中规则` : `已建立基线（${rows.length} 条）`,
  };
}

// ───────────────────────────────────────────── public / public

const HANDLERS = {
  url: checkUrl,
  'mediawiki-page': checkMediaWikiPage,
  'mediawiki-recentchanges': checkRecentChanges,
  'mediawiki-watchlist': checkWatchlist,
};

/**
 * A helper the handlers call instead of `getBaseline` when they want both halves at once.
 *
 * The handlers below still use `getBaseline` for the comparison itself (a baseline or null, which is all a
 * diff needs); this exists for the states where "there is no previous value" is not the whole answer, and it
 * parks the state on `ctx` so `checkTarget` can put it in the result without every handler having to return
 * it. That is the difference between a condition that is *reported* and one that is only logged.
 */
function baselineFor(target, ctx) {
  const r = readBaseline(ctx.cfg, target.id);
  ctx.baseline = r;
  return r.data ?? null;
}

/**
 * What the result says about the baseline, and — when the baseline was damaged — the sentence the report and
 * the watch page show. Written once here so the four handlers cannot drift into four different phrasings of
 * the same condition (`tools/watch-baseline-test.mjs` asserts the wording, because a user-facing sentence
 * that changes silently is the same as no sentence).
 */
function baselineResultFor(ctx) {
  const state = ctx.baseline?.state ?? 'first-run';
  const fault = isBaselineFault(state);
  const out = { state, fault };
  if (state === 'corrupt') {
    out.movedTo = ctx.baseline?.movedTo ?? null;
    out.stillInPlace = !!ctx.baseline?.stillInPlace;
    out.note = ctx.baseline?.note ?? null;
    out.summary = out.movedTo
      ? `基线损坏，已重建（旧文件保留为 ${path.basename(out.movedTo)}）/ baseline was corrupt and is being rebuilt (the damaged file is kept as ${path.basename(out.movedTo)}), so this check cannot report what changed while it was broken`
      : '基线损坏且未能保留，已重建 / baseline was corrupt and could not be preserved; it is being rebuilt, so this check cannot report what changed while it was broken';
  } else if (state === 'unavailable') {
    out.note = 'the baseline file is present but unreadable, so nothing was written and this check rebuilt nothing';
    out.summary = '基线不可读，未写入任何内容 / the baseline could not be read (permissions); nothing was written, so this target reports the condition until the file can be read';
  }
  return out;
}

/** Check a single watch target / check one target */
export async function checkTarget(target, { cfg, rules, log } = {}) {
  const fn = HANDLERS[target.kind];
  if (!fn) return { target, ok: false, error: `未知监视类型 / unknown kind: ${target.kind}`, events: [] };
  const ctx = { cfg, log, rules: { ...DEFAULT_RULES, ...(rules ?? cfg?.watch?.rules ?? {}) }, applyRules };
  try {
    const r = await fn(target, ctx);
    // The baseline condition travels with the result. `...r` comes last for the handler's own value of
    // `first`, which is the same statement seen from the other side (a first check and a damaged baseline
    // both have no previous value, but only one of them is normal).
    const out = { ok: true, baseline: baselineResultFor(ctx), ...r };
    if (out.baseline.fault) out.summary = `${out.baseline.summary}${out.summary ? ` — ${out.summary}` : ''}`;
    // Only record history when something changed, to avoid noise
    if (out.changed && !out.first) {
      appendHistory(cfg, target.id, {
        kind: target.kind,
        label: target.label,
        summary: out.summary,
        baseline: out.baseline.state,
        // Future-facing field, kept deliberately: no handler returns a `growth` any more, so this is null on
        // every history entry today (see the comment on the `follower` baseline in server.js).
        growth: out.growth ?? null,
        events: out.events.map((e) => ({ ...e, hunks: e.hunks ? e.hunks.slice(0, 200) : undefined })),
      });
    }
    log?.info(`watch ${target.id}: ${out.summary}`);
    return out;
  } catch (err) {
    // undici's "fetch failed" carries no information by itself; including the cause is what makes it diagnosable
    const cause = err?.cause?.message ?? err?.cause?.code ?? '';
    const msg = cause ? `${err.message}（${cause}）` : err.message;
    log?.error(`watch ${target.id} failed / failed — ${msg}`);
    // The baseline condition is reported on the failure path too: a target whose baseline was damaged and
    // whose fetch then failed is the case where a reader most needs to know the baseline half.
    return { target, ok: false, changed: false, events: [], error: msg, baseline: ctx.baseline ? baselineResultFor(ctx) : null };
  }
}

/**
 * Check the watch targets.
 * @param {object} cfg
 * @param {object} log
 * @param {{targets?:object[]}} opts in observation mode only pass the ones drawn this round (see observe.js)
 */
export async function checkAll(cfg, log, opts = {}) {
  const targets = Array.isArray(opts.targets)
    ? opts.targets
    : (cfg?.watch?.targets ?? []).filter((t) => t.enabled !== false);
  const results = [];
  let first = true;
  for (const t of targets) {
    // Jitter between checks in observation mode too -- checking several targets at exactly even intervals is itself a machine signature
    if (!first && cfg?.observation?.enabled) {
      const gap = gapWithJitter(2, cfg?.observation?.jitterSeconds);
      if (gap > 0) await sleep(gap * 1000);
    }
    first = false;
    results.push(await checkTarget(t, { cfg, rules: cfg?.watch?.rules, log }));
  }
  return results;
}
