// browser-target.js — the one page's setting, and the one place it is resolved.
//
// Why this module exists (the defect it answers):
//
//   The browser and its profile used to be configured in the Settings page's Browser section, while the
//   features that depend on it read it wherever they happened to be — the fetchers, the read-only cookie
//   probe behind every login check, the share page's login stage, and the
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
//   1) `browser.profileDir` is **not** mode-dependent. In `bundled` mode Playwright starts a fresh browser
//      (so there is no user-data dir of its own to reuse) while the **read-only cookie probe does not care
//      about the mode at all** — it copies a cookie store out of whichever profile is named and reads it.
//      The Settings page only showed the field when the mode was not `bundled`, which is exactly how a person
//      ends up with an empty profile dir and no visible place to fill it in.
//   2) An empty setting must **not** silently become "read cookies out of whatever browser is installed".
//      Cookie stores are credentials. Falling back to a browser nobody named would mean every login check
//      reads a profile the user never pointed at. So the default is *documented and shown, never used*:
//      defaultProfileDir() says which dir this machine's Firefox is signed in with, the page offers it as
//      a one-click pick, and until it is picked the resolution honestly answers "nothing is configured".
//
// One fact changed with the engine, and it is the reason `bundled` is no longer special:
//
//   A Firefox profile is a **property of the machine, not of the executable**. Chromium's user-data dir
//   belonged to one installed build, so "the bundled engine" genuinely had nothing to point at. Playwright's
//   Firefox opens whatever profile directory it is handed — measured: a profile directory named by the
//   installed Firefox's own `profiles.ini` launches through `launchPersistentContext` — so the bundled engine
//   *can* reuse the Firefox login sitting on this machine. That is the whole
//   point of the feature, so defaultProfileDir() now offers that profile in every mode. It is still only
//   **offered**: nothing is substituted into an empty setting.
//
// Pure functions all the way down (the filesystem is injected), so tools/browser-config-test.mjs can pin the
// discovery shape, the picker's mapping and the resolution offline, and tools/integrity-check.mjs can read
// browserConsumerProblems() to prove no module went back to reading the raw key.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * What makes a directory "a Firefox profile" to this module.
 *
 * Firefox keeps its cookie store at the profile root (Chromium put it under `Network/`), and the file is
 * the same one server/src/cookies.js reads — so the discovery and the reader agree by construction about
 * what they are looking at, instead of each carrying its own idea of a profile.
 */
const COOKIE_FILE = 'cookies.sqlite';

/**
 * The **Firefox** root(s) on this machine — the directory `profiles.ini` lives in (never hard-coded to one
 * machine; derived from env vars).
 *
 * Why a root and not "the profile list": Firefox does not keep its profiles in a fixed set of
 * subdirectories the way Chromium does (`Default` / `Profile 1` / …). `profiles.ini` is the authority, and
 * it lives in one of these two places depending on how Firefox was installed — see profilesFromIni() for
 * the expansion, which is what actually turns a root into profile directories.
 *
 * This enumeration used to list the Chromium user-data roots (Chrome / Edge / Brave / Vivaldi / Opera /
 * Chromium) so that "which profiles does this machine have" could be answered. Those roots are gone with the
 * engine: a Chromium profile is not a store the Firefox cookie reader can open, so offering one in the
 * picker would offer a path that fails the moment it is used.
 */
export function browserRoots() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const list = [
    // The normal location of profiles.ini on Windows; on Linux/macOS Firefox keeps the same layout
    // under ~/.mozilla/firefox, which is what `home` resolves to there.
    ['Firefox', path.join(roaming, 'Mozilla', 'Firefox')],
    ['Firefox', path.join(home, '.mozilla', 'firefox')],
    // A per-user Windows install keeps its profile here instead of under Roaming
    ['Firefox (local)', path.join(local, 'Mozilla', 'Firefox')],
  ];
  const seen = new Set();
  return list.filter(([, p]) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return fs.existsSync(p);
  });
}

/**
 * Whether this directory is a Firefox **profile**, as opposed to a root that lists profiles.
 *
 * Three measurements, all from this machine, are why this is not simply "does cookies.sqlite exist":
 *   • a real Firefox root carries **zero-byte** `cookies.sqlite` and `places.sqlite` files — this machine's
 *     `%APPDATA%\Mozilla\Firefox` has both, left behind by an older layout — so an existence test answers
 *     "this root *is* a profile", and the discovery then offers the root instead of the two profiles inside it;
 *   • a **zero-byte** file is not a cookie store whatever it is called, which is the same fact stated the
 *     other way round;
 *   • and `profiles.ini` is a stronger statement than any stray file, so when it is present it wins outright.
 *
 * The `fs` is injectable, and a fixture that cannot `statSync` simply skips the size test rather than
 * throwing: the injected filesystem of tools/browser-config-test.mjs is deliberately minimal.
 */
export function isFirefoxProfileDir(dir, { fs: fsImpl = null } = {}) {
  const io = fsImpl ?? fs;
  try {
    if (!io.existsSync?.(path.join(dir, COOKIE_FILE))) return false;
    // A zero-byte store is a placeholder, not a login: reading it can only answer "no cookies".
    const st = io.statSync?.(path.join(dir, COOKIE_FILE));
    if (st && typeof st.size === 'number' && st.size === 0) return false;
  } catch {
    return false;
  }
  try {
    if (io.existsSync?.(path.join(dir, 'profiles.ini'))) return false;
  } catch {
    /* an unreadable ini is treated as absent, which is what the next branch assumes anyway */
  }
  return true;
}

/**
 * Parse a `profiles.ini` into the profile sections it declares.
 *
 * Pure apart from the filesystem handed in, so the shape can be pinned offline (tools/browser-config-test.mjs).
 * A missing file, an unreadable one, or an injected `fs` that cannot read at all answers **[]** rather than
 * throwing: "this root declares no profiles" is a fact the caller can act on, while an exception here would
 * take the whole picker down on a machine where Firefox was uninstalled but its directory stayed behind.
 *
 * `isDefault` and `isInstall` are kept apart because Firefox records two different defaults and they can
 * disagree: `Default=1` is what the user chose in the Profile Manager, while `[Install…] Default=` is what the
 * installation opens on a fresh startup. defaultProfileDir() prefers the user's own choice and documents it.
 *
 * @returns {Array<{name:string, path:string, isDefault:boolean, isInstall:boolean}>} absolute dirs, in ini order
 */
export function profilesFromIni(root, { fs: fsImpl = null } = {}) {
  const io = fsImpl ?? fs;
  const caught = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const text = caught(() => io.readFileSync?.(path.join(root, 'profiles.ini'), 'utf8'));
  if (typeof text !== 'string') return [];

  const sections = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      cur = { name: head[1], entries: {} };
      sections.push(cur);
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && cur) cur.entries[kv[1].trim()] = kv[2].trim();
  }

  // `[Install…] Default=Profiles/xxx` names the profile this installation opens by default.
  const installDefault = sections
    .filter((s) => s.name.startsWith('Install'))
    .map((s) => s.entries.Default)
    .find(Boolean);

  const out = [];
  const resolve = (p) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p));
  for (const s of sections) {
    if (!s.name.startsWith('Profile')) continue;
    const rel = s.entries.Path;
    if (!rel) continue;
    const abs = resolve(rel);
    out.push({
      name: s.entries.Name || s.name,
      path: abs,
      isDefault: s.entries.Default === '1',
      isInstall: !!installDefault && resolve(installDefault) === abs,
    });
  }
  return out;
}

/** Every profile directory under one Firefox root that is actually on disk (the picker must not offer a path that is gone) */
export function profilesUnder(root, { fs: fsImpl = null } = {}) {
  const io = fsImpl ?? fs;
  const out = [];
  const exists = (p) => {
    try {
      return !!io.existsSync?.(p);
    } catch {
      return false;
    }
  };
  // A root that *is* a profile (someone pointed straight at ...\Profiles\xxxx.default) is its own answer
  if (isFirefoxProfileDir(root, { fs: io })) return [root];
  // Firefox: profiles.ini is the authority
  for (const p of profilesFromIni(root, { fs: io })) {
    if (exists(p.path) && !out.includes(p.path)) out.push(p.path);
  }
  return out;
}

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
 * `bundled` is Playwright's own Firefox, which has no profile directory of its own — but unlike the
 * Chromium it replaced it **can** open one, so "bundled" no longer means "nothing to point at"
 * (see defaultProfileDir below and the header comment).
 */
export function browserFromExecutable(executablePath) {
  const p = String(executablePath ?? '').replace(/\\/g, '/').toLowerCase();
  if (!p) return 'bundled';
  if (p.includes('/firefox')) return 'Firefox';
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
 * @param {{fs?:object}} [opts] an injected filesystem for offline pinning; absent means the real one
 * @returns {{id:string, browser:string, name:string, path:string, absolute:string, present:boolean}|null}
 */
export function normalizeProfile(entry, { fs: fsImpl = null } = {}) {
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
    // The id is handed to the client, so it is a one-way digest and never the path itself (BUGS #69).
    id: createHash('sha256').update(absolute).digest('base64url').slice(0, 16),
    browser,
    name,
    // The path exactly as it was given (the user's own shape, e.g. `...\Mozilla\Firefox` rather than the
    // profile inside it: readBrowserCookies accepts either) alongside the resolved absolute form, so a pick
    // writes what the user can recognise while every comparison still happens on the absolute one.
    path: raw,
    absolute,
    present: isDir(absolute, fsImpl ?? fs),
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
 * Enumerate the Firefox profiles on this machine, in the shape the picker uses.
 *
 * The enumeration itself is browserRoots()/profilesUnder() in this module (they already knew where Firefox
 * keeps its profiles and how `profiles.ini` names them); what this adds is (a) the reference row for a root
 * that is installed but declares no usable profile yet, so the page can still say "Firefox is here but
 * nothing is signed in", and (b) the normalisation above, so an incomplete discovery is
 * dropped instead of offered. Nothing is written and no cookie is read (the read-only floor is unchanged).
 *
 * @param {{roots?:Function, profiles?:Function, fs?:object}={}} opts  all injectable, so the shape is pinned offline
 * @returns {{profiles:Array<{id,browser,name,path,absolute,present,hasProfiles}>, dropped:Array<{browser,path,reason}>}}
 *   `dropped` travels with the answer rather than being swallowed: an entry refused in silence reads as "this
 *   machine has fewer browsers", which is the kind of quiet difference this round is about.
 */
export function listProfiles(opts = {}) {
  const roots = opts.roots ?? browserRoots;
  // An **injected** filesystem replaces the real one; the absence of one means the real one, never "nothing
  // exists". That distinction is not cosmetic: passing `null` down meant every `existsSync` answered false, so
  // `present` was always false in the running app and the documented default was always '' (found while
  // checking the swap against this machine's real profiles.ini — the unit tests injected a filesystem, so
  // neither showed up there).
  const fsImpl = opts.fs ?? fs;
  const under = opts.profiles ?? ((root) => profilesUnder(root, { fs: fsImpl }));
  const profiles = [];
  const dropped = [];
  const seen = new Set();
  const offer = (entry, hasProfiles) => {
    const n = normalizeProfile(entry, { fs: fsImpl });
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
 * The **documented default**: the Firefox profile this machine is signed in with.
 *
 * Documented means: shown on the page next to the empty field with a one-click "use this one", and reported
 * by the route, so a person never has to hand-write `C:\Users\...\AppData\Roaming\Mozilla\Firefox\Profiles\…`.
 * It is deliberately NOT used as a silent fallback by the resolution below — see the header comment.
 *
 * The preference order is Firefox's own: the profile whose `profiles.ini` section carries `Default=1` (or the
 * one `[Install…] Default=` names), otherwise the first profile the ini declares. Nothing is invented: if the
 * ini names no profile, or the directory it names is gone, the answer is '' and the page says there is no
 * default rather than offering a path that cannot be opened.
 *
 * @returns {string} '' when this machine has no Firefox profile to point at
 */
export function defaultProfileDir(cfg, opts = {}) {
  const roots = opts.roots ?? browserRoots;
  // An injected filesystem replaces the real one; **no** injection means the real one. Passing `null` down
  // instead made every existence test false, so in the running app this function always answered '' — the
  // documented default existed only inside tests that injected a filesystem.
  const fsImpl = opts.fs ?? fs;
  for (const row of roots() ?? []) {
    const [browser, root] = Array.isArray(row) ? row : [row?.browser, row?.root];
    if (!barePath(root)) continue;
    if (!isDir(root, fsImpl)) continue;
    void browser; // one engine now: the root list itself is what says "this is Firefox"
    const declared = profilesFromIni(root, { fs: fsImpl }).filter((p) => isDir(p.path, fsImpl));
    // The user's own choice first (`Default=1`), then what the installation opens, then whatever the ini
    // lists first. The order is written down because the page states this path as "the default on this
    // machine" — an arbitrary pick would make that sentence untrue.
    const picked = declared.find((p) => p.isDefault) ?? declared.find((p) => p.isInstall) ?? declared[0];
    if (picked) return path.resolve(picked.path);
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
  const documented = defaultProfileDir(cfg, { fs: opts.fs, roots: opts.roots });
  const configured = configuredProfileDir(cfg);
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
