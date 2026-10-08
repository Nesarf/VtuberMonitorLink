// config-fault.js — one decision: should the shell show the config-fault banner, and with what?
//
// v1.0.5 made a damaged config *preserved and reported* instead of silently replaced, and `GET /api/config/health`
// is where that record lives. Nothing consumed it, so the fault was visible only in a log file - which is the one
// place a user who cannot see the log will never look. This module is the consumption, kept as a **pure function**
// on purpose: the component below it is then thin enough that what it renders *is* this object, and the test can
// state every sentence the banner can produce without a DOM (this repo has no jsdom, and adding one to test five
// strings would be a larger change than the feature).
//
// Where the words come from, because this is the part that is easy to get wrong:
//
//   · the condition and everything the user can act on are the **server's** own text and its own enum - the raw
//     parse/read message, the error code, the preserved filename, `backupError`. The health answer is written
//     outside the i18n layer deliberately (see the durability section of server/src/config.js), and copying those
//     sentences into the dictionaries would mean translating them 29 times and moving two ratchets to do it.
//   · the keys this file returns are therefore **chrome only** - a heading, a button, a dismiss label - and every
//     one of them is a key the dictionaries already carry and the UI already counts. No new i18n key is
//     introduced by this feature, which is why the dictionaries, the UI key count, per-locale coverage and the
//     proofread counts are all unchanged by it. See the note above `bannerKeys` for the rule that keeps it that way.
//
// The API shape below is the contract `GET /api/config/health` answers with today:
//   { state, ok, fault, at, path, backupPath, backupExists, lastWrite, lastWriteError, writeCount,
//     writeFailures, lastProblem, events[], backupUsable, backupError }
// `fault` is the server's own verdict (`isConfigFault(state)`) and is the *only* thing that makes the banner
// appear. It is read as `=== true`, so a health answer that failed outright (null) and a server too old to send
// the field both leave the banner hidden rather than guessing from a state name.

/**
 * The i18n keys this feature may use, and the reason the list is a list.
 *
 * "Add no new key" is not a style preference here: a new key has to go into both base dictionaries, the hand
 * overlays, the machine layer and the generated Traditional file, and it moves the UI key count, the per-locale
 * coverage denominators and the proofread structural/suspect counts - three ratchets that exist so that a feature
 * cannot quietly raise them. The health route's own copy is server-side for exactly that reason, so the chrome is
 * taken from keys that are already in the dictionaries and already counted as used by the UI.
 *
 * `resetDefaults` is the recovery button. It is the closest existing entry to "put the working configuration back"
 * and it is translated in every layer already; the banner's own body states precisely what the button is about to
 * do (restore `config.json` from `config.json.bak`), so the label carries no claim on its own.
 */
export const bannerKeys = {
  title: 'healthProblems',
  recover: 'resetDefaults',
  dismiss: 'close',
};

/** Does this value look like a health answer at all? Used to keep a bad payload from becoming a crash. */
export function isHealthAnswer(h) {
  return !!h && typeof h === 'object' && typeof h.state === 'string';
}

/** A server-supplied string, or null. Never renders an object/array as a React child. */
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The file name on its own: an absolute path is not something a user can act on, and it is long enough to break the layout. */
const baseName = (p) => {
  const s = text(p);
  if (!s) return null;
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
};

/** Server booleans, read strictly - `undefined` must not read as `false` and quietly disable a working button. */
const bool = (v) => v === true;

/**
 * The one event this banner is about, or null.
 *
 * `events` is a bounded ring of everything that ever happened to the config in this process, and a healthy config
 * that had one failed write is in it too. So the match is on the *condition the server is reporting*, not on
 * "the last event": the newest event whose state is the state `lastProblem` names, falling back to the newest
 * event of any kind when the server reports no `lastProblem` at all.
 */
function reportedEvent(h) {
  const events = Array.isArray(h?.events) ? h.events.filter((e) => !!e && typeof e === 'object') : [];
  if (!events.length) return null;
  const want = text(h?.lastProblem?.state);
  if (!want) return events[events.length - 1];
  for (let i = events.length - 1; i >= 0; i--) if (text(events[i].state) === want) return events[i];
  return events[events.length - 1];
}

/**
 * The facts the banner prints, each one taken from the server and nothing invented.
 *
 * `code` and `file` are short chips (`EPERM`, `config.json.broken-2026-…`), `detail` is the server's own message
 * verbatim, and `movedTo` is the preserved copy when there is one. There is deliberately no "what to do" sentence
 * assembled here: a step the user can take has to be *true* to be useful, and the true next step depends on facts
 * only the server and the filesystem have (read-only vs. parse failure, a `.bak` that is itself unusable, a
 * damaged file still in place). The server already says which of those it is, so that is what is shown.
 */
export function faultFacts(h) {
  const ev = reportedEvent(h);
  const code = text(ev?.code) ?? text(h?.lastProblem?.code);
  const error = text(ev?.error) ?? text(h?.lastWriteError?.error);
  const file = baseName(ev?.movedTo) ?? baseName(h?.path);
  const movedTo = text(ev?.movedTo);
  // The backup's own refusal text ("no config.json.bak to recover from", "… is not usable either: …") is the
  // reason a disabled recover control carries, which is why it is passed through rather than re-worded.
  const backupError = text(h?.backupError);
  const state = text(h?.state);
  const stillInPlace = bool(ev?.stillInPlace);
  const preserveError = text(ev?.preserveError);
  return { state, code, error, file, movedTo, backupError, stillInPlace, preserveError };
}

/**
 * What the banner shows, or `{ show: false }` and no wording at all.
 *
 * `show` is the single condition the whole feature turns on. It is deliberately NOT "the state is not ok": the
 * server decides with `fault`, and `fresh` (a first run) is a normal state that must stay silent - a banner that
 * greeted every new install with "your config is damaged" would be wrong on the day it matters most.
 */
export function decideConfigFaultBanner(h) {
  if (!isHealthAnswer(h)) return { show: false, reason: 'no health answer' };
  if (!bool(h.fault)) return { show: false, reason: 'the config is not in a fault state' };

  const facts = faultFacts(h);
  const canRecover = bool(h.backupUsable);
  // A disabled control has to say why (the project's rule). The server's `backupError` is that reason when it has
  // one; these two fallbacks cover the states where the server reports no error at all, so the reason is never
  // an empty string that renders as a dead button with nothing beside it.
  const disabledReason = canRecover
    ? null
    : facts.backupError ??
      (facts.state === 'unreadable'
        ? 'unreadable'
        : 'no backup');

  return {
    show: true,
    state: facts.state,
    code: facts.code,
    detail: facts.error,
    file: facts.file,
    movedTo: facts.movedTo,
    stillInPlace: facts.stillInPlace,
    preserveError: facts.preserveError,
    // The file the user can look at: the preserved copy by preference (the damaged bytes), the config otherwise.
    ...(facts.movedTo ? { preserved: baseName(facts.movedTo) } : {}),
    canRecover,
    disabledReason,
    recoverTitle: facts.backupError,
    // The timestamp of the standing condition, as the server recorded it. A page that polls this route can tell
    // "the same fault, still standing" from a new one, and so can the reader.
    at: text(h?.lastProblem?.at) ?? text(h?.at),
    backupPath: baseName(h?.backupPath),
  };
}
