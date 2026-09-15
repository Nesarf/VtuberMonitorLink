// Browser.jsx — the one page that owns the browser/profile targeting
//
// Why this page exists, in the owner's words after it bit him: the share page's login check answered
// `profileDir is empty` and pointed at nothing he could act on. The setting lived in the Settings page's
// Browser section — behind a `mode !== 'bundled'` condition — while five different features read it.
//
// So the page has three jobs, and each one answers a different half of that complaint:
//   1. **configure it in one place**: which browser, which profile (user data dir), and the anonymous-mode
//      switch, which is the other thing that decides whether a login may be touched at all. There is one
//      config path behind all of it (`browser.profileDir`), resolved by one function on the server
//      (server/src/browser-target.js) — this page never decides what the setting means.
//   2. **discovery, not typing**: `server/src/cookies.js` already enumerates this machine's browser profiles,
//      so the page lists them with a "use this one" action. Nobody has to hand-write
//      `C:\Users\...\User Data`, and the documented default is shown next to the empty field.
//   3. **tell each dependent feature where it stands**: the per-feature table is the route's own inventory
//      (server/src/browser-consumers.js), so this table and the features it describes cannot drift. The
//      check button is `LoginCheck.jsx` — the same affordance every other login surface uses, not a second
//      one written here.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { SaveBar, useSaveState } from '../savebar.jsx';
import LoginCheckButton, { cookieProbeMessage } from '../LoginCheck.jsx';
import { Inline } from '../markdown.jsx';

/**
 * The structural marker this page is checked against (tools/integrity-check.mjs section 5g, and
 * tools/browser-config-test.mjs): the page that owns the browser profile setting is the one that asks the
 * server for the target and renders the per-feature table. It is a comment because the check is a text
 * check — the alternative was importing server/src/browser-target.js here for its `browserProfileKey()`, which
 * would drag the server's cookie/account modules into the web bundle to print one string.
 */

export default function Browser() {
  const { t, tn, lang } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [data, setData] = useState(null);
  const [presets, setPresets] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginState, setLoginState] = useState(null);
  const [domain, setDomain] = useState('bilibili.com');
  const st = useSaveState();

  const loadTarget = () => api.browserTarget().then(setData).catch(() => {});

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => setMsg(e.message));
    api.getBrowsers().then((b) => setPresets(b.detected ?? [])).catch(() => {});
    loadTarget();
  }, []);

  if (!cfg) return <div className="panel">{t('loading')}</div>;

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

  const save = async () => {
    setBusy(true);
    st.saving();
    try {
      const next = await api.putConfig(cfg);
      setCfg(next);
      st.saved();
      // The status table is computed on the server from the config that was just written, so it is re-read
      // rather than guessed from the form: "what the features see" is the whole point of the table.
      await loadTarget();
      setMsg(t('saved'));
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      st.failed(e.message);
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** "Use this one": one click writes the discovered path into the same setting by hand would (the pick is
   *  mapped by the server's pure function, so the row and the setting can never mean different things). */
  const useProfile = async (row) => {
    st.dirty();
    setCfg((c) => ({ ...c, browser: { ...(c.browser ?? {}), profileDir: row.path } }));
    setMsg(`${t('browserProfileSelected')}: ${row.path}`);
  };

  /** The login-state check for the configured profile: the same read-only cookie probe as everywhere else. */
  const checkLogin = async () => {
    const r = await api.checkCookies({ profileDir: cfg.browser?.profileDir ?? '', domains: [domain.trim() || 'bilibili.com'] });
    setLoginState({ ...r, message: cookieProbeMessage(r, t, tn) });
    return r;
  };

  const report = data?.report ?? null;
  const target = data?.target ?? null;
  const options = data?.profiles ?? [];
  const label = (v) => (v && typeof v === 'object' ? v[lang] ?? v.en ?? '' : String(v ?? ''));

  // The rows the per-feature table shows, from the route's own inventory. Each reason is a *state*, and the
  // one state the page exists to answer is "nothing is configured": it names the field further up this page,
  // because that is the dead end the page was built to close.
  const reasonText = (r) =>
    ({
      'temporary-profile': t('browserStatusTmp'),
      'profile-is-empty': t('browserStatusEmpty'),
      'profile-resolves': t('browserStatusOk'),
      'nothing-configured': t('browserProfileNone'),
      'anonymous-mode': t('browserStatusAnonymous'),
    })[r] ?? r;
  return (
    <>
      {/* -- the target: which browser, which profile, and the documented default -- */}
      <section className="panel">
        <h2>{t('browserTitle')}</h2>
        <div className="hint"><Inline text={t('browserHint')} /></div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('mode')}</label>
            <select value={cfg.browser?.mode ?? 'bundled'} onChange={(e) => patch('browser.mode', e.target.value)}>
              <option value="bundled">{t('mode_bundled')}</option>
              <option value="system">{t('mode_system')}</option>
              <option value="custom">{t('mode_custom')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('headless')}</label>
            <select value={String(cfg.browser?.headless !== false)} onChange={(e) => patch('browser.headless', e.target.value === 'true')}>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('waitMs')}</label>
            <input type="number" value={cfg.browser?.waitMs ?? 6000} onChange={(e) => patch('browser.waitMs', Number(e.target.value))} />
          </div>
        </div>

        {cfg.browser?.mode !== 'bundled' && (
          <div className="row">
            <div className="field" style={{ flex: '1 1 320px' }}>
              <label>{t('executablePath')}</label>
              {presets.length > 0 && (
                <select value="" onChange={(e) => e.target.value && patch('browser.executablePath', e.target.value)}>
                  <option value="">{t('detected')}…</option>
                  {presets.map((b) => (
                    <option key={b.executablePath} value={b.executablePath}>
                      {b.name} — {b.executablePath}
                    </option>
                  ))}
                </select>
              )}
              <input
                value={cfg.browser?.executablePath ?? ''}
                onChange={(e) => patch('browser.executablePath', e.target.value)}
                placeholder="C:\\path\\to\\browser.exe"
              />
            </div>
          </div>
        )}

        <div className="row">
          <div className="field" style={{ flex: '1 1 340px' }}>
            <label>{t('browserProfile')}</label>
            <input
              value={cfg.browser?.profileDir ?? ''}
              onChange={(e) => patch('browser.profileDir', e.target.value)}
              placeholder="C:\\Users\\you\\AppData\\...\\User Data"
            />
            <div className="hint" style={{ margin: 0 }}>{t('browserProfileHint')}</div>
            {/* What the setting resolves to *right now*, straight from the server's resolver. `source` is how
                the answer was reached, which is what makes "empty" a reason rather than a mystery. */}
            {target ? (
              <div className="muted small" style={{ marginTop: 4 }}>
                {target.dir ? (
                  <>
                    <span className="ok-text">{t('browserProfileSelected')}</span>
                    {': '}
                    {target.dir}
                  </>
                ) : (
                  <span className="warn-text">{t('browserProfileNone')}</span>
                )}
                {target.source === 'anonymous' ? <div className="muted small">{t('browserStatusAnonymous')}</div> : null}
                {cfg.browser?.profileDir ? (
                  <div className="muted small">{target.default === cfg.browser.profileDir ? t('browserProfileSelected') : t('browserProfileCustom')}</div>
                ) : null}
              </div>
            ) : null}
            {/* The documented default: shown, never used behind the user's back. Cookie stores are
                credentials, so which browser gets read is always a click and never a guess. */}
            {target?.default ? (
              <div className="muted small" style={{ marginTop: 4 }}>
                {t('browserProfileDefaultHint').replace('{browser}', target.default)} —{' '}
                <button className="ghost tiny" onClick={() => patch('browser.profileDir', target.default)}>
                  {t('browserProfileUse')}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* -- discovery: the profiles this machine actually has -- */}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={loadTarget}>
              {t('browserProfileScan')}
            </button>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="muted small">
              {options.length ? t('browserScanFound').replace('{n}', String(options.length)) : t('browserProfileNone')}
            </div>
          </div>
        </div>
        {options.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('browserTitle')}</th>
                <th>{t('browserProfile')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {options.map((p) => (
                <tr key={p.id}>
                  <td>{p.browser}</td>
                  <td className="muted small">{p.path}</td>
                  <td>
                    {p.selected ? (
                      <span className="ok-text small">{t('browserProfileSelected')}</span>
                    ) : (
                      <button className="ghost tiny" onClick={() => useProfile(p)}>
                        {t('browserProfileUse')}
                      </button>
                    )}
                    {p.current ? <span className="muted small"> {t('browserProfileCustom')}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {/* -- the read-only login probe: the same check every other login surface offers -- */}
        <div className="row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('domainLabel')}</label>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="bilibili.com" />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            {/* Always rendered. The only disable is a **stated** reason: with no profile dir named there is
                nothing to read, and the hint next to it says where to name one (this page, two rows up). */}
            <LoginCheckButton
              onCheck={checkLogin}
              disabledReason={target?.dir ? '' : t('browserProfileNone')}
              onResult={() => {}}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="hint" style={{ margin: 0 }}><Inline text={t('loginHint')} /></div>
            {loginState?.message ? <div className={loginState.message.ok ? 'ok-text small' : 'warn-text small'}>{loginState.message.text}</div> : null}
          </div>
        </div>

        {/* -- anonymous mode: the other thing that decides whether a login may be touched -- */}
        <div className="row">
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('anonymousMode')}</label>
            <select
              value={String(cfg.privacy?.anonymousMode === true)}
              onChange={(e) => patch('privacy.anonymousMode', e.target.value === 'true')}
            >
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="hint" style={{ margin: 0 }}>{t('privacyHint')}</div>
          </div>
        </div>

        <SaveBar st={st} onSave={save} busy={busy}>
          {msg ? <span className="muted small">{msg}</span> : null}
        </SaveBar>
      </section>

      {/* -- per-feature status: what each dependent feature needs, and whether it has it -- */}
      <section className="panel">
        <h2>{t('browserFeatureStatus')}</h2>
        {report ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('browserFeature')}</th>
                <th>{t('browserFeatureNeeds')}</th>
                <th>{t('browserFeatureStatus')}</th>
                <th>{t('checkLogin')}</th>
              </tr>
            </thead>
            <tbody>
              {report.consumers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div>{label(c.what)}</div>
                    <div className="muted small">{label(c.why)}</div>
                  </td>
                  <td className="muted small">
                    {c.key}
                    <div>{c.needsProfile ? t('browserNeedsProfile') : t('browserNeedsNoProfile')}</div>
                  </td>
                  <td className={c.ok ? 'ok-text' : 'warn-text'}>
                    {c.ok ? t('browserStatusOk') : t('browserStatusMissing')}
                    <div className="muted small">{reasonText(c.reason)}</div>
                  </td>
                  <td>
                    {/* The check uses the same button and the same route everywhere. A row that needs no
                        login (browser scraping) has nothing to check, so it says that instead of showing a
                        button whose press would measure the wrong thing. */}
                    {c.needsProfile ? (
                      <LoginCheckButton onCheck={checkLogin} disabledReason={target?.dir ? '' : t('browserProfileNone')} onResult={() => {}} />
                    ) : (
                      <span className="muted small">{t('browserNeedsNoProfile')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint">{t('loading')}</div>
        )}
        {/* One key, named once, because a person debugging "which setting did I just change" should be able
            to read it here rather than infer it from the behaviour of five features. The name is whatever the
            server resolved (the route reports it), so this page cannot go stale if the key ever moves — and
            while the answer is still on its way only the label is rendered, never a guessed key. */}
        {report ? (
          <div className="hint">
            {t('browserOneKey')}: <code>{report.key}</code>
          </div>
        ) : null}
      </section>
    </>
  );
}
