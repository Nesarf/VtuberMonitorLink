// Settings.jsx — settings page: browser / proxy / schedule / appearance / scheduled tasks / push / layout / nodes / import-export / privacy
// Note: LLM and the API key were split out into their own page (pages/Llm.jsx) - buried in the settings
// page the user could not find them at all, and with no provider profile the inputs were not even rendered.
import { useEffect, useRef, useState } from 'react';
import { useI18n, applyTheme } from '../i18n.jsx';
import { api } from '../api.js';
import { SaveBar, useSaveState } from '../savebar.jsx';
import Collapsible from '../Collapsible.jsx';
import { Inline } from '../markdown.jsx';

export default function Settings({ onLayout }) {
  const { t, tn, lang, weekdaysSunFirst: WEEKDAYS, fmtTime, fmtDateTime } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [browsers, setBrowsers] = useState([]);
  const [presets, setPresets] = useState([]);
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState('');
  const st = useSaveState();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [newPreset, setNewPreset] = useState('deepseek');
  const [domain, setDomain] = useState('bilibili.com');
  const [loginMsg, setLoginMsg] = useState('');
  const [loginOk, setLoginOk] = useState(false);
  // scheduled tasks / notifications / nodes / import-export
  // Note: every hook must sit above the `if (!cfg) return` below - otherwise the first frame and the
  // frame after the data arrives have a different hook count, React throws #310 and unmounts the whole tree.
  const [sched, setSched] = useState(null);
  const [notifyInfo, setNotifyInfo] = useState(null);
  const [nodes, setNodes] = useState(null);
  const [nodeTestUrl, setNodeTestUrl] = useState('https://www.bilibili.com/');
  const [nodeDelays, setNodeDelays] = useState(null);
  const [newNotifyKind, setNewNotifyKind] = useState('bark');
  // Task-name debounce timer: **must be before the early return**, otherwise the first frame and later
  // frames have a different hook count -> React #310
  const scheduleSaveTimer = useRef(null);

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setMsg(e.message));
    api.getBrowsers().then((b) => setBrowsers(b.detected ?? [])).catch(() => {});
    api.getSchedule().then(setSched).catch(() => {});
    api.getNotify().then(setNotifyInfo).catch(() => {});
  }, []);

  if (!cfg) return <div className="panel">{t('loading')}</div>;

  const providers = cfg.llm?.providers ?? [];
  const activeId = cfg.llm?.activeId ?? providers[0]?.id ?? '';
  const active = providers.find((p) => p.id === activeId) ?? providers[0] ?? null;

  const patch = (path, value) => {
    st.dirty();
    setCfg((c) => {
      const next = structuredClone(c);
      const keys = path.split('.');
      let cur = next;
      for (const k of keys.slice(0, -1)) cur = cur[k];
      cur[keys.at(-1)] = value;
      return next;
    });
  };

  const patchProvider = (field, value) => {
    if (!active) return;
    st.dirty();
    setCfg((c) => {
      const next = structuredClone(c);
      const list = next.llm.providers ?? [];
      const i = list.findIndex((p) => p.id === (next.llm.activeId ?? list[0]?.id));
      if (i < 0) return next;
      list[i][field] = value;
      return next;
    });
  };

  const flash = (m, ms = 2500, kind = '') => {
    setMsg(m);
    setMsgKind(kind);
    if (ms) setTimeout(() => setMsg(''), ms);
  };

  const save = async () => {
    setBusy(true);
    st.saving();
    try {
      const next = await api.putConfig(cfg);
      setCfg(next);
      applyTheme(next.ui?.theme);
      st.saved();
      flash(`${t('saved')} · ${fmtTime(Date.now())}`, 4000, 'ok');
    } catch (e) {
      st.failed(e.message);
      flash(e.message, 0, 'err');
    } finally {
      setBusy(false);
    }
  };

  const testLlm = async () => {
    setBusy(true);
    flash(t('testing'), 0);
    try {
      await api.putConfig(cfg);
      const r = await api.testLlmProvider(active);
      flash(r.ok ? `✅ ${t('testLlm')}: OK · ${r.provider?.model ?? ''}` : `❌ ${r.error}`, 0);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    if (!active) return;
    setBusy(true);
    flash(t('testing'), 0);
    try {
      await api.putConfig(cfg);
      const r = await api.listLlmModels(active);
      if (r.ok) {
        patchProvider('models', r.models);
        flash(`${t('llmModelsFetched')}: ${r.models.length}`);
      } else {
        flash(`❌ ${r.error}`, 0);
      }
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const addProfile = async () => {
    setBusy(true);
    try {
      await api.putConfig(cfg);
      const r = await api.newLlmProvider(newPreset, {});
      setCfg(await api.getConfig());
      flash(`${t('llmAddProfile')}: ${r.provider?.name}`);
    } catch (e) {
      flash(e.message, 0);
    } finally {
      setBusy(false);
    }
  };

  const deleteProfile = () => {
    if (!active) return;
    setCfg((c) => {
      const next = structuredClone(c);
      next.llm.providers = (next.llm.providers ?? []).filter((p) => p.id !== active.id);
      next.llm.activeId = next.llm.providers[0]?.id ?? '';
      return next;
    });
  };

  // Read-only login-state extraction: report the cookie count and names, never hand back any value
  const checkLogin = async () => {
    setBusy(true);
    setLoginMsg(t('checkingLogin'));
    try {
      const r = await api.checkCookies({ profileDir: cfg.browser.profileDir, domains: [domain.trim() || 'bilibili.com'] });
      setLoginOk(!!(r.ok && r.hasSession));
      if (r.ok && r.hasSession)
        setLoginMsg(`✅ ${t('loginOk')}: ${tn('cookieCountWithSession', r.cookieCount)} · ${r.profile ?? ''}`);
      else if (r.ok)
        setLoginMsg(`⚠️ ${t('loginNoSession')}: ${tn('cookieCount', r.cookieCount)} · ${(r.names ?? []).slice(0, 8).join(', ')}`);
      else setLoginMsg(`❌ ${t('loginNone')}: ${r.error ?? ''}`);
      if (r.warning) setLoginMsg((m) => `${m} ｜ ${r.warning}`);
    } catch (e) {
      setLoginOk(false);
      setLoginMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  // -- scheduled tasks / notifications / nodes / import-export (handlers live here, the hooks were
  // moved above the early return) --
  const loadSched = () => api.getSchedule().then(setSched).catch(() => {});
  const loadNotify = () => api.getNotify().then(setNotifyInfo).catch(() => {});

  const saveSchedule = async (tasks) => {
    setBusy(true);
    st.saving();
    try {
      await api.putConfig({ ...cfg, schedule: { ...cfg.schedule, tasks } });
      await loadSched();
      st.saved();
      flash(`${t('saved')} · ${fmtTime(Date.now())}`, 3000, 'ok');
    } catch (e) {
      st.failed(e.message);
      flash(e.message, 0, 'err');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The task name is a text box: it must not PUT the config on every keystroke - that is a request storm
   * and it also rewrites the config to disk over and over (measured: typing 10 characters sent 10 PUTs).
   * Change it locally first, save 800ms after typing stops.
   */
  const onTaskNameChange = (id, name) => {
    st.dirty();
    const tasks = (cfg.schedule?.tasks ?? []).map((x) => (x.id === id ? { ...x, name } : x));
    setCfg((c) => ({ ...c, schedule: { ...c.schedule, tasks } }));
    if (scheduleSaveTimer.current) clearTimeout(scheduleSaveTimer.current);
    scheduleSaveTimer.current = setTimeout(() => {
      scheduleSaveTimer.current = null;
      saveSchedule(tasks);
    }, 800);
  };

  const addTask = async () => {
    const tasks = [
      ...(cfg.schedule?.tasks ?? []),
      {
        id: `task-${Date.now().toString(36)}`,
        name: `${t('taskMode_daily')} ${(cfg.schedule?.tasks?.length ?? 0) + 1}`,
        enabled: true,
        mode: 'daily',
        freq: 'weekly',
        dayOfWeek: 2,
        time: '23:30',
        catchUp: true,
      },
    ];
    setCfg((c) => ({ ...c, schedule: { ...c.schedule, tasks } }));
    await saveSchedule(tasks);
  };

  const patchTask = async (id, patch) => {
    const tasks = (cfg.schedule?.tasks ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x));
    setCfg((c) => ({ ...c, schedule: { ...c.schedule, tasks } }));
    await saveSchedule(tasks);
  };

  const removeTask = async (id) => {
    const tasks = (cfg.schedule?.tasks ?? []).filter((x) => x.id !== id);
    setCfg((c) => ({ ...c, schedule: { ...c.schedule, tasks } }));
    await saveSchedule(tasks);
  };

  const addNotify = async () => {
    setBusy(true);
    try {
      await api.putConfig(cfg);
      await api.newNotify(newNotifyKind, {});
      const fresh = await api.getConfig();
      setCfg(fresh);
      await loadNotify();
      flash(t('saved'));
    } catch (e) {
      flash(e.message, 0);
    } finally {
      setBusy(false);
    }
  };

  const patchNotify = (id, patch) => {
    setCfg((c) => ({
      ...c,
      notify: { ...(c.notify ?? {}), targets: (c.notify?.targets ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) },
    }));
  };

  const removeNotify = (id) => {
    setCfg((c) => ({
      ...c,
      notify: { ...(c.notify ?? {}), targets: (c.notify?.targets ?? []).filter((x) => x.id !== id) },
    }));
  };

  const testNotify = async (target) => {
    setBusy(true);
    flash(t('testing'), 0);
    try {
      await api.putConfig(cfg);
      const r = await api.testNotify(target);
      flash(r.ok ? `✅ ${t('notifyTestOk')}` : `❌ ${r.result?.error ?? 'failed'}`, 0);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const detectNodes = async () => {
    setBusy(true);
    flash(t('detecting'), 0);
    try {
      const d = await api.proxyControl();
      if (!d.ok) return flash(`❌ ${d.error ?? t('controlNotFound')}`, 0);
      const n = await api.proxyNodes(d.url);
      setNodes(n);
      flash(`✅ ${t('controlFound')}: ${d.url}${d.version ? ` (${d.version})` : ''}`);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const testNodes = async (group) => {
    setBusy(true);
    flash(t('probing'), 0);
    try {
      const r = await api.proxyNodeTest({
        group: group.name,
        nodes: group.nodes.map((n) => n.name),
        url: nodeTestUrl,
      });
      setNodeDelays({ group: group.name, ...r });
      flash(`${t('done')}: ${group.name}`);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const switchNode = async (group, node) => {
    setBusy(true);
    try {
      await api.proxyNodeSelect({ group, node });
      flash(`✅ ${t('switched')}: ${node}`);
      const d = await api.proxyControl();
      if (d.ok) setNodes(await api.proxyNodes(d.url));
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const r = await api.importConfig(parsed.config ?? parsed);
      setCfg(r.config);
      applyTheme(r.config.ui?.theme);
      onLayout?.(r.config.ui?.layout);
      await loadNotify();
      await loadSched();
      flash(t('imported'));
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  // Tor anonymous egress: probe the port + confirm whether the exit really is Tor; optionally launch the configured tor.exe in one click
  const checkTor = async () => {
    setBusy(true);
    flash(t('checkingLogin'), 0);
    try {
      const r = await api.probeTor(cfg.proxy?.torSocks);
      if (!r.ok) flash(`❌ ${t('torFail')}: ${r.error}`, 0);
      else if (r.isTor === true) flash(`✅ ${t('torOk')} · ${r.socks} · IP ${r.ip}`, 0);
      else flash(`⚠️ ${t('torNotTor')} · ${r.socks}${r.ip ? ` · IP ${r.ip}` : ''}`, 0);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const startTor = async () => {
    setBusy(true);
    try {
      const r = await api.startTor(cfg.proxy?.torExe);
      flash(r.ok ? `✅ ${r.hint ?? 'started'}` : `❌ ${r.error}`, 0);
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const detectProxy = async () => {
    setBusy(true);
    flash(t('proxyDetecting'), 0);
    try {
      const r = await api.detectProxy();
      if (r.found?.length) {
        setCfg((c) => ({ ...c, proxy: { ...(c.proxy ?? {}), enabled: true, url: r.found[0] } }));
        flash(`✅ ${t('proxyFound')}: ${r.found.join(', ')}`);
      } else {
        flash(`⚠️ ${t('proxyNone')}`);
      }
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* -- Browser -- */}
      <section className="panel">
        <h2>{t('browserTitle')}</h2>
        <div className="hint">{t('browserHint')}</div>
        <div className="row">
          <div className="field">
            <label>{t('mode')}</label>
            <select value={cfg.browser.mode} onChange={(e) => patch('browser.mode', e.target.value)}>
              <option value="bundled">{t('mode_bundled')}</option>
              <option value="system">{t('mode_system')}</option>
              <option value="custom">{t('mode_custom')}</option>
            </select>
          </div>
          <div className="field">
            <label>{t('headless')}</label>
            <select
              value={String(cfg.browser.headless)}
              onChange={(e) => patch('browser.headless', e.target.value === 'true')}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div className="field">
            <label>{t('waitMs')}</label>
            <input
              type="number"
              value={cfg.browser.waitMs}
              onChange={(e) => patch('browser.waitMs', Number(e.target.value))}
            />
          </div>
        </div>

        {cfg.browser.mode !== 'bundled' && (
          <div className="row">
            <div className="field">
              <label>{t('executablePath')}</label>
              {browsers.length > 0 && (
                <select value="" onChange={(e) => e.target.value && patch('browser.executablePath', e.target.value)}>
                  <option value="">{t('detected')}…</option>
                  {browsers.map((b) => (
                    <option key={b.executablePath} value={b.executablePath}>
                      {b.name} — {b.executablePath}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={cfg.browser.executablePath}
                onChange={(e) => patch('browser.executablePath', e.target.value)}
                placeholder="C:\\path\\to\\browser.exe"
              />
            </div>
            <div className="field">
              <label>{t('profileDir')}</label>
              <input
                value={cfg.browser.profileDir}
                onChange={(e) => patch('browser.profileDir', e.target.value)}
                placeholder="C:\\Users\\you\\AppData\\...\\User Data"
              />
              <div className="hint" style={{ margin: 0 }}>{t('profileHint')}</div>
            </div>
          </div>
        )}

        {/* -- login-state probe: read-only extraction, works even with the browser open -- */}
        <div className="row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('domainLabel')}</label>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="bilibili.com" />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={checkLogin} disabled={busy || !cfg.browser.profileDir}>
              {busy ? t('checkingLogin') : t('checkLogin')}
            </button>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="hint" style={{ margin: 0 }}><Inline text={t('loginHint')} /></div>
            {loginMsg && <div className={loginOk ? 'hint ok-text' : 'hint warn-text'} style={{ margin: 0 }}>{loginMsg}</div>}
          </div>
        </div>
      </section>

      {/* -- Proxy -- */}
      <section className="panel">
        <h2>{t('proxyTitle')}</h2>
        <div className="hint">{t('proxyHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('proxyModeTitle')}</label>
            <select value={cfg.proxy?.mode === 'tor' ? 'tor' : 'http'} onChange={(e) => patch('proxy.mode', e.target.value)}>
              <option value="http">{t('mode_http')}</option>
              <option value="tor">{t('mode_tor')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('proxyEnabled')}</label>
            <select
              value={String(cfg.proxy?.enabled ?? false)}
              onChange={(e) => patch('proxy.enabled', e.target.value === 'true')}
              disabled={cfg.proxy?.mode === 'tor'}
            >
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field">
            <label>{t('proxyUrl')}</label>
            <input
              value={cfg.proxy?.url ?? ''}
              onChange={(e) => patch('proxy.url', e.target.value)}
              placeholder="http://127.0.0.1:7890"
              disabled={cfg.proxy?.mode === 'tor'}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={detectProxy} disabled={busy || cfg.proxy?.mode === 'tor'}>
              {busy ? t('proxyDetecting') : t('proxyDetect')}
            </button>
          </div>
        </div>

        {/* Tor anonymous egress */}
        <div className="row">
          <div className="field">
            <label>{t('torSocks')}</label>
            <input
              value={cfg.proxy?.torSocks ?? ''}
              onChange={(e) => patch('proxy.torSocks', e.target.value)}
              placeholder="socks5://127.0.0.1:9150"
            />
          </div>
          <div className="field">
            <label>{t('torExe')}</label>
            <input
              value={cfg.proxy?.torExe ?? ''}
              onChange={(e) => patch('proxy.torExe', e.target.value)}
              placeholder="...\\TorBrowser\\Tor\\tor.exe"
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={checkTor} disabled={busy}>
              {t('torProbe')}
            </button>{' '}
            <button className="ghost" onClick={startTor} disabled={busy || !cfg.proxy?.torExe}>
              {t('torStart')}
            </button>
          </div>
        </div>
        <div className="hint" style={{ margin: 0 }}>{t('torHint')}</div>
      </section>

      {/* -- Schedule -- */}
      <section className="panel">
        <h2>{t('scheduleTitle')}</h2>
        <div className="hint">{t('scheduleHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('enabled')}</label>
            <select
              value={String(cfg.schedule.enabled)}
              onChange={(e) => patch('schedule.enabled', e.target.value === 'true')}
            >
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('mode')}</label>
            <select value={cfg.schedule.mode} onChange={(e) => patch('schedule.mode', e.target.value)}>
              <option value="weekly">{t('mode_weekly')}</option>
              <option value="daily">{t('mode_daily')}</option>
            </select>
          </div>
          {cfg.schedule.mode === 'weekly' && (
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label>{t('dayOfWeek')}</label>
              <select
                value={cfg.schedule.dayOfWeek}
                onChange={(e) => patch('schedule.dayOfWeek', Number(e.target.value))}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={i} value={i}>{d}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('time')}</label>
            <input
              type="time"
              value={cfg.schedule.time}
              onChange={(e) => patch('schedule.time', e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('merchEveryDays')}</label>
            <input
              type="number"
              value={cfg.schedule.merchEveryDays}
              onChange={(e) => patch('schedule.merchEveryDays', Number(e.target.value))}
            />
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('watchWithRun')}</label>
            <select
              value={String(cfg.run?.watchWithRun !== false)}
              onChange={(e) => patch('run.watchWithRun', e.target.value === 'true')}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </div>
        </div>
      </section>

      {/* -- Observation mode -- */}
      <section className="panel">
        <h2>{t('obsTitle')}</h2>
        <div className="hint">{t('obsHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('obsEnabled')}</label>
            <select value={String(cfg.observation?.enabled === true)} onChange={(e) => patch('observation.enabled', e.target.value === 'true')}>
              <option value="false">{t('disable')}</option>
              <option value="true">{t('enable')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('obsRatio')}</label>
            <select value={String(cfg.observation?.sampleRatio ?? 0.5)} onChange={(e) => patch('observation.sampleRatio', Number(e.target.value))}>
              {[0.25, 0.34, 0.5, 0.67, 1].map((v) => (
                <option key={v} value={String(v)}>
                  {Math.round(v * 100)}%
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('obsJitter')}</label>
            <select
              value={JSON.stringify(cfg.observation?.jitterSeconds ?? [3, 12])}
              onChange={(e) => patch('observation.jitterSeconds', JSON.parse(e.target.value))}
            >
              <option value="[0,0]">{t('obsJitterNone')}</option>
              <option value="[3,12]">3–12s</option>
              <option value="[10,60]">10–60s</option>
              <option value="[60,300]">1–5min</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('obsTorAgency')}</label>
            <select
              value={String(cfg.observation?.torForAgency !== false)}
              onChange={(e) => patch('observation.torForAgency', e.target.value === 'true')}
            >
              <option value="true">{t('enable')}</option>
              <option value="false">{t('disable')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('obsSkipLogin')}</label>
            <select
              value={String(cfg.observation?.skipLoginSources !== false)}
              onChange={(e) => patch('observation.skipLoginSources', e.target.value === 'true')}
            >
              <option value="true">{t('enable')}</option>
              <option value="false">{t('disable')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('obsRotateExit')}</label>
            <select
              value={String(cfg.observation?.rotateExit !== false)}
              onChange={(e) => patch('observation.rotateExit', e.target.value === 'true')}
            >
              <option value="true">{t('enable')}</option>
              <option value="false">{t('disable')}</option>
            </select>
          </div>
        </div>
        <div className="hint" style={{ marginBottom: 0 }}>{t('obsRotationHint')}</div>
      </section>

      {/* -- Appearance -- */}
      <section className="panel">
        <h2>{t('uiTitle')}</h2>
        <div className="hint">{t('uiHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('theme')}</label>
            <select
              value={cfg.ui?.theme ?? 'dark'}
              onChange={(e) => {
                patch('ui.theme', e.target.value);
                applyTheme(e.target.value);
              }}
            >
              <option value="auto">{t('themeAuto')}</option>
              <option value="light">{t('themeLight')}</option>
              <option value="dark">{t('themeDark')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('notify')}</label>
            <select
              value={String(cfg.ui?.notify !== false)}
              onChange={(e) => {
                const on = e.target.value === 'true';
                patch('ui.notify', on);
                if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                  Notification.requestPermission().catch(() => {});
                }
              }}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
            <div className="hint" style={{ margin: 0 }}>{t('notifyHint')}</div>
          </div>
        </div>
      </section>

      {/* -- scheduled tasks -- */}
      <section className="panel tasks">
        <h2>{t('scheduleTasks')}</h2>
        <div className="hint">{t('scheduleHint2')}</div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 50 }}>{t('enabledCol')}</th>
              <th>{t('taskName')}</th>
              <th style={{ width: 130 }}>{t('taskMode')}</th>
              <th style={{ width: 150 }}>{t('freq')}</th>
              <th style={{ width: 100 }}>{t('time')}</th>
              <th style={{ width: 90 }}>{t('catchUp')}</th>
              <th style={{ width: 190 }}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(cfg.schedule?.tasks ?? []).map((task) => {
              const live = (sched?.tasks ?? []).find((x) => x.id === task.id);
              return (
                <tr key={task.id} className={task.enabled === false ? 'row-off' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${task.name || t('taskName')} · ${t('enabledCol')}`}
                      checked={task.enabled !== false}
                      onChange={(e) => patchTask(task.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${t('taskName')} · ${task.id}`}
                      value={task.name}
                      onChange={(e) => onTaskNameChange(task.id, e.target.value)}
                      onBlur={() => saveSchedule(cfg.schedule.tasks ?? [])}
                    />
                    {live?.nextFire && (
                      <div className="muted small">
                        {t('nextFireAt')}: {fmtDateTime(live.nextFire)}
                        {live.lastFire ? ` · ${t('lastFire')}: ${fmtDateTime(live.lastFire)}` : ''}
                      </div>
                    )}
                    {live?.preview?.length ? (
                      <ul className="preview-list">
                        {live.preview.slice(0, 3).map((p, i) => (
                          <li key={i}>{fmtDateTime(p)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td>
                    <select
                      aria-label={`${task.name || t('taskName')} · ${t('taskMode')}`}
                      value={task.mode}
                      onChange={(e) => patchTask(task.id, { mode: e.target.value })}
                    >
                      <option value="daily">{t('taskMode_daily')}</option>
                      <option value="merch">{t('taskMode_merch')}</option>
                      <option value="watch">{t('taskMode_watch')}</option>
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${task.name || t('taskName')} · ${t('freq')}`}
                      value={task.freq}
                      onChange={(e) => patchTask(task.id, { freq: e.target.value })}
                    >
                      <option value="weekly">{t('freq_weekly')}</option>
                      <option value="daily">{t('freq_daily')}</option>
                    </select>
                    {task.freq === 'weekly' && (
                      <select
                        aria-label={`${task.name || t('taskName')} · ${t('freq')} · ${WEEKDAYS[task.dayOfWeek] ?? ''}`}
                        style={{ marginTop: 4 }}
                        value={task.dayOfWeek}
                        onChange={(e) => patchTask(task.id, { dayOfWeek: Number(e.target.value) })}
                      >
                        {WEEKDAYS.map((d, i) => (
                          <option key={i} value={i}>{d}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    <input
                      type="time"
                      aria-label={`${task.name || t('taskName')} · ${t('time')}`}
                      value={task.time}
                      onChange={(e) => patchTask(task.id, { time: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${task.name || t('taskName')} · ${t('catchUp')}`}
                      checked={task.catchUp !== false}
                      onChange={(e) => patchTask(task.id, { catchUp: e.target.checked })}
                    />
                  </td>
                  <td>
                    <button className="ghost tiny" onClick={() => api.runSchedule(task.id).then(loadSched)} disabled={busy}>
                      {t('taskRunNow')}
                    </button>{' '}
                    <button className="ghost tiny danger" onClick={() => removeTask(task.id)} disabled={busy}>
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button className="ghost add-task" onClick={addTask} disabled={busy} style={{ marginTop: 8 }}>
          {t('addTask')}
        </button>

        <h3 style={{ fontSize: 13, marginTop: 18 }}>{t('historyTitle')}</h3>
        {(sched?.history ?? []).length === 0 ? (
          <p className="muted small">{t('noScheduleHistory')}</p>
        ) : (
          <ul className="muted small" style={{ paddingLeft: 18 }}>
            {sched.history.slice(0, 10).map((h, i) => (
              <li key={i}>
                {fmtDateTime(h.at)} · {h.name ?? h.taskId} · {h.mode ?? ''} {h.catchUp ? t('catchUpTag') : ''}{' '}
                {h.ok ? '✅' : `❌ ${h.error ?? ''}`}
                {h.items != null ? ` · ${tn('items', h.items)}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* -- alert push -- */}
      <section className="panel">
        <h2>{t('notifyTitle')}</h2>
        <div className="hint">{t('notifyPanelHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('addTarget')}</label>
            <div className="row" style={{ gap: 6 }}>
              <select value={newNotifyKind} onChange={(e) => setNewNotifyKind(e.target.value)} style={{ flex: 1 }}>
                {(notifyInfo?.kinds ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
              <button className="ghost tiny" onClick={addNotify} disabled={busy}>
                +
              </button>
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('desktopNotify')}</label>
            <select
              value={String(cfg.notify?.desktop !== false)}
              onChange={(e) => patch('notify.desktop', e.target.value === 'true')}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('notifyDedupe')}</label>
            <input
              type="number"
              min="0"
              max="1440"
              value={cfg.notify?.dedupeMinutes ?? 0}
              onChange={(e) => patch('notify.dedupeMinutes', Number(e.target.value))}
            />
          </div>
        </div>

        {/* -- quiet hours: queued for later delivery, not discarded -- */}
        <Collapsible
          id="notify-quiet"
          title={t('quietTitle')}
          count={notifyInfo?.queue?.length || null}
          summary={
            notifyInfo?.quiet?.quiet
              ? `🔕 ${t('quietNow')}${notifyInfo.quiet.reason ? ` · ${notifyInfo.quiet.reason}` : ''}`
              : notifyInfo?.quiet?.error
                ? `⚠ ${notifyInfo.quiet.error}`
                : t('quietSummary')
          }
          right={
            notifyInfo?.queue?.length ? (
              <button
                className="ghost tiny"
                onClick={() => api.flushNotify().then(loadNotify).catch(() => {})}
              >
                {t('quietFlush')}
              </button>
            ) : null
          }
        >
          <div className="row">
            <div className="field" style={{ flex: '0 0 120px' }}>
              <label>{t('quietEnabled')}</label>
              <select
                value={String(cfg.notify?.quietHours?.enabled === true)}
                onChange={(e) => patch('notify.quietHours.enabled', e.target.value === 'true')}
              >
                <option value="false">off</option>
                <option value="true">on</option>
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 110px' }}>
              <label>{t('quietStart')}</label>
              <input
                type="time"
                value={cfg.notify?.quietHours?.start ?? '23:00'}
                onChange={(e) => patch('notify.quietHours.start', e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: '0 0 110px' }}>
              <label>{t('quietEnd')}</label>
              <input
                type="time"
                value={cfg.notify?.quietHours?.end ?? '08:00'}
                onChange={(e) => patch('notify.quietHours.end', e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: '0 0 130px' }}>
              <label>{t('quietDays')}</label>
              <select
                value={cfg.notify?.quietHours?.days ?? 'all'}
                onChange={(e) => patch('notify.quietHours.days', e.target.value)}
              >
                <option value="all">{t('daysAll')}</option>
                <option value="weekdays">{t('daysWeekdays')}</option>
                <option value="weekend">{t('daysWeekend')}</option>
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label>{t('quietTz')}</label>
              <input
                value={cfg.notify?.quietHours?.timeZone ?? ''}
                onChange={(e) => patch('notify.quietHours.timeZone', e.target.value)}
                placeholder={t('quietTzPh')}
              />
            </div>
          </div>
          <div className="hint" style={{ marginBottom: 0 }}>{t('quietHint')}</div>
          {notifyInfo?.queue?.length ? (
            <ul className="muted small" style={{ paddingLeft: 18 }}>
              {notifyInfo.queue.slice(-5).map((q) => (
                <li key={q.id}>
                  {q.queuedAt.slice(11, 19)} · {q.title} <span className="muted">({q.reason})</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Collapsible>

        {(cfg.notify?.targets ?? []).length === 0 ? (
          <p className="muted small">—</p>
        ) : (
          (cfg.notify?.targets ?? []).map((ntf) => {
            const kind = (notifyInfo?.kinds ?? []).find((k) => k.id === ntf.kind);
            return (
              <div className="row" key={ntf.id} style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: '0 0 150px' }}>
                  <label>{t('notifyKind')}</label>
                  <input value={ntf.name ?? kind?.name ?? ntf.kind} onChange={(e) => patchNotify(ntf.id, { name: e.target.value })} />
                </div>
                {kind?.fields?.includes('key') && (
                  <div className="field">
                    <label>{ntf.kind === 'bark' ? 'Bark key' : 'SendKey'}</label>
                    <input value={ntf.key ?? ''} onChange={(e) => patchNotify(ntf.id, { key: e.target.value })} />
                  </div>
                )}
                {kind?.fields?.includes('server') && (
                  <div className="field">
                    <label>Server</label>
                    <input value={ntf.server ?? ''} onChange={(e) => patchNotify(ntf.id, { server: e.target.value })} placeholder="https://api.day.app" />
                  </div>
                )}
                {kind?.fields?.includes('token') && (
                  <div className="field">
                    <label>Bot Token</label>
                    <input value={ntf.token ?? ''} onChange={(e) => patchNotify(ntf.id, { token: e.target.value })} />
                  </div>
                )}
                {kind?.fields?.includes('chatId') && (
                  <div className="field" style={{ flex: '0 0 140px' }}>
                    <label>chat_id</label>
                    <input value={ntf.chatId ?? ''} onChange={(e) => patchNotify(ntf.id, { chatId: e.target.value })} />
                  </div>
                )}
                {kind?.fields?.includes('topic') && (
                  <div className="field" style={{ flex: '0 0 140px' }}>
                    <label>topic</label>
                    <input value={ntf.topic ?? ''} onChange={(e) => patchNotify(ntf.id, { topic: e.target.value })} placeholder="vml" />
                  </div>
                )}
                {kind?.fields?.includes('secret') && (
                  <div className="field" style={{ flex: '0 0 160px' }}>
                    <label>{t('notifySecret')}</label>
                    <input value={ntf.secret ?? ''} onChange={(e) => patchNotify(ntf.id, { secret: e.target.value })} placeholder={t('notifySecretPh')} />
                  </div>
                )}
                {kind?.fields?.includes('webhookUrl') && (
                  <div className="field">
                    <label>Webhook URL</label>
                    <input value={ntf.webhookUrl ?? ''} onChange={(e) => patchNotify(ntf.id, { webhookUrl: e.target.value })} />
                  </div>
                )}
                <div className="field" style={{ flex: '0 0 140px' }}>
                  <label>{t('notifyOn')}</label>
                  <select value={ntf.on ?? 'alerts'} onChange={(e) => patchNotify(ntf.id, { on: e.target.value })}>
                    <option value="alerts">{t('on_alerts')}</option>
                    <option value="always">{t('on_always')}</option>
                    <option value="failures">{t('on_failures')}</option>
                  </select>
                </div>
                <div className="field" style={{ flex: '0 0 150px' }}>
                  <label>{t('notifyQuiet')}</label>
                  <select value={ntf.quiet ?? 'inherit'} onChange={(e) => patchNotify(ntf.id, { quiet: e.target.value })}>
                    <option value="inherit">{t('quietInherit')}</option>
                    <option value="bypass">{t('quietBypass')}</option>
                  </select>
                </div>
                <div className="field" style={{ flex: '0 0 auto' }}>
                  <button className="ghost tiny" onClick={() => testNotify(ntf)} disabled={busy}>
                    {t('testNotify')}
                  </button>{' '}
                  <button className="ghost tiny danger" onClick={() => removeNotify(ntf.id)} disabled={busy}>
                    {t('delete')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* -- layout DIY -- */}
      <section className="panel">
        <h2>{t('layoutTitle')}</h2>
        <div className="hint">{t('layoutHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 260px' }}>
            <label>{t('layoutMode')}</label>
            <select
              value={cfg.ui?.layout?.mode ?? 'cards'}
              onChange={(e) => {
                patch('ui.layout.mode', e.target.value);
                onLayout?.({ ...(cfg.ui?.layout ?? {}), mode: e.target.value });
              }}
            >
              {['cards', 'list', 'compact', 'timeline', 'table'].map((m) => (
                <option key={m} value={m}>
                  {t(`layout_${m}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('columns')}</label>
            <select
              value={String(cfg.ui?.layout?.columns ?? 'auto')}
              onChange={(e) => {
                const v = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
                patch('ui.layout.columns', v);
                onLayout?.({ ...(cfg.ui?.layout ?? {}), columns: v });
              }}
            >
              <option value="auto">{t('columns_auto')}</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('density')}</label>
            <select
              value={cfg.ui?.layout?.density ?? 'comfortable'}
              onChange={(e) => {
                patch('ui.layout.density', e.target.value);
                onLayout?.({ ...(cfg.ui?.layout ?? {}), density: e.target.value });
              }}
            >
              <option value="comfortable">{t('density_comfortable')}</option>
              <option value="compact">{t('density_compact')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('fontScale')}</label>
            <input
              type="range"
              min="0.85"
              max="1.35"
              step="0.05"
              value={cfg.ui?.layout?.fontScale ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value);
                patch('ui.layout.fontScale', v);
                onLayout?.({ ...(cfg.ui?.layout ?? {}), fontScale: v });
              }}
            />
          </div>
          <div className="field" style={{ flex: '0 0 120px' }}>
            <label>{t('accent')}</label>
            <input
              value={cfg.ui?.layout?.accent ?? ''}
              placeholder="#5b8cff"
              onChange={(e) => {
                patch('ui.layout.accent', e.target.value);
                onLayout?.({ ...(cfg.ui?.layout ?? {}), accent: e.target.value });
              }}
            />
          </div>
        </div>
        <div className="row">
          {['showThumbs', 'showStats', 'showTime', 'showSource'].map((k) => (
            <div className="field" style={{ flex: '0 0 150px' }} key={k}>
              <label>{t(k)}</label>
              <select
                value={String(cfg.ui?.layout?.[k] !== false)}
                onChange={(e) => {
                  const v = e.target.value === 'true';
                  patch(`ui.layout.${k}`, v);
                  onLayout?.({ ...(cfg.ui?.layout ?? {}), [k]: v });
                }}
              >
                <option value="true">on</option>
                <option value="false">off</option>
              </select>
            </div>
          ))}
        </div>
      </section>

      {/* -- proxy nodes -- */}
      <section className="panel">
        <h2>{t('nodesTitle')}</h2>
        <div className="hint">{t('nodesHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={detectNodes} disabled={busy}>
              {t('detectControl')}
            </button>
          </div>
          <div className="field">
            <label>{t('testAgainst')}</label>
            <input value={nodeTestUrl} onChange={(e) => setNodeTestUrl(e.target.value)} />
          </div>
        </div>
        {(nodes?.groups ?? []).map((g) => {
          // Collapsed by default: entering the settings page used to spread the whole node list open, and
          // those dozens of rows pushed the page a long way down.
          // The summary keeps "current node + count + fastest delay", enough to decide whether any action
          // is needed without expanding it.
          const fastest = g.nodes.reduce((best, n) => {
            const d = n.lastDelay ?? Infinity;
            return d < (best?.d ?? Infinity) ? { name: n.name, d } : best;
          }, null);
          return (
            <Collapsible
              key={g.name}
              id={`nodes-${g.name}`}
              title={g.name}
              count={g.nodes.length}
              summary={`${t('currentNode')}: ${g.now ?? '-'}${fastest && Number.isFinite(fastest.d) ? ` · ${t('fastest')} ${fastest.name} ${fastest.d}ms` : ''}`}
              right={
                <button
                  className="ghost tiny"
                  onClick={(e) => {
                    e.stopPropagation();
                    testNodes(g);
                  }}
                  disabled={busy}
                >
                  {t('probe')}
                </button>
              }
            >
              <div className="nodes">
                <table>
                  <tbody>
                    {g.nodes.map((n) => {
                      const d = nodeDelays?.group === g.name ? (nodeDelays.results ?? []).find((r) => r.node === n.name) : null;
                      const best = nodeDelays?.group === g.name && (nodeDelays.results ?? [])[0]?.node === n.name;
                      return (
                        <tr key={n.name} className={best ? 'best' : ''}>
                          <td>
                            {n.name} {n.name === g.now ? <span className="badge none">now</span> : null}
                          </td>
                          <td className="muted small" style={{ width: 120 }}>
                            {d ? (d.ok ? `${d.delay} ms` : `✕ ${d.error ?? ''}`.slice(0, 40)) : n.lastDelay ? `${n.lastDelay} ms` : '—'}
                          </td>
                          <td style={{ width: 90 }}>
                            <button className="ghost tiny" onClick={() => switchNode(g.name, n.name)} disabled={busy || n.name === g.now}>
                              {t('switchTo')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Collapsible>
          );
        })}
        {nodes && !(nodes.groups ?? []).length && <p className="muted small">{t('controlNotFound')}</p>}
      </section>

      {/* -- config import / export -- */}
      <section className="panel io">
        <h2>{t('ioTitle')}</h2>
        <div className="hint">{t('ioHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 auto' }}>
            <a className="ghost" href={api.exportConfigUrl(false)}>
              {t('exportNoSecrets')}
            </a>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <a className="ghost danger" href={api.exportConfigUrl(true)}>
              {t('exportWithSecrets')}
            </a>
          </div>
          <div className="field">
            <label>{t('importConfig')}</label>
            <input type="file" accept="application/json,.json" onChange={(e) => importFile(e.target.files?.[0])} />
            <div className="hint" style={{ margin: 0 }}>{t('importHint')}</div>
          </div>
        </div>
      </section>

      {/* -- privacy / anonymous -- */}
      <section className="panel">
        <h2>{t('privacyTitle')}</h2>
        <div className="hint">{t('privacyHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('anonymousMode')}</label>
            <select value={String(cfg.privacy?.anonymousMode === true)} onChange={(e) => patch('privacy.anonymousMode', e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>Referer / Origin</label>
            <select value={String(cfg.privacy?.sendReferer !== false)} onChange={(e) => patch('privacy.sendReferer', e.target.value === 'true')}>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('probeTtl')}</label>
            <input type="number" value={cfg.ui?.probeTtlMinutes ?? 30} onChange={(e) => patch('ui.probeTtlMinutes', Number(e.target.value))} />
          </div>
        </div>
      </section>

      {/* -- daily intel output format / write location -- */}
      <section className="panel">
        <h2>{t('outputTitle')}</h2>
        <div className="hint">{t('outputHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('reportFormat')}</label>
            <select value={cfg.reports?.format ?? 'html'} onChange={(e) => patch('reports.format', e.target.value)}>
              <option value="html">html — {t('fmtHtml')}</option>
              <option value="adoc">adoc — AsciiDoc</option>
              <option value="md">md — Markdown</option>
              <option value="json">json — {t('fmtJson')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>{t('tempDir')}</label>
            <input
              value={cfg.paths?.tempDir ?? ''}
              placeholder={t('tempDirPh')}
              onChange={(e) => patch('paths.tempDir', e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>{t('browsersDir')}</label>
            <input
              value={cfg.paths?.browsersDir ?? ''}
              placeholder={t('browsersDirPh')}
              onChange={(e) => patch('paths.browsersDir', e.target.value)}
            />
          </div>
        </div>
        <div className="hint">{t('tempDirHint')}</div>
        <div className="hint">{t('browsersDirHint')}</div>
      </section>

      <SaveBar st={st} onSave={save} busy={busy} />
      {msg && <div className={'toast ' + msgKind}>{msg}</div>}
    </>
  );
}
