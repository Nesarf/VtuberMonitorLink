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
import ConfigFaultBanner from './ConfigFaultBanner.jsx';

const TABS = ['intel', 'search', 'people', 'calendar', 'run', 'sources', 'watch', 'browser', 'llm', 'settings', 'reports'];

export default function App() {
  const { t, tn, localeCode, setLang } = useI18n();
  const [tab, setTab] = useState('run');
  const [alerts, setAlerts] = useState(0);
  const [layout, setLayout] = useState(null);
  const [about, setAbout] = useState(false);
  const [stateOk, setStateOk] = useState(false);
  // The config file's health, read on the shell's existing 3 s cadence (see `tick` below) rather than on a timer
  // of its own. `null` means "no answer yet or the route failed", and the banner renders nothing for it - the
  // hard case is a config damaged enough that the app is running on defaults, where the honest state is
  // "we do not know" until the route answers, never a guess made from the state name.
  const [configHealth, setConfigHealth] = useState(null);
  const prevRun = useRef(null);

  /**
   * Re-read the settings the *shell* itself is built from (theme, layout) and apply them.
   *
   * Extracted from the mount effect for the recovery path: `POST /api/config/recover` replaces the config file
   * with the backup, so the settings this page is displaying may not be the ones on disk any more. Re-reading is
   * how "after a successful recover, show the new state rather than assuming success" is true of the *shell* and
   * not only of the banner - a restored theme that only appeared after a manual reload would be the silent
   * substitution this release is about, in reverse.
   */
  const loadUiFromConfig = useCallback(() => {
    return api
      .getConfig()
      .then((c) => {
        applyTheme(c?.ui?.theme);
        setLayout(c?.ui?.layout ?? {});
        applyLayout(c?.ui?.layout);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    loadUiFromConfig();

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
        // "The shell is up and the API answered" as a fact in the DOM rather than as a property of the
        // network. It is the signal anything that has to *wait for this app* should use, because the
        // network can never tell it: `tick` below runs on a 3 s interval (and once immediately), so the
        // page is never quiet for the 500 ms a `networkidle` wait asks for — an automated walk that
        // waited for that would be asserting how loaded the machine is, which is exactly how it came to
        // pass on a quiet day and time out on a busy one. Set here and not before: `stateOk` flips only
        // after a real answer from `/api/state`, so the attribute cannot appear on a page that never
        // reached the service.
        setStateOk(true);
      } catch {
        /* stay silent while the service is not up */
      }
      // The config's health, on the same cadence and in its **own** try/catch. Two reasons it is separate
      // rather than folded into the block above: the two routes can fail independently, and - the case this
      // feature exists for - a config damaged enough to be running on defaults must not be able to take the
      // shell's readiness signal down with it. A failure here leaves `configHealth` at its previous value and
      // `data-vml-ready` exactly as it was.
      try {
        setConfigHealth(await api.getConfigHealth());
      } catch {
        /* the route is unreachable; the banner renders nothing rather than guessing */
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

  /**
   * The same signal, written to the document so a walk (tools/traverse-ui.cjs) or any other observer can
   * wait for it with an ordinary selector. In an effect rather than in the fetch callback on purpose: an
   * effect runs after React has committed, so a waiter that sees the attribute sees a rendered shell too.
   */
  useEffect(() => {
    if (stateOk) document.documentElement.setAttribute('data-vml-ready', '1');
  }, [stateOk]);

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
