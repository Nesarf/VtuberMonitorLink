// config-fault-test.mjs — the decision half of the config-fault banner, with a control on every assertion.
//
// Why this file exists: `web/src/config-fault.js` decides whether the shell shows the banner and what it says,
// and until now **nothing tested it**. The browser test (tools/config-fault-banner-test.mjs) proves the band
// appears, states the server's condition and disables recovery when there is no usable backup - but it can only
// reach the decisions that are visible on screen, and it needs a packaged app and an engine to run at all. The
// header of that file claimed this module "is covered by the pure decision functions"; measured, that was false
// (`grep -rn config-fault tools/` matched only the browser test), and docs/BUGS.md #95 records it as the gap the
// banner fix left open. This is that half, in the shape the module was designed for: five pure functions, no DOM,
// no browser, no app.
//
// The rule this file exists for above all others is the **dismissal rule** - "a dismissal sticks until the fault
// is a *different* fault". Both ways of getting it wrong are user-visible bugs (a banner that cannot be dismissed
// for the life of the page; a dismissal that survives the arrival of a new fault), and its function lived inside
// the component, where no test in this repository could reach it. It now lives beside the other decisions.
import assert from 'node:assert/strict';
import {
  bannerKeys,
  decideConfigFaultBanner,
  faultFacts,
  faultKey,
  isHealthAnswer,
} from '../web/src/config-fault.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

/** A health answer in the shape `GET /api/config/health` really answers with, overridable per case. */
const answer = (over = {}) => ({
  state: 'corrupt',
  ok: false,
  fault: true,
  at: '2026-10-15T00:00:00.000Z',
  path: '/home/u/app/config.json',
  backupPath: '/home/u/app/config.json.bak',
  backupExists: false,
  backupUsable: false,
  backupError: null,
  lastProblem: { state: 'corrupt', at: '2026-10-15T00:00:00.000Z', code: 'SyntaxError' },
  events: [{ state: 'corrupt', at: '2026-10-15T00:00:00.000Z', code: 'SyntaxError', error: 'Unexpected token' }],
  ...over,
});

// ───────────────────────────────────────────────────────────── 1. the shape of an answer

t('isHealthAnswer accepts an answer and rejects everything that is not one', () => {
  assert.equal(isHealthAnswer(answer()), true);
  assert.equal(isHealthAnswer(null), false, 'null is not an answer');
  assert.equal(isHealthAnswer(undefined), false, 'undefined is not an answer');
  assert.equal(isHealthAnswer('corrupt'), false, 'a bare string is not an answer');
  assert.equal(isHealthAnswer([]), false, 'an array is not an answer');
  assert.equal(isHealthAnswer({}), false, 'an object without a state is not an answer');
  assert.equal(isHealthAnswer({ state: 5 }), false, 'a non-string state is not an answer');
  // control: the same object with the state as a string is an answer, so the check is about the type and not
  // about rejecting objects wholesale.
  assert.equal(isHealthAnswer({ state: '5' }), true, 'the control: the same object with a string state is an answer');
});

// ─────────────────────────────────────────────────── 2. what makes the banner appear (and what must not)

t('the banner appears only on the server\'s own verdict, never on a state name', () => {
  assert.equal(decideConfigFaultBanner(answer()).show, true, 'a fault answer must show the banner');
  // control: `state: 'corrupt'` with `fault: false` - the trap the module header names. An implementation that
  // decided from the state name would show the banner here, which is what this assertion is against.
  const lying = decideConfigFaultBanner(answer({ fault: false }));
  assert.equal(lying.show, false, 'a corrupt state without the server\'s verdict must not show the banner');
  assert.match(String(lying.reason), /not in a fault state/, 'and it must say why: ' + lying.reason);
});

t('a first run and an older server stay silent (the two ways the banner could greet the wrong user)', () => {
  const fresh = decideConfigFaultBanner(answer({ state: 'fresh', fault: false, lastProblem: null, events: [] }));
  assert.equal(fresh.show, false, 'a first run must not be greeted with a damage report');
  const oldServer = decideConfigFaultBanner(answer({ fault: undefined }));
  assert.equal(oldServer.show, false, 'a server too old to send `fault` must not be guessed about');
  const nullAnswer = decideConfigFaultBanner(null);
  assert.equal(nullAnswer.show, false, 'a null answer must not show the banner');
  assert.match(String(nullAnswer.reason), /no health answer/, 'and it must say why: ' + nullAnswer.reason);
  // control: the same fresh answer with the verdict set does show, so the check is about `fault` and not about
  // the fixture being unshowable.
  assert.equal(decideConfigFaultBanner(answer({ state: 'fresh', fault: true })).show, true, 'the control: verdict true shows');
});

// ─────────────────────────────────────────────────── 3. which event the banner is talking about

t('the banner reports the event the server names, not merely the newest one', () => {
  const h = answer({
    lastProblem: { state: 'corrupt', at: 'T2', code: 'SyntaxError' },
    events: [
      { state: 'unreadable', at: 'T1', code: 'EACCES', error: 'permission denied' },
      { state: 'corrupt', at: 'T2', code: 'SyntaxError', error: 'Unexpected token', movedTo: '/a/config.json.broken-T2' },
    ],
  });
  const facts = faultFacts(h);
  assert.equal(facts.code, 'SyntaxError', 'the named condition must win over the newest event');
  assert.equal(facts.error, 'Unexpected token', 'and its message with it');
  assert.equal(facts.file, 'config.json.broken-T2', 'and the preserved copy must be the file shown');
  // control: the newest event is a *different* condition, so "just take the last one" reports the wrong thing -
  // which is the implementation this assertion exists to reject.
  assert.notEqual(facts.code, 'EACCES', 'the control: the newest event carries a different code');
});

t('with no named problem the newest event is used, and with no events the server\'s own fields are', () => {
  const newest = faultFacts(
    answer({
      lastProblem: null,
      events: [{ state: 'unreadable', at: 'T1', code: 'EACCES', error: 'permission denied' }],
      lastWriteError: { error: 'from the write path' },
    })
  );
  assert.equal(newest.code, 'EACCES', 'with nothing named, the newest event is the one to describe');
  const noEvents = faultFacts(answer({ lastProblem: null, events: [], lastWriteError: { error: 'from the write path' } }));
  assert.equal(noEvents.error, 'from the write path', 'with no events at all, the write error is what there is');
  // control, and the first version of it was written wrongly: with no event *and* no write error the answer is
  // null, not the event's text - the banner invents nothing. (The first version asserted the event's error and
  // failed, which is the useful kind of failure: the expectation was wrong, not the code.)
  assert.equal(
    faultFacts(answer({ lastProblem: null, events: null, lastWriteError: null })).error,
    null,
    'the control: with no event and no write error, nothing is invented'
  );
});

t('a path is reduced to a file name, because an absolute path is not something a user can act on', () => {
  const facts = faultFacts(answer({ path: 'C:\\Users\\someone\\app\\config.json', backupPath: '/home/u/app/config.json.bak' }));
  assert.equal(facts.file, 'config.json', 'a Windows path must reduce to its last segment');
  const shown = decideConfigFaultBanner(answer({ path: 'C:\\Users\\someone\\app\\config.json' }));
  assert.equal(shown.backupPath, 'config.json.bak', 'the backup path reduces too, and a forward-slash path as well');
  assert.equal(faultFacts(answer({ path: 'config.json' })).file, 'config.json', 'the control: a bare name is left alone');
});

// ─────────────────────────────────────────────────── 4. the recovery control and its reason

t('recovery is offered exactly when the server says the backup is usable', () => {
  const usable = decideConfigFaultBanner(answer({ backupUsable: true }));
  assert.equal(usable.canRecover, true, 'a usable backup must enable the button');
  assert.equal(usable.disabledReason, null, 'an enabled button carries no reason');
  // control: the same answer with `backupUsable: false` disables it, so the assertion above is about the field.
  assert.equal(decideConfigFaultBanner(answer({ backupUsable: false })).canRecover, false, 'the control: not usable is not enabled');
});

t('a disabled button always carries a reason, and it is the server\'s own when there is one', () => {
  const withServerText = decideConfigFaultBanner(answer({ backupUsable: false, backupError: 'config.json.bak is not usable either: damaged' }));
  assert.equal(withServerText.disabledReason, 'config.json.bak is not usable either: damaged', 'the server\'s reason must be passed through, not re-worded');
  assert.equal(withServerText.recoverTitle, 'config.json.bak is not usable either: damaged', 'and it is the same text as the button title');
  const unreadable = decideConfigFaultBanner(answer({ state: 'unreadable', backupUsable: false, backupError: null }));
  assert.equal(unreadable.disabledReason, 'unreadable', 'an unreadable config with no backup text has its own reason');
  const noBackup = decideConfigFaultBanner(answer({ state: 'corrupt', backupUsable: false, backupError: null }));
  assert.equal(noBackup.disabledReason, 'no backup', 'a corrupt config with no backup text says there is no backup');
  // control: the two fallbacks are different strings, so the check above is not satisfied by one constant.
  assert.notEqual(unreadable.disabledReason, noBackup.disabledReason, 'the two fallback reasons must differ');
});

t('a missing `backupUsable` reads as not usable (a button that claims to restore must not be invented)', () => {
  const missing = decideConfigFaultBanner(answer({ backupUsable: undefined }));
  assert.equal(missing.canRecover, false, 'undefined is not permission to enable recovery');
  assert.ok(missing.disabledReason, 'and the disabled control still says why');
  // control: an explicit true does enable it, so this is about strictness and not about the field being ignored.
  assert.equal(decideConfigFaultBanner(answer({ backupUsable: true })).canRecover, true, 'the control: explicit true enables');
});

// ─────────────────────────────────────────────────── 5. the dismissal rule

t('the same standing fault keeps one key, so a dismissal sticks', () => {
  const first = faultKey(answer());
  const polledAgain = faultKey(answer());
  assert.equal(first, polledAgain, 'two polls of one standing fault must produce the same key');
  assert.ok(first.length > 0, 'and the key must not be the empty string, which is never a dismissal');
});

t('a new fault of the same kind gets a new key, so the banner comes back', () => {
  const before = faultKey(answer());
  // control: only the timestamp of the recorded problem changes - the state does not. An implementation keyed on
  // the state alone (the obvious way to write it) would keep this dismissal, and the user would never see the
  // second fault.
  const laterFault = faultKey(answer({ lastProblem: { state: 'corrupt', at: 'T9', code: 'SyntaxError' } }));
  assert.notEqual(laterFault, before, 'a fault recorded later is a different fault');
  // and the event count catches a new event that carries the same state *and* the same timestamp
  const extraEvent = faultKey(answer({ events: [answer().events[0], { state: 'corrupt', at: '2026-10-15T00:00:00.000Z' }] }));
  assert.notEqual(extraEvent, before, 'a new event under the same timestamp is a different fault too');
  const otherState = faultKey(answer({ state: 'unreadable' }));
  assert.notEqual(otherState, before, 'a different condition is a different fault');
});

t('an answer that is not an answer has no key, and the empty key is never a dismissal', () => {
  assert.equal(faultKey(null), '', 'a null answer has no key');
  assert.equal(faultKey({ state: 5 }), '', 'a broken answer has no key');
  // control: a real answer never produces the empty key, which is what makes "the banner shows when the key is
  // not the dismissed one" safe for a broken payload.
  assert.notEqual(faultKey(answer()), '', 'the control: a real answer never has the empty key');
});

t('the chrome keys are the three the dictionaries already carry, and nothing new', () => {
  // The module header makes this a rule rather than a preference: a new key would move the UI key count, the
  // per-locale coverage denominators and the proofread counts. tools/locale-coverage.mjs and friends would catch
  // it, but only after the dictionaries were edited - this says it at the point of the decision.
  assert.deepEqual(
    Object.keys(bannerKeys).sort(),
    ['dismiss', 'recover', 'title'],
    'the banner may use exactly three keys'
  );
  assert.deepEqual(bannerKeys, { title: 'healthProblems', recover: 'resetDefaults', dismiss: 'close' });
});

process.stdout.write(`\nconfig-fault: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);
