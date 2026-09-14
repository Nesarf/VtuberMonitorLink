// Watch.jsx — watch targets
// Borrows the watch techniques from Moegirlpedia: page revisions, recent changes, watchlist, diff of any web page, Bilibili feed.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

const EMPTY = {
  url: { url: '', mode: 'text', ignorePatterns: '' },
  'mediawiki-page': { apiUrl: 'https://zh.moegirl.org.cn/api.php', page: '' },
  'mediawiki-recentchanges': { apiUrl: 'https://zh.moegirl.org.cn/api.php', namespaces: '0,14', limit: 50 },
  'mediawiki-watchlist': { apiUrl: 'https://zh.moegirl.org.cn/api.php', username: '', botPassword: '', limit: 50 },
  'bili-opus': { uid: '' },
};

function hsDateOf(iso, format) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format(d);
}

export default function Watch() {
  const { t, tn, lang, fmtDateTime } = useI18n();
  // The application's locale decides this, not the browser: a bare `toLocaleString()` follows the
  // browser's language, which is how a Thai UI rendered English dates and vice versa (docs/BUGS.md #79).
  const hsDate = (iso) => hsDateOf(iso, fmtDateTime);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('url');
  const [form, setForm] = useState({ ...EMPTY.url });
  const [label, setLabel] = useState('');
  const [proxy, setProxy] = useState('');
  const [history, setHistory] = useState(null); // {id, entries}
  const [showRules, setShowRules] = useState(false);

  const load = async () => {
    try {
      setData(await api.getWatch());
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const switchKind = (k) => {
    setKind(k);
    setForm({ ...(EMPTY[k] ?? {}) });
  };

  const addTarget = async () => {
    const base = { kind, label: label || undefined, enabled: true, ...(proxy ? { proxy } : {}) };
    if (kind === 'url') {
      if (!form.url) return setErr(t('needUrl'));
      base.url = form.url.trim();
      base.mode = form.mode;
      base.ignorePatterns = String(form.ignorePatterns || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (kind === 'mediawiki-page') {
      if (!form.apiUrl || !form.page) return setErr(t('needApiPage'));
      base.apiUrl = form.apiUrl.trim();
      base.page = form.page.trim();
    } else if (kind === 'mediawiki-recentchanges') {
      if (!form.apiUrl) return setErr(t('needApi'));
      base.apiUrl = form.apiUrl.trim();
      base.namespaces = String(form.namespaces || '0')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      base.limit = Number(form.limit) || 50;
    } else if (kind === 'mediawiki-watchlist') {
      if (!form.apiUrl || !form.username || !form.botPassword) return setErr(t('needBotPassword'));
      base.apiUrl = form.apiUrl.trim();
      base.username = form.username.trim();
      base.botPassword = form.botPassword;
      base.limit = Number(form.limit) || 50;
    } else if (kind === 'bili-opus') {
      if (!/^\d+$/.test(String(form.uid || '').trim())) return setErr(t('needUid'));
      base.uid = String(form.uid).trim();
      base.proxy = 'direct';
    }
    base.id = `${kind}-${(base.url || base.page || base.uid || Date.now()).toString().replace(/[^A-Za-z0-9]/g, '-').slice(-40)}`;

    setBusy(true);
    try {
      const cur = data?.targets ?? [];
      if (cur.some((x) => x.id === base.id)) return setErr(t('duplicateTarget'));
      await api.putWatch({ targets: [...cur, base] });
      setLabel('');
      setForm({ ...(EMPTY[kind] ?? {}) });
      setMsg(t('saved'));
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeTarget = async (id) => {
    setBusy(true);
    try {
      await api.putWatch({ targets: (data?.targets ?? []).filter((x) => x.id !== id) });
      await api.clearBaseline(id).catch(() => {});
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleTarget = async (id, enabled) => {
    setBusy(true);
    try {
      await api.putWatch({ targets: (data?.targets ?? []).map((x) => (x.id === id ? { ...x, enabled } : x)) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const checkOne = async (id) => {
    setBusy(true);
    setMsg(t('checking'));
    try {
      const r = await api.checkWatch(id);
      const res = r.results?.[0];
      setMsg(res ? (res.ok ? res.summary : `❌ ${res.error}`) : t('done'));
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const checkAll = async () => {
    setBusy(true);
    setMsg(t('checking'));
    try {
      const r = await api.checkWatch();
      const bad = (r.results ?? []).filter((x) => !x.ok).length;
      setMsg(`${tn('items', (r.results ?? []).length)}${bad ? ` · ${bad} ${t('failed')}` : ''}`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (id) => {
    try {
      const r = await api.watchHistory(id, 50);
      setHistory({ id, entries: r.history ?? [] });
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveRules = async (patch) => {
    setBusy(true);
    try {
      await api.putWatch({ rules: { ...data.rules, ...patch } });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="panel">{t('loading')}</div>;

  const rules = data.rules ?? {};

  return (
    <>
      <section className="panel">
        <h2>{t('watchTitle')}</h2>
        <div className="hint">{t('watchHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('watchEnabled')}</label>
            <select
              value={String(data.enabled)}
              onChange={async (e) => {
                await api.putWatch({ enabled: e.target.value === 'true' });
                load();
              }}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={checkAll} disabled={busy}>
              {t('checkAll')}
            </button>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={() => setShowRules((v) => !v)}>
              {showRules ? t('hideRules') : t('showRules')}
            </button>
          </div>
        </div>
        {msg && <div className="hint" style={{ margin: 0 }}>{msg}</div>}
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}

        {showRules && (
          <div className="rules">
            <div className="row">
              <div className="field" style={{ flex: '0 0 160px' }}>
                <label>{t('rulesLargeEdit')}</label>
                <input type="number" defaultValue={rules.largeEditBytes} onBlur={(e) => saveRules({ largeEditBytes: Number(e.target.value) })} />
              </div>
              <div className="field" style={{ flex: '0 0 160px' }}>
                <label>{t('rulesLargeDelete')}</label>
                <input type="number" defaultValue={rules.largeDeleteBytes} onBlur={(e) => saveRules({ largeDeleteBytes: Number(e.target.value) })} />
              </div>
              {['newPage', 'anonymousEdit', 'unpatrolled'].map((k) => (
                <div className="field" style={{ flex: '0 0 160px' }} key={k}>
                  <label>{t(`rules_${k}`)}</label>
                  <select value={String(rules[k])} onChange={(e) => saveRules({ [k]: e.target.value === 'true' })}>
                    <option value="true">on</option>
                    <option value="false">off</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="field">
              <label>{t('rulesKeywords')}</label>
              <textarea
                rows={3}
                defaultValue={(rules.keywords ?? []).join('、')}
                onBlur={(e) =>
                  saveRules({
                    keywords: e.target.value
                      .split(/[、,，\n]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
            <div className="field">
              <label>{t('rulesLogTypes')}</label>
              <input
                defaultValue={(rules.logTypes ?? []).join(', ')}
                onBlur={(e) =>
                  saveRules({
                    logTypes: e.target.value
                      .split(/[,\s]+/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>{t('watchAdd')}</h2>
        <div className="row">
          <div className="field" style={{ flex: '0 0 230px' }}>
            <label>{t('watchKind')}</label>
            <select value={kind} onChange={(e) => switchKind(e.target.value)}>
              {data.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k[lang] ?? k.zh}
                  {k.login === 'required' ? t('loginRequiredTag') : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t('label')}</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('labelPlaceholder')} />
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('proxyMode')}</label>
            <select value={proxy} onChange={(e) => setProxy(e.target.value)}>
              <option value="">{t('proxyAuto')}</option>
              <option value="direct">{t('proxyDirect')}</option>
              <option value="proxy">{t('proxyUse')}</option>
              <option value="tor">Tor</option>
            </select>
          </div>
        </div>

        {kind === 'url' && (
          <div className="row">
            <div className="field">
              <label>URL</label>
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/page" />
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label>{t('watchMode')}</label>
              <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="text">text</option>
                <option value="html">html</option>
              </select>
            </div>
            <div className="field">
              <label>{t('ignorePatterns')}</label>
              <input value={form.ignorePatterns} onChange={(e) => setForm({ ...form, ignorePatterns: e.target.value })} placeholder={t('ignorePatternsPh')} />
            </div>
          </div>
        )}

        {kind === 'mediawiki-page' && (
          <div className="row">
            <div className="field">
              <label>api.php</label>
              <input value={form.apiUrl} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('pageTitle')}</label>
              <input value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })} placeholder={t('watchPagePh')} />
            </div>
          </div>
        )}

        {kind === 'mediawiki-recentchanges' && (
          <div className="row">
            <div className="field">
              <label>api.php</label>
              <input value={form.apiUrl} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label>{t('namespaces')}</label>
              <input value={form.namespaces} onChange={(e) => setForm({ ...form, namespaces: e.target.value })} placeholder="0,14" />
            </div>
            <div className="field" style={{ flex: '0 0 120px' }}>
              <label>limit</label>
              <input type="number" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} />
            </div>
          </div>
        )}

        {kind === 'mediawiki-watchlist' && (
          <>
            <div className="row">
              <div className="field">
                <label>api.php</label>
                <input value={form.apiUrl} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} />
              </div>
              <div className="field">
                <label>{t('botUser')}</label>
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="BotName@TaskName" />
              </div>
              <div className="field">
                <label>{t('botPassword')}</label>
                <input type="password" value={form.botPassword} onChange={(e) => setForm({ ...form, botPassword: e.target.value })} />
              </div>
            </div>
            <div className="hint" style={{ margin: 0 }}>{t('botPasswordHint')}</div>
          </>
        )}

        {kind === 'bili-opus' && (
          <div className="row">
            <div className="field" style={{ flex: '0 0 220px' }}>
              <label>UID</label>
              <input value={form.uid} onChange={(e) => setForm({ ...form, uid: e.target.value })} placeholder="672328094" />
            </div>
            <div className="hint" style={{ margin: 0, flex: 1 }}>
              {t('biliUidHint')}
            </div>
          </div>
        )}

        <button className="primary" onClick={addTarget} disabled={busy}>
          {t('add')}
        </button>
      </section>

      <section className="panel">
        <h2>{t('watchList')}（{data.targets.length}）</h2>
        {data.targets.length === 0 ? (
          <p className="muted">{t('noTargets')}</p>
        ) : (
          <table className="reportlist">
            <thead>
              <tr>
                <th>{t('label')}</th>
                <th style={{ width: 150 }}>{t('watchKind')}</th>
                <th style={{ width: 220 }}>{t('baseline')}</th>
                <th style={{ width: 150 }}>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.targets.map((tg) => (
                <tr key={tg.id} className={tg.enabled === false ? 'row-off' : ''}>
                  <td>
                    <b>{tg.label}</b>
                    <div className="muted small">
                      {tg.url || tg.page || (tg.uid ? `uid ${tg.uid}` : tg.apiUrl)}
                      {tg.proxy ? ` · ${tg.proxy}` : ''}
                    </div>
                  </td>
                  <td className="muted">{data.kinds.find((k) => k.id === tg.kind)?.[lang] ?? tg.kind}</td>
                  <td className="muted small">
                    {tg.baseline ? (
                      <>
                        {tg.baseline.kind}
                        {tg.baseline.revid ? ` · revid ${tg.baseline.revid}` : ''}
                        {typeof tg.baseline.follower === 'number' ? ` · ${tn('followersCount', tg.baseline.follower)}` : ''}
                        {typeof tg.baseline.ids === 'number' ? ` · ${tn('items', tg.baseline.ids)}` : ''}
                        <br />
                        {hsDate(tg.baseline.at)}
                      </>
                    ) : (
                      t('noBaseline')
                    )}
                  </td>
                  <td>
                    <button className="ghost tiny" onClick={() => checkOne(tg.id)} disabled={busy}>
                      {t('check')}
                    </button>{' '}
                    <button className="ghost tiny" onClick={() => openHistory(tg.id)}>
                      {t('history')}
                    </button>{' '}
                    <button className="ghost tiny" onClick={() => toggleTarget(tg.id, tg.enabled === false)} disabled={busy}>
                      {tg.enabled === false ? t('enable') : t('disable')}
                    </button>{' '}
                    <button className="ghost tiny danger" onClick={() => removeTarget(tg.id)} disabled={busy}>
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {history && (
        <section className="panel">
          <h2>
            {t('history')} · {history.id}
            <button className="ghost tiny" style={{ marginLeft: 12 }} onClick={() => setHistory(null)}>
              {t('close')}
            </button>
          </h2>
          {history.entries.length === 0 ? (
            <p className="muted">{t('noHistory')}</p>
          ) : (
            <div className="history">
              {history.entries.map((h, i) => (
                <details key={i} open={i === 0}>
                  <summary>
                    <span className="muted small">{hsDate(h.at)}</span> · {h.summary}
                    {h.growth ? <span className={h.growth.delta >= 0 ? 'delta-up' : 'delta-down'}> {tn('followersCount', (h.growth.delta >= 0 ? '+' : '') + h.growth.delta)}</span> : null}
                  </summary>
                  {(h.events ?? []).map((e, j) => (
                    <div className="event" key={j}>
                      <div>
                        <b>{e.title || e.kind}</b>
                        {e.reasons?.length ? <span className="chip alert">⚠ {e.reasons.join('、')}</span> : null}
                        {typeof e.delta === 'number' && e.delta !== 0 ? <span className="muted small"> Δ {e.delta > 0 ? '+' : ''}{e.delta}</span> : null}
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noreferrer noopener" className="small" style={{ marginLeft: 8 }}>
                            {t('viewSource')}
                          </a>
                        ) : null}
                      </div>
                      {e.text ? <p className="muted small">{String(e.text).slice(0, 300)}</p> : null}
                      {e.hunks?.length ? (
                        <pre className="diff">
                          {e.hunks.slice(0, 120).map((l, k) => (
                            <div key={k} className={`diff-line op-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '@' ? 'ctx' : 'same'}`}>
                              {l.op} {l.text}
                            </div>
                          ))}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
