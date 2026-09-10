// Todo — 设置页：浏览器 / LLM / 定时 / Settings: browser, LLM, schedule
import { useEffect, useState } from 'react';
import { useI18n, WEEKDAYS } from '../i18n.jsx';
import { api } from '../api.js';

export default function Settings() {
  const { t, lang } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [browsers, setBrowsers] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setMsg(e.message));
    api.getBrowsers().then((b) => setBrowsers(b.detected ?? [])).catch(() => {});
  }, []);

  if (!cfg) return <div className="panel">{t('loading')}</div>;

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

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.putConfig(cfg);
      setCfg(next);
      setMsg(t('saved'));
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const testLlm = async () => {
    setBusy(true);
    setMsg(t('testing'));
    try {
      await api.putConfig(cfg);
      const r = await api.preflight();
      setMsg(r.ok ? `✅ ${t('testLlm')}: OK` : `❌ ${r.error}`);
    } catch (e) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  // 探测本机常见代理端口，命中即填入 / detect a usable local proxy port and fill it in
  const detectProxy = async () => {
    setBusy(true);
    setMsg(t('proxyDetecting'));
    try {
      const r = await api.detectProxy();
      if (r.found?.length) {
        const picked = r.found[0];
        setCfg((c) => ({ ...c, proxy: { ...(c.proxy ?? {}), enabled: true, url: picked } }));
        setMsg(`✅ ${t('proxyFound')}: ${r.found.join(', ')}`);
      } else {
        setMsg(`⚠️ ${t('proxyNone')}`);
      }
    } catch (e) {
      setMsg(`❌ ${e.message}`);
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
                <select
                  value=""
                  onChange={(e) => e.target.value && patch('browser.executablePath', e.target.value)}
                >
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
      </section>

      {/* ── LLM ── */}
      <section className="panel">
        <h2>{t('llmTitle')}</h2>
        <div className="hint">{t('llmHint')}</div>
        <div className="row">
          <div className="field">
            <label>{t('baseUrl')}</label>
            <input value={cfg.llm.baseUrl} onChange={(e) => patch('llm.baseUrl', e.target.value)} />
          </div>
          <div className="field">
            <label>{t('apiKey')}</label>
            <input
              type="password"
              value={cfg.llm.apiKey}
              onChange={(e) => patch('llm.apiKey', e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>{t('model')}</label>
            <input value={cfg.llm.model} onChange={(e) => patch('llm.model', e.target.value)} />
          </div>
          <div className="field">
            <label>{t('reasoningEffort')}</label>
            <select
              value={cfg.llm.reasoningEffort}
              onChange={(e) => patch('llm.reasoningEffort', e.target.value)}
            >
              {['low', 'medium', 'high'].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t('maxTokens')}</label>
            <input
              type="number"
              value={cfg.llm.maxTokens}
              onChange={(e) => patch('llm.maxTokens', Number(e.target.value))}
            />
          </div>
        </div>
        <button className="ghost" onClick={testLlm} disabled={busy}>
          {t('testLlm')}
        </button>
      </section>

      {/* ── 定时 / Schedule ── */}
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
        {msg && <div className="hint" style={{ margin: 0 }}>{msg}</div>}
      </section>

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
        </div>
      </section>

      <button className="primary" onClick={save} disabled={busy}>
        {busy ? t('saving') : t('save')}
      </button>
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
