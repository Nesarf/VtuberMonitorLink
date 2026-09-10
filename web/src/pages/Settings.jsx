// Settings.jsx — 设置页：浏览器 / LLM 多档位 / 代理 / 定时 / 界面
import { useEffect, useState } from 'react';
import { useI18n, WEEKDAYS, applyTheme } from '../i18n.jsx';
import { api } from '../api.js';

export default function Settings() {
  const { t, lang } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [browsers, setBrowsers] = useState([]);
  const [presets, setPresets] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [newPreset, setNewPreset] = useState('deepseek');
  const [domain, setDomain] = useState('bilibili.com');
  const [loginMsg, setLoginMsg] = useState('');
  const [loginOk, setLoginOk] = useState(false);

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setMsg(e.message));
    api.getBrowsers().then((b) => setBrowsers(b.detected ?? [])).catch(() => {});
    api
      .getLlm()
      .then((r) => setPresets(r.presets ?? []))
      .catch(() => {});
  }, []);

  if (!cfg) return <div className="panel">{t('loading')}</div>;

  const providers = cfg.llm?.providers ?? [];
  const activeId = cfg.llm?.activeId ?? providers[0]?.id ?? '';
  const active = providers.find((p) => p.id === activeId) ?? providers[0] ?? null;

  const patch = (path, value) => {
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
    setCfg((c) => {
      const next = structuredClone(c);
      const list = next.llm.providers ?? [];
      const i = list.findIndex((p) => p.id === (next.llm.activeId ?? list[0]?.id));
      if (i < 0) return next;
      list[i][field] = value;
      return next;
    });
  };

  const flash = (m, ms = 2500) => {
    setMsg(m);
    if (ms) setTimeout(() => setMsg(''), ms);
  };

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.putConfig(cfg);
      setCfg(next);
      applyTheme(next.ui?.theme);
      flash(t('saved'));
    } catch (e) {
      flash(e.message, 0);
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

  // 只读提取登录态：回报 cookie 数量与名字，不回传任何值
  const checkLogin = async () => {
    setBusy(true);
    setLoginMsg(t('checkingLogin'));
    try {
      const r = await api.checkCookies({ profileDir: cfg.browser.profileDir, domains: [domain.trim() || 'bilibili.com'] });
      setLoginOk(!!(r.ok && r.hasSession));
      if (r.ok && r.hasSession) setLoginMsg(`✅ ${t('loginOk')}: ${r.cookieCount} 个（含 SESSDATA）· ${r.profile ?? ''}`);
      else if (r.ok) setLoginMsg(`⚠️ ${t('loginNoSession')}: ${r.cookieCount} 个 · ${(r.names ?? []).slice(0, 8).join(', ')}`);
      else setLoginMsg(`❌ ${t('loginNone')}: ${r.error ?? ''}`);
      if (r.warning) setLoginMsg((m) => `${m} ｜ ${r.warning}`);
    } catch (e) {
      setLoginOk(false);
      setLoginMsg(`❌ ${e.message}`);
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
      {/* ── 浏览器 / Browser ── */}
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

        {/* ── 登录态探测：只读提取，浏览器开着也行 ── */}
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
            <div className="hint" style={{ margin: 0 }}>{t('loginHint')}</div>
            {loginMsg && <div className={loginOk ? 'hint ok-text' : 'hint warn-text'} style={{ margin: 0 }}>{loginMsg}</div>}
          </div>
        </div>
      </section>

      {/* ── LLM 多档位 ── */}
      <section className="panel">
        <h2>{t('llmTitle')}</h2>
        <div className="hint">{t('llmHint')}</div>

        {providers.length === 0 && <div className="hint">⚠ {t('llmNeedKey')}</div>}

        {providers.length > 0 && (
          <div className="row">
            <div className="field" style={{ flex: '0 0 240px' }}>
              <label>{t('llmActive')}</label>
              <select value={activeId} onChange={(e) => patch('llm.activeId', e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model || '?'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label>{t('llmAddProfile')}</label>
              <div className="row" style={{ gap: 6 }}>
                <select value={newPreset} onChange={(e) => setNewPreset(e.target.value)} style={{ flex: 1 }}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="ghost tiny" onClick={addProfile} disabled={busy}>
                  +
                </button>
              </div>
            </div>
          </div>
        )}

        {active && (
          <>
            <div className="row">
              <div className="field">
                <label>{t('baseUrl')}</label>
                <input value={active.baseUrl} onChange={(e) => patchProvider('baseUrl', e.target.value)} />
              </div>
              <div className="field">
                <label>{t('apiKey')}</label>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={active.apiKey ?? ''}
                    onChange={(e) => patchProvider('apiKey', e.target.value)}
                    placeholder="sk-..."
                    style={{ flex: 1 }}
                  />
                  <button className="ghost tiny" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? t('hideKey') : t('showKey')}
                  </button>
                </div>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>{t('model')}</label>
                <input
                  list="vml-models"
                  value={active.model ?? ''}
                  onChange={(e) => patchProvider('model', e.target.value)}
                />
                <datalist id="vml-models">
                  {[...new Set([...(active.models ?? []), ...(((presets.find((p) => p.id === active.preset) ?? {}).models) ?? [])])].map(
                    (m) => (
                      <option key={m} value={m} />
                    )
                  )}
                </datalist>
              </div>
              <div className="field" style={{ flex: '0 0 160px' }}>
                <label>{t('reasoningEffort')}</label>
                <select value={active.reasoningEffort ?? ''} onChange={(e) => patchProvider('reasoningEffort', e.target.value)}>
                  <option value="">-</option>
                  {['low', 'medium', 'high'].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: '0 0 150px' }}>
                <label>{t('maxTokens')}</label>
                <input
                  type="number"
                  value={active.maxTokens ?? 8192}
                  onChange={(e) => patchProvider('maxTokens', Number(e.target.value))}
                />
              </div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: '0 0 auto' }}>
                <button className="ghost" onClick={testLlm} disabled={busy}>
                  {t('testLlm')}
                </button>
              </div>
              <div className="field" style={{ flex: '0 0 auto' }}>
                <button className="ghost" onClick={fetchModels} disabled={busy}>
                  {t('llmFetchModels')}
                </button>
              </div>
              <div className="field" style={{ flex: '0 0 auto' }}>
                <button className="ghost danger" onClick={deleteProfile} disabled={busy || providers.length <= 1}>
                  {t('llmDeleteProfile')}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── 代理 / Proxy ── */}
      <section className="panel">
        <h2>{t('proxyTitle')}</h2>
        <div className="hint">{t('proxyHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('proxyEnabled')}</label>
            <select
              value={String(cfg.proxy?.enabled ?? false)}
              onChange={(e) => patch('proxy.enabled', e.target.value === 'true')}
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
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={detectProxy} disabled={busy}>
              {busy ? t('proxyDetecting') : t('proxyDetect')}
            </button>
          </div>
        </div>
      </section>

      {/* ── 定时 / Schedule ── */}
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
                {WEEKDAYS[lang].map((d, i) => (
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

      {/* ── 界面 / Appearance ── */}
      <section className="panel">
        <h2>{t('uiTitle')}</h2>
        <div className="hint">{t('uiHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('theme')}</label>
            <select
              value={cfg.ui?.theme ?? 'auto'}
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

      <button className="primary" onClick={save} disabled={busy}>
        {busy ? t('saving') : t('save')}
      </button>
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
