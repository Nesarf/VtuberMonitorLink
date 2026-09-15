// browser-target.js — the one page's setting, and the one place it is resolved.
//
// Why this module exists (the defect it answers):
//
//   The browser and its profile used to be configured in the Settings page's Browser section, while the
//   features that depend on it read it wherever they happened to be — the fetchers, the read-only cookie
//   probe behind every login check, the Live page's danmaku accounts, the share page's login stage, and the
//   probe route itself. That arrangement has one failure mode, and the owner hit it: the share page's login
//   check answered `profileDir is empty` and named nothing he could act on from where he was standing. The
//   setting was on another page, in another section, behind a condition, and the sentence he got was the
//   cookie reader's internal error string.
//
//   So there is now **one config key** (`browser.profileDir`, see browserProfileKey() below) and **one
//   resolver** (resolveProfileDir). Every consumer asks this module; no consumer reads the key itself. The
//   page that owns the setting is web/src/pages/Browser.jsx, and the per-feature status shown there comes
//   from the inventory in browser-consumers.js — which is also what the route reports, so the page and the
//   server cannot drift apart.
//
// Two facts that shaped the resolution, both learned from this machine:
//
//   1) `browser.profileDir` is **not** mode-dependent. In `bundled` mode Playwright starts a fresh Chromium
//      (so there is no user-data dir to reuse) while the **read-only cookie probe does not care about the
//      mode at all** — it copies a cookie store out of whichever profile is named and reads it. The Settings
//      page only showed the field when the mode was not `bundled`, which is exactly how a person ends up with
//      an empty profile dir and no visible place to fill it in.
//   2) An empty setting must **not** silently become "read cookies out of whatever browser is installed".
//      Cookie stores are credentials. Falling back to a browser nobody named would mean every login check
//      reads a profile the user never pointed at. So the default is *documented and shown, never used*:
//      defaultProfileDir() says which dir this machine's configured browser would use, the page offers it as
//      a one-click pick, and until it is picked the resolution honestly answers "nothing is configured".
//
// Pure functions all the way down (the filesystem is injected), so tools/browser-config-test.mjs can pin the
// discovery shape, the picker's mapping and the resolution offline, and tools/integrity-check.mjs can read
// browserConsumerProblems() to prove no module went back to reading the raw key.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { browserRoots as machineBrowserRoots, profilesUnder as machineProfilesUnder, listAccounts } from './accounts.js';

/**
 * The config key every consumer resolves. Exported so nothing has to spell it out from memory: the
 * structural check in tools/integrity-check.mjs reads this exact key out of this exact module.
 */
export function browserProfileKey() {
  return 'browser.profileDir';
}

/** The config key of the anonymous-mode switch, which also belongs to "may we touch a login at all?" */
export function anonymousModeKey() {
  return 'privacy.anonymousMode';
}

/**
 * Which browser a launch path belongs to, for the picker's label and for the default.
 * `bundled` is Playwright's own Chromium: it has no user-data dir to point at, which is why the page has to
 * say so instead of leaving the field empty with no explanation.
 */
export function browserFromExecutable(executablePath) {
  const p = String(executablePath ?? '').replace(/\\/g, '/').toLowerCase();
  if (!p) return 'bundled';
  if (p.includes('/google/chrome')) return 'Chrome';
  if (p.includes('/microsoft/edge')) return 'Edge';
  if (p.includes('/bravesoftware/')) return 'Brave';
  if (p.includes('/vivaldi/')) return 'Vivaldi';
  if (p.includes('/opera gx') || p.includes('/opera')) return 'Opera';
  if (p.includes('/chromium')) return 'Chromium';
  return 'custom';
}

function barePath(value) {
  return String(value ?? '').trim() || '';
}

function isDir(p, fs) {
  try {
    return !!fs?.existsSync?.(p);
  } catch {
    return false;
  }
}

/**
 * One profile as the UI and the routes may use it. **An entry without a path is refused here** rather than
 * carried along with `path: ''`: a profile entry whose path is empty is not "a profile we could not read",
 * it is one that cannot be picked, and a picker that offers it would set the setting to emptiness.
 *
 * @returns {{id:string, browser:string, name:string, path:string, absolute:string, present:boolean}|null}
 */
export function normalizeProfile(entry, { fs = null } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  // A path that is not a non-empty string is not a path: `42` would otherwise resolve to a file named "42"
  // next to the process, which is a setting nobody asked for dressed up as a discovered profile.
  if (typeof entry.path !== 'string') return null;
  const raw = entry.path.trim();
  if (!raw) return null;
  const absolute = path.resolve(raw);
  const browser = String(entry.browser ?? '').trim() || 'unknown';
  const name = String(entry.name ?? '').trim() || path.basename(absolute);
  return {
    // Same reasoning as the account id in accounts.js (BUGS #69): the id is handed to the client, so it is a
    // one-way digest and never the path itself.
    id: createHash('sha256').update(absolute).digest('base64url').slice(0, 16),
    browser,
    name,
    // The path exactly as it was given (the user's own shape, e.g. `...\User Data` rather than `...\Default`:
    // readBrowserCookies accepts either) alongside the resolved absolute form, so a pick writes what the user
    // can recognise while every comparison still happens on the absolute one.
    path: raw,
    absolute,
    present: isDir(absolute, fs),
  };
}

export function normalizeProfiles(entries, opts = {}) {
  const out = [];
  for (const e of entries ?? []) {
    const n = normalizeProfile(e, opts);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Enumerate the browser profiles on this machine, in the shape the picker uses.
 *
 * The enumeration itself belongs to server/src/accounts.js (it already knew which browsers this machine has
 * and which subdirectories hold a cookie store); what this adds is (a) the reference-browser rows for the
 * browsers that are installed but have no profile subdirectory yet, so the page can still say "Chrome is here
 * but nothing is signed in", and (b) the normalisation above, so an incomplete discovery is dropped instead
 * of offered. Nothing is written and no cookie is read (the read-only floor is unchanged).
 *
 * @param {{roots?:Function, profiles?:Function, fs?:object}={}} opts  all injectable, so the shape is pinned offline
 * @returns {{profiles:Array<{id,browser,name,path,absolute,present,hasProfiles}>, dropped:Array<{browser,path,reason}>}}
 *   `dropped` travels with the answer rather than being swallowed: an entry refused in silence reads as "this
 *   machine has fewer browsers", which is the kind of quiet difference this round is about.
 */
export function listProfiles(opts = {}) {
  const roots = opts.roots ?? machineBrowserRoots;
  const under = opts.profiles ?? machineProfilesUnder;
  const fs = opts.fs ?? null;
  const profiles = [];
  const dropped = [];
  const seen = new Set();
  const offer = (entry, hasProfiles) => {
    const n = normalizeProfile(entry, { fs });
    if (!n) {
      dropped.push({ browser: String(entry?.browser ?? ''), path: String(entry?.path ?? ''), reason: 'no-path' });
      return;
    }
    if (seen.has(n.absolute)) return;
    seen.add(n.absolute);
    profiles.push({ ...n, hasProfiles });
  };
  for (const row of roots() ?? []) {
    const [browser, root] = Array.isArray(row) ? row : [row?.browser, row?.root];
    const found = root ? (under(root) ?? []) : [];
    if (!found.length) {
      offer({ browser, name: path.basename(path.resolve(String(root ?? '.'))), path: root }, false);
      continue;
    }
    for (const p of found) offer({ browser, name: path.basename(path.resolve(p)), path: p }, true);
  }
  return { profiles, dropped };
}

/** The profile dir the user configured, or '' — the raw setting, never a derived one */
export function configuredProfileDir(cfg) {
  return barePath(cfg?.browser?.profileDir);
}

/**
 * The **documented default**: the user-data dir of the configured browser on this machine.
 *
 * Documented means: shown on the page next to the empty field with a one-click "use this one", and reported
 * by the route, so a person never has to hand-write `C:\Users\...\User Data`. It is deliberately NOT used as
 * a silent fallback by the resolution below — see the header comment.
 *
 * @returns {string} '' when the configured browser is the bundled Chromium (nothing to point at) or when no
 *   such directory exists on this machine
 */
export function defaultProfileDir(cfg, opts = {}) {
  const roots = opts.roots ?? machineBrowserRoots;
  const fs = opts.fs ?? null;
  const want = browserFromExecutable(cfg?.browser?.executablePath);
  if (want === 'bundled') return '';
  for (const row of roots() ?? []) {
    const [browser, root] = Array.isArray(row) ? row : [row?.browser, row?.root];
    if (!barePath(root, fs)) continue;
    // A custom build (and a bundled-but-overridden engine) is still a Chromium, so its user-data root is
    // matched by name when the executable names a browser we know; otherwise only an exact name match counts.
    if (want !== 'custom' && browser !== want) continue;
    if (!isDir(root, fs)) continue;
    return path.resolve(root);
  }
  return '';
}

/**
 * **The single resolver.** Every consumer that needs the browser profile directory calls this.
 *
 * Resolution order, and each step is there for a reason:
 *   1) the anonymous-mode switch wins over everything — it exists precisely to make sure no login session is
 *      reused or read, so a configured profile dir must not quietly override it (and honouring it here is what
 *      makes the switch real for every consumer at once, instead of in whichever module remembered it);
 *   2) an explicitly configured `browser.profileDir` — what the user chose;
 *   3) a caller-supplied `opts.profileDir` — only used by code that was handed one on purpose (the share
 *      layer's injectable read, a per-source override);
 *   4) nothing. Empty, with the source and the reasons named, so the caller can say *why* it has nothing
 *      instead of reporting a bare "empty" (that error string is what took the owner to a dead end).
 *
 * `configured` and `default` are reported even when they are not used, because the page has to be able to
 * show "this is set, and this is what the default would be" next to whichever of them is in force.
 *
 * @returns {{dir:string, source:'anonymous'|'configured'|'given'|'none', configured:string, default:string, anonymous:boolean, reasons:string[]}}
 */
export function resolveProfileTarget(cfg, opts = {}) {
  const fs = opts.fs ?? null;
  const configured = configuredProfileDir(cfg);
  const documented = defaultProfileDir(cfg, { fs, roots: opts.roots });
  const anonymous = isAnonymousMode(cfg);
  const base = { configured, default: documented, anonymous };
  if (anonymous) return { ...base, dir: '', source: 'anonymous', reasons: ['anonymous-mode'] };
  if (configured) return { ...base, dir: configured, source: 'configured', reasons: [] };
  const given = barePath(opts.profileDir);
  if (given) return { ...base, dir: given, source: 'given', reasons: [] };
  const reasons = ['not-configured'];
  if (!documented) reasons.push('no-default-on-this-machine');
  return { ...base, dir: '', source: 'none', reasons };
}

/** The directory string alone, for the consumers that just need it */
export function resolveProfileDir(cfg, opts = {}) {
  return resolveProfileTarget(cfg, opts).dir;
}

/**
 * Anonymous mode: "never use a login session at all".
 *
 * The switch has lived in config (`privacy.anonymousMode`, rendered under privacy) since before this round
 * and **nothing read it**. It belongs on the browser page — it is the same subject as the profile dir, and it
 * is the only other thing that decides whether a login may be touched — so it moved there and it is enforced
 * in the resolver above. That enforcement is what makes it true for every consumer at once; a switch that
 * each module has to remember is a switch that is wrong in the module that forgot.
 */
export function isAnonymousMode(cfg) {
  return cfg?.privacy?.anonymousMode === true;
}

/**
 * Which discovered profile the setting currently names.
 *
 * Compared on the absolute path because `...\User Data` and `...\User Data\Default` are both acceptable
 * values for the same login store (readBrowserCookies says so), and a picker that only matched the exact
 * string would report "nothing selected" for a perfectly good setting.
 */
export function selectedProfile(profiles, configuredPath) {
  const want = barePath(configuredPath) ? path.resolve(barePath(configuredPath)) : '';
  if (!want) return null;
  return (profiles ?? []).find((p) => p.absolute === want) ?? null;
}

/**
 * The picker's mapping: discovered profiles -> the rows the page renders.
 *
 * `selected` is the row whose path is the current setting; `current` marks the row that came **from the
 * setting itself** when it was not discovered on this machine (a hand-written path, or one whose browser is
 * not installed any more). That row is offered so the page can say "this is what is set, and it was not
 * found here" rather than showing an empty picker over a non-empty setting.
 *
 * Entries with no usable path are skipped, and their dropping is not silent: `unusable` counts them.
 *
 * @param {Array|{profiles:Array}} profiles  from listProfiles() (either shape: the array, or the whole answer)
 * @param {object} cfg      the config, so the caller never has to name the key itself
 */
export function pickerFor(profiles, cfg) {
  const rows = [];
  const unusable = [];
  const configured = configuredProfileDir(cfg);
  const wantAbs = configured ? path.resolve(configured) : '';
  for (const p of (Array.isArray(profiles) ? profiles : profiles?.profiles) ?? []) {
    const n = p?.absolute ? p : normalizeProfile(p);
    if (!n) {
      unusable.push({ path: String(p?.path ?? ''), reason: 'no-path' });
      continue;
    }
    rows.push({ ...n, selected: !!wantAbs && n.absolute === wantAbs, current: false });
  }
  if (wantAbs && !rows.some((r) => r.absolute === wantAbs)) {
    const n = normalizeProfile({ browser: 'custom', name: path.basename(wantAbs), path: configured });
    // normalizeProfile cannot fail here (the path is non-empty by construction above), but the picker must not
    // assume that: if it ever did, the row is simply absent rather than half-built.
    if (n) rows.unshift({ ...n, selected: true, current: true });
  }
  // What the discovery refused, folded in with the picker's own refusals: the page reports one count.
  for (const d of (Array.isArray(profiles) ? [] : profiles?.dropped) ?? []) unusable.push(d);
  return { options: rows, unusable, selected: rows.find((r) => r.selected) ?? null };
}

/**
 * "Use this one": the mapping from a picked row to the config change, and the inverse of the discovery step.
 *
 * Nothing here touches the config object — a page writes settings through its own save path, so applying the
 * pick is one object merge, and a pick of a profile that carries no path is refused instead of writing an
 * empty setting (which is how the owner's setting got empty in the first place).
 *
 * @returns {{ok:true, patch:{browser:{profileDir:string}}, value:string}|{ok:false, reason:string}}
 */
export function pickProfile(entry) {
  const n = normalizeProfile(entry);
  if (!n) return { ok: false, reason: 'a profile with no path cannot be used' };
  return { ok: true, patch: { browser: { profileDir: n.path } }, value: n.path };
}

/** Merge a pick into a config object (a new object; the caller's copy is untouched) */
export function applyPickProfile(cfg, entry) {
  const r = pickProfile(entry);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, config: { ...(cfg ?? {}), browser: { ...(cfg?.browser ?? {}), profileDir: r.value } }, value: r.value };
}

/**
 * The accounts this machine can actually use, for the status line on the page and for the share page's
 * chooser. Kept here rather than in the route so the inventory in browser-consumers.js and the route report
 * the same thing.
 *
 * This is the expensive call (synchronous SQLite plus a DPAPI unwrap, measured 3-4s, see server.js), so it is
 * never made by the resolver itself: only a route that was asked for it pays for it.
 */
export async function discoverAccounts(cfg, opts = {}) {
  const list = opts.listAccounts ?? listAccounts;
  try {
    return await list(cfg);
  } catch (e) {
    return { accounts: [], scanned: 0, errors: [{ profile: null, error: e.message }] };
  }
}

// ───────────────────────────────────────────── source-level structure
//
// This is deliberately a **pure text function over source text** (the style already used by the structural
// sections of tools/integrity-check.mjs): the mistake it catches is invisible at runtime — a module that reads
// `cfg.browser.profileDir` itself works fine on the machine where the setting happens to be filled in, and
// only the one machine where it is empty shows the difference. tools/browser-config-test.mjs runs it on both
// the real sources and a control fixture whose consumer reads a different key.

/** Line number (1-based) of a character offset */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * The spans of one source that are **not code**: comments and string literals.
 *
 * Needed because this key is written down in prose (this very file names it, and so do the comments of the
 * consumers explaining why they no longer read it) — a check that counted those would report the fix as the
 * defect. The tokenizer returns the complement — the code spans — and only a hit inside one of those counts.
 */
function codeSpans(src) {
  const spans = [];
  let i = 0;
  let plainFrom = 0;
  const push = (from, to) => {
    if (to > from) spans.push([from, to]);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      push(plainFrom, i);
      i = src.indexOf('\n', i);
      if (i === -1) i = src.length;
      plainFrom = i;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      push(plainFrom, i);
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      plainFrom = i;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      push(plainFrom, i);
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      plainFrom = i;
      continue;
    }
    i++;
  }
  push(plainFrom, src.length);
  return spans;
}

/** Whether a character offset falls inside one of the code spans */
function inSpans(spans, index) {
  return spans.some(([a, b]) => index >= a && index < b);
}

/**
 * Every **direct read** of the shared key in one source text, as line numbers.
 *
 * "Through the shared resolver" is the only sanctioned shape, so a read is any `browser.profileDir` in code
 * whose value is taken rather than handed on. Two shapes are *not* reads and are named here because they are
 * exactly what the resolver's own call sites look like:
 *
 *   • `resolveProfileDir(cfg)` / `resolveProfileTarget(cfg)` — the resolver named `browser.profileDir` inside
 *     its own module, so no consumer has to spell the key out;
 *   • `resolveProfileDir(cfg)?.length` — the consumer reading a field **out of the resolver's answer**.
 *
 * So a hit counts when the character right after the key is neither `.`/`(`/`[` (a member or a call) nor a
 * word character (a longer property name such as `profileDirX`, or a `browser.profileDir…` identifier).
 *
 * @param {string} src
 * @param {string} key the chained key, from browserProfileKey()
 */
export function directProfileReads(src, key = browserProfileKey()) {
  const text = String(src ?? '');
  const [head, ...rest] = key.split('.');
  const tail = rest.join('.');
  if (!head || !tail) return [];
  const spans = codeSpans(text);
  const re = new RegExp(`\\b${head}\\s*\\??\\.\\s*${tail}`, 'g');
  const out = [];
  for (const m of text.matchAll(re)) {
    if (!inSpans(spans, m.index)) continue;
    const next = text[m.index + m[0].length] ?? '';
    if (next === '(' || next === '[' || /[A-Za-z0-9_$]/.test(next)) continue;
    out.push(lineAt(text, m.index));
  }
  return out;
}

/**
 * Whether one source text imports the shared resolver from this module.
 *
 * The import statement is what is checked, not merely the identifier: a consumer that calls
 * `resolveProfileDir(...)` while importing it from somewhere else (or shadowing it) is not using the shared
 * resolver, and the point of this check is that every consumer reads the same one. Nothing here asks whether
 * *this* file reads the key — the resolver is the one place that may, and `directProfileReads` above is what
 * keeps everyone else out.
 */
export function usesSharedResolver(src, symbol = 'resolveProfileDir') {
  const text = String(src ?? '');
  return new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"][^'"]*browser-target\\.js['"]`).test(text);
}

/**
 * The structural check as a pure function over a list of sources.
 *
 * @param {Array<{file:string, source:string, symbols?:string[]}>} sources
 * @param {{key?:string, page?:{file:string, source:string}, pageMustMatch?:RegExp, resolvers?:Array<{file:string, source:string, must:RegExp}>}} opts
 * @returns {string[]} problems, empty when the structure is right
 */
export function browserConsumerProblems(sources, opts = {}) {
  const key = opts.key ?? browserProfileKey();
  const problems = [];
  for (const { file, source, symbols = ['resolveProfileDir', 'resolveProfileTarget'] } of sources ?? []) {
    const reads = directProfileReads(source, key);
    if (reads.length) {
      problems.push(`${file} reads ${key} directly (line ${reads.join(', ')}), so it can disagree with every other consumer: resolve it with ${symbols[0]}() from server/src/browser-target.js`);
      continue;
    }
    if (!symbols.some((s) => usesSharedResolver(source, s))) {
      problems.push(`${file} is a browser-profile consumer but imports none of ${symbols.join(' / ')} from server/src/browser-target.js`);
    }
  }
  for (const r of opts.resolvers ?? []) {
    if (!r.must.test(String(r.source ?? ''))) {
      problems.push(`${r.file} no longer resolves the shared key through ${r.must} — the check would pass while the resolver stopped resolving`);
    }
  }
  if (opts.page && !opts.pageMustMatch?.test(String(opts.page.source ?? ''))) {
    problems.push(`${opts.page.file} does not own the setting the way the check expects (expected ${opts.pageMustMatch})`);
  }
  return problems;
}

/**
 * Every consumer in an inventory must name the documented key.
 *
 * The other half of "one source of truth": the sources can all go through the resolver and the inventory
 * itself can still claim a consumer reads something else, which would put a wrong row on the page. Kept as a
 * pure function so the test can run it on a deliberately wrong inventory.
 *
 * @param {Array<{id:string, file:string, key:string}>} consumers
 */
export function inventoryKeyProblems(consumers, key = browserProfileKey()) {
  const problems = [];
  for (const c of consumers ?? []) {
    if (c?.key !== key) {
      problems.push(`${c?.file ?? c?.id}: the inventory says this consumer reads ${JSON.stringify(c?.key)} but the one key is ${JSON.stringify(key)}`);
    }
  }
  return problems;
}
