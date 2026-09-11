// App.jsx — 六页壳 + 主题 + 排版变量 + 运行结束通知
import { useEffect, useRef, useState } from 'react';
import { useI18n, applyTheme } from './i18n.jsx';
import { LOCALES } from './locales/index.js';
import { applyLayout } from './layout.js';
import { api } from './api.js';
import Intel from './pages/Intel.jsx';
import Search from './pages/Search.jsx';
import Llm from './pages/Llm.jsx';
import Live from './pages/Live.jsx';
import Run from './pages/Run.jsx';
import Sources from './pages/Sources.jsx';
import Watch from './pages/Watch.jsx';
import Settings from './pages/Settings.jsx';
import Reports from './pages/Reports.jsx';

const TABS = ['intel', 'search', 'live', 'run', 'sources', 'watch', 'llm', 'settings', 'reports'];

export default function App() {
  const { t, localeCode, setLang } = useI18n();
  const [tab, setTab] = useState('run');
  const [alerts, setAlerts] = useState(0);
  const [layout, setLayout] = useState(null);
  const prevRun = useRef(null);

  useEffect(() => {
    let stop = false;
    api
      .getConfig()
      .then((c) => {
        if (stop) return;
        applyTheme(c.ui?.theme);
        setLayout(c.ui?.layout ?? {});
        applyLayout(c.ui?.layout);
      })
      .catch(() => {});

    // 设置页改排版时广播，壳立刻跟着变
    const onLayout = (e) => {
      setLayout(e.detail ?? {});
      applyLayout(e.detail);
    };
    window.addEventListener('vml-layout', onLayout);

    const tick = async () => {
      try {
        const st = await api.getState();
        const wasRunning = prevRun.current?.running;
        if (wasRunning && !st.running && st.finishedAt && st.finishedAt !== prevRun.current?.finishedAt) {
          const ok = !!st.lastResult;
          notify(ok ? t('runTitle') : `${t('runTitle')} · ${t('failed')}`, ok ? t('done') : st.lastError ?? '');
        }
        prevRun.current = { running: st.running, finishedAt: st.finishedAt };
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
      window.removeEventListener('vml-layout', onLayout);
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
    search: t('tab_search'),
    live: t('tab_live'),
    llm: t('tab_llm'),
    run: t('tab_run'),
    sources: t('tab_sources'),
    watch: t('tab_watch'),
    settings: t('tab_settings'),
    reports: t('tab_reports'),
  };

  const applyLayoutNow = (next) => {
    setLayout(next);
    applyLayout(next);
  };

  return (
    <>
      <header className="top">
        <div>
          <h1>{t('appTitle')}</h1>
          <div className="sub">{t('appSub')}</div>
        </div>
        <div className="spacer" />
        {alerts > 0 && (
          <span className="chip alert">
            ⚠ {alerts} {t('alerts')}
          </span>
        )}
        {/* 26 个地区没法用「中/英」两态按钮切换了：改成下拉，语言名用它自己的文字写 */}
        <select
          className="ghost lang"
          aria-label="language"
          value={localeCode}
          onChange={(e) => setLang(e.target.value)}
          title={t('language')}
        >
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </header>
      <nav className="tabs">
        {TABS.map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {labels[id]}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'intel' && <Intel layout={layout} />}
        {tab === 'search' && <Search layout={layout} />}
        {tab === 'live' && <Live />}
        {tab === 'llm' && <Llm />}
        {tab === 'run' && <Run />}
        {tab === 'sources' && <Sources />}
        {tab === 'watch' && <Watch />}
        {tab === 'settings' && <Settings onLayout={applyLayoutNow} />}
        {tab === 'reports' && <Reports layout={layout} />}
      </main>
    </>
  );
}
