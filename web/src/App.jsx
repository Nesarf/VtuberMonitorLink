// App.jsx — the six-page shell + theme + layout variables + run-finished notification
import { useEffect, useRef, useState } from 'react';
import { useI18n, applyTheme } from './i18n.jsx';
import { LOCALES } from './locales/index.js';
import { applyLayout, GOTO_EVENT } from './layout.js';
import { api } from './api.js';
import Intel from './pages/Intel.jsx';
import Search from './pages/Search.jsx';
import Llm from './pages/Llm.jsx';
import Run from './pages/Run.jsx';
import Sources from './pages/Sources.jsx';
import Watch from './pages/Watch.jsx';
import Browser from './pages/Browser.jsx';
import Settings from './pages/Settings.jsx';
import Reports from './pages/Reports.jsx';
import Calendar from './pages/Calendar.jsx';
import People from './pages/People.jsx';
import About from './About.jsx';

const TABS = ['intel', 'search', 'people', 'calendar', 'run', 'sources', 'watch', 'browser', 'llm', 'settings', 'reports'];

export default function App() {
  const { t, tn, localeCode, setLang } = useI18n();
  const [tab, setTab] = useState('run');
  const [alerts, setAlerts] = useState(0);
  const [layout, setLayout] = useState(null);
  const [about, setAbout] = useState(false);
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

    // Broadcast when the settings page changes the layout, so the shell follows immediately
    const onLayout = (e) => {
      setLayout(e.detail ?? {});
      applyLayout(e.detail);
    };
    window.addEventListener('vml-layout', onLayout);

    // A page asking the shell to show another tab (see requestTab in layout.js). The one case today is a
    // login check that reports "no profile dir is configured": it offers the page that fills it in, and any
    // page can offer that without knowing anything about how tabs work.
    const onGoto = (e) => {
      const id = String(e?.detail ?? '');
      if (TABS.includes(id)) setTab(id);
    };
    window.addEventListener(GOTO_EVENT, onGoto);

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
        /* stay silent while the service is not up */
      }
    };
    const timer = setInterval(tick, 3000);
    tick();
    return () => {
      stop = true;
      clearInterval(timer);
      window.removeEventListener('vml-layout', onLayout);
      window.removeEventListener(GOTO_EVENT, onGoto);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const notify = (title, body) => {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') new Notification(title, { body: String(body).slice(0, 160) });
    } catch {
      /* ignore */
    }
  };

  // Display names of the tabs. **Adding a tab means changing this too** -- if you only add an id to TABS,
  // labels[id] is undefined and the tab renders blank (only noticed when a walkthrough clicks tabs by name).
  const labels = {
    intel: t('tab_intel'),
    search: t('tab_search'),
    calendar: t('tab_calendar'),
    people: t('tab_people'),
    llm: t('tab_llm'),
    run: t('tab_run'),
    sources: t('tab_sources'),
    watch: t('tab_watch'),
    browser: t('tab_browser'),
    settings: t('tab_settings'),
    reports: t('tab_reports'),
  };
  // Fallback: if one is missed again, at least show the id rather than a blank
  const labelOf = (id) => labels[id] || id;

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
            ⚠ {tn('alerts', alerts)}
          </span>
        )}
        {/* The README, without leaving the page: opens over the current view and switches language in place */}
        <button className="ghost" onClick={() => setAbout(true)} title={t('aboutHint')} data-testid="about-open">
          {t('aboutTitle')}
        </button>
        {/* 26 locales cannot be switched with a two-state "zh/en" button any more: it is a dropdown now, and each language name is written in its own script */}
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
            {labelOf(id)}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'intel' && <Intel layout={layout} />}
        {tab === 'search' && <Search layout={layout} />}
        {tab === 'llm' && <Llm />}
        {tab === 'run' && <Run />}
        {tab === 'sources' && <Sources />}
        {tab === 'watch' && <Watch />}
        {tab === 'browser' && <Browser />}
        {tab === 'settings' && <Settings onLayout={applyLayoutNow} />}
        {tab === 'reports' && <Reports layout={layout} />}
        {tab === 'calendar' && <Calendar />}
        {tab === 'people' && <People />}
      </main>
      <About open={about} onClose={() => setAbout(false)} />
    </>
  );
}
