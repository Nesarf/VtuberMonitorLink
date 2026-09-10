import { useEffect, useRef, useState } from 'react';
import { useI18n, applyTheme } from './i18n.jsx';
import { api } from './api.js';
import Intel from './pages/Intel.jsx';
import Run from './pages/Run.jsx';
import Sources from './pages/Sources.jsx';
import Watch from './pages/Watch.jsx';
import Settings from './pages/Settings.jsx';
import Reports from './pages/Reports.jsx';

const TABS = ['intel', 'run', 'sources', 'watch', 'settings', 'reports'];

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState('run');
  const [alerts, setAlerts] = useState(0);
  const prevRun = useRef(null);

  // 应用主题 + 订阅「运行结束」的桌面通知
  useEffect(() => {
    let stop = false;
    api
      .getConfig()
      .then((c) => {
        if (stop) return;
        applyTheme(c.ui?.theme);
      })
      .catch(() => {});

    const tick = async () => {
      try {
        const st = await api.getState();
        const wasRunning = prevRun.current?.running;
        const finishedAt = st.finishedAt;
        if (wasRunning && !st.running && finishedAt && finishedAt !== prevRun.current?.finishedAt) {
          const ok = !!st.lastResult;
          notify(ok ? t('runTitle') : `${t('runTitle')} · ${t('failed')}`, ok ? t('done') : st.lastError ?? '');
        }
        prevRun.current = { running: st.running, finishedAt };
        setAlerts(st.alerts ?? 0);
      } catch {
        /* 服务没起来时静默 */
      }
    };
    const timer = setInterval(tick, 3000);
    tick();
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const notify = (title, body) => {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') new Notification(title, { body: String(body).slice(0, 160) });
    } catch {
      /* 忽略 */
    }
  };

  const labels = {
    intel: t('tab_intel'),
    run: t('tab_run'),
    sources: t('tab_sources'),
    watch: t('tab_watch'),
    settings: t('tab_settings'),
    reports: t('tab_reports'),
  };

  return (
    <>
      <header className="top">
        <div>
          <h1>{t('appTitle')}</h1>
          <div className="sub">{t('appSub')}</div>
        </div>
        <div className="spacer" />
        {alerts > 0 && <span className="chip alert">⚠ {alerts} {t('alerts')}</span>}
        <button className="ghost lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
          {lang === 'zh' ? 'English' : '中文'}
        </button>
      </header>
      <nav className="tabs">
        {TABS.map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {labels[id]}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'intel' && <Intel />}
        {tab === 'run' && <Run />}
        {tab === 'sources' && <Sources />}
        {tab === 'watch' && <Watch />}
        {tab === 'settings' && <Settings />}
        {tab === 'reports' && <Reports />}
      </main>
    </>
  );
}
