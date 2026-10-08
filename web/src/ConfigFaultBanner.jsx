// ConfigFaultBanner.jsx — the visible half of "a damaged config is preserved and reported".
//
// Where it lives and why **here**: directly under the header, above the tab strip, outside `<main>`. Three
// alternatives were considered and rejected on the requirement itself (a user who cannot see the log has to
// learn their config is damaged):
//   · on the settings page — hidden behind a page you only open if you already suspect something, which is the
//     exact failure being fixed;
//   · on the run/intel page — same problem, one page along;
//   · a modal dialog — blocks the whole app for a condition that the app survives on purpose (it runs on
//     defaults), and a damaged config must not be able to stop the user from reaching the page that fixes it.
// A band in the shell chrome is on every tab, is impossible to miss, and still leaves the app usable.
//
// The banner renders **only** when the server says `fault === true` (`decideConfigFaultBanner`). Nothing here
// decides on its own that something looks wrong: a first run (`fresh`), a normal config (`ok`) and a failed
// write on a healthy config all leave the shell with no banner at all.
//
// No timer of its own: `health` is a prop the shell's existing 3 s poll fills (see App.jsx), so this adds one
// request to a cadence that already exists rather than a second cadence that could drift from it. After a
// recovery it does not assume the outcome - it hands the route's own `health` snapshot back up and re-reads.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n.jsx';
import { api } from './api.js';
import { bannerKeys, decideConfigFaultBanner, isHealthAnswer } from './config-fault.js';

/** The identity of one standing fault: dismissed once, it stays dismissed until the fault is not the same one. */
function faultKey(health) {
  if (!isHealthAnswer(health)) return '';
  return `${health.state}|${health.lastProblem?.at ?? health.at ?? ''}|${health.events?.length ?? 0}`;
}

export default function ConfigFaultBanner({ health, onRecovered }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(null); // { ok, error } of the last recovery click
  const lastKey = useRef('');

  const key = faultKey(health);

  // A *different* fault is a new fact and brings the banner back. Doing it in an effect rather than during the
  // render is what keeps the earlier dismissal from being cleared by an unrelated re-render (the shell re-renders
  // on every poll), which would make "dismiss" a button that does not work.
  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    setDismissed('');
    setAttempt(null);
  }, [key]);

  const decision = decideConfigFaultBanner(health);
  if (!decision.show) return null;

  const { canRecover, disabledReason, recoverTitle } = decision;
  // A refusal is reported next to the control, not swallowed: "I clicked and nothing happened" is the same
  // dead control the project refuses to ship.
  const failed = attempt && attempt.ok === false ? attempt.error : null;
  // A fault that is still standing stays dismissed; one that changed comes back (see the effect above).
  if (dismissed === key && !failed) return null;

  const recover = async () => {
    if (busy || !canRecover) return;
    setBusy(true);
    setAttempt(null);
    try {
      const answer = await api.recoverConfig();
      // The route answers 200 with `health` on success and 409 with `error` + `health` on a refusal. Both are
      // reported from what it actually said; `onRecovered` only fires when the config really became healthy.
      setAttempt(answer.httpOk ? { ok: true, error: null } : { ok: false, error: String(answer.error ?? '') });
      const healthy = isHealthAnswer(answer.health) && answer.health.fault === false;
      onRecovered?.(answer.health, healthy);
    } catch (err) {
      setAttempt({ ok: false, error: String(err?.message ?? err) });
      // The banner stays up on a thrown failure - that is the state the user still has to fix - and the shell
      // keeps polling, so the next successful read either confirms the repair or keeps the fault visible.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config-fault" role="alert" data-testid="config-fault">
      <div className="config-fault-head">
        <strong>{t(bannerKeys.title)}</strong>
        <span className="chip alert">{decision.state}</span>
        {decision.code && <span className="chip alert">{decision.code}</span>}
        <span className="spacer" />
        {/* The label is an existing dictionary key; what the button does is stated by the server below it. */}
        <button
          className="ghost danger"
          onClick={recover}
          disabled={!canRecover || busy}
          title={canRecover ? recoverTitle ?? undefined : disabledReason ?? undefined}
          data-testid="config-fault-recover"
        >
          {t(bannerKeys.recover)}
        </button>
        <button className="ghost" onClick={() => setDismissed(key)} title={t(bannerKeys.dismiss)} data-testid="config-fault-dismiss">
          {t(bannerKeys.dismiss)}
        </button>
      </div>
      <div className="config-fault-body">
        {/* Every sentence below is the server's own text, passed through verbatim - the health route is written
            outside the i18n layer on purpose, so nothing here is re-worded into a new translatable key. */}
        {decision.detail && <p className="detail">{decision.detail}</p>}
        {decision.preserved && (
          <p className="detail">
            {decision.preserved}
            {decision.stillInPlace ? ' · stillInPlace' : ''}
          </p>
        )}
        {decision.preserveError && <p className="detail">{decision.preserveError}</p>}
        {decision.at && <p className="detail">{decision.at}</p>}
        {/* A disabled control carries its reason (the project's rule): the server's own refusal text, so the
            reader is told why the button cannot be used instead of finding a dead control. */}
        {!canRecover && <p className="reason">{disabledReason}</p>}
        {failed && <p className="reason">{failed}</p>}
      </div>
    </div>
  );
}
