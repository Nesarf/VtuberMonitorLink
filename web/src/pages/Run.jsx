// Run page: run now + live state
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

export default function Run() {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    const tick = () =>
      api
        .getState()
        .then(setState)
        .catch((e) => setErr(e.message));
    tick();
    timer.current = setInterval(tick, 2000);
    return () => clearInterval(timer.current);
  }, []);

  const start = async (mode) => {
    setErr('');
    try {
      await api.run(mode);
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!state) return <section className="panel">{t('loading')}</section>;

  return (
    <>
      <section className="panel">
        <h2>{t('runTitle')}</h2>
        <div className="row">
          <button className="primary" disabled={state.running} onClick={() => start('daily')}>
            {state.running ? t('running') : t('runNow')}
          </button>
          <button className="ghost" disabled={state.running} onClick={() => start('merch')}>
            {t('runMerch')}
          </button>
          <button className="ghost" disabled={state.running} onClick={() => start('watch')}>
            {t('runWatchOnly')}
          </button>
        </div>
        {/* Observation mode: say up front what "this round only looked at these" means —
            the whole point of sampling is to avoid leaving behind a "the entire agency was swept at
            once" pattern, but people also have to know that "did not appear" is not the same as
            "no activity", otherwise whoever reads the report reads it wrong. */}
        {state.sampling && (
          <div className="hint" style={{ marginTop: 10 }}>
            <b>{t('obsSampling')}</b>
            {' · '}
            {t('sources')} {state.sampling.sources?.k}/{state.sampling.sources?.n} · {t('watchTargets')}{' '}
            {state.sampling.watch?.k}/{state.sampling.watch?.n}
            {state.sampling.tor?.length ? ` · Tor: ${state.sampling.tor.join(', ')}` : ''}
            {state.sampling.skippedLogin?.length ? ` · ${t('obsSkippedLogin')}: ${state.sampling.skippedLogin.join(', ')}` : ''}
            <div className="muted small" style={{ marginTop: 4 }}>
              {t('obsSamplingNote')}
            </div>
          </div>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          {t('step')}: <b>{state.step}</b> · {t('sources')}: {state.sourcesDone}/{state.sourcesTotal}
          {(state.watchTotal ?? 0) > 0 && (
            <>
              {' '}
              · {t('watchTargets')}: {state.watchDone}/{state.watchTotal}
            </>
          )}
          {(state.itemCount ?? 0) > 0 && (
            <>
              {' '}
              · {t('items')}: {state.itemCount}
            </>
          )}
          {(state.alerts ?? 0) > 0 && (
            <>
              {' '}
              · <span className="chip alert">⚠ {t('alerts')}: {state.alerts}</span>
            </>
          )}
          {state.nextFire && (
            <>
              {' '}
              · {t('nextFire')}: {new Date(state.nextFire).toLocaleString()}
            </>
          )}
        </p>
        {state.lastError && <p style={{ color: 'var(--err)' }}>❌ {state.lastError}</p>}
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
      </section>

      <section className="panel">
        <h2>{t('lastResult')}</h2>
        {state.lastResult ? (
          <ul className="muted" style={{ margin: 0 }}>
            <li>mode: {state.lastResult.mode}</li>
            <li>date: {state.lastResult.date}</li>
            <li>
              sources: {state.lastResult.sourcesOk}/{state.lastResult.sourcesTotal}
            </li>
            <li>watch: {state.lastResult.watchTotal ?? 0} · alerts: {state.lastResult.alerts ?? 0}</li>
            <li>intel items: {state.lastResult.items ?? 0}</li>
            {state.lastResult.provider && (
              <li>
                llm: {state.lastResult.provider.name} · {state.lastResult.provider.model}
              </li>
            )}
            <li>report: {state.lastResult.file}</li>
          </ul>
        ) : (
          <p className="muted">{t('noResult')}</p>
        )}
      </section>

      <section className="panel">
        <h2>{t('tail')}</h2>
        <pre className="log">{(state.tail ?? []).join('\n') || '—'}</pre>
      </section>
    </>
  );
}
