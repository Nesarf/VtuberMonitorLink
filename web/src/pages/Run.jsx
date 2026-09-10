// 运行页：立即运行 + 实时状态 / Run page with live state
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
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          {t('step')}: <b>{state.step}</b> · {t('sources')}: {state.sourcesDone}/{state.sourcesTotal}
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
