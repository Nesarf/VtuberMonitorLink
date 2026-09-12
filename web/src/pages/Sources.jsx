// Sources page: site list + live reachability data + per-site egress + thumbnails + self-check
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

const BLANK = { id: '', name: '', category: 'community', fetch: 'rss', url: '', uid: '', login: 'none', cadence: 'daily', proxy: '' };

/** Latency badge: value + failure rate, coloured by how good it is */
function Lat({ p, label, t }) {
  if (!p) return <span className="lat stale">{label} {t('neverProbed')}</span>;
  if (p.skipped) return <span className="lat stale">{label} —</span>;
  const loss = Math.round((p.loss ?? 0) * 100);
  const cls = !p.ok ? 'bad' : loss > 0 ? 'warn' : p.avg > 2500 ? 'warn' : 'ok';

  return (
    <span className={`lat ${cls}`} title={`${p.method ?? ''} ${p.host ?? p.url ?? ''}`}>
      {label} {p.ok ? `${p.avg}ms` : '✕'} · {loss}%
    </span>
  );
}

export default function Sources() {
  const { t, tn, lang } = useI18n();
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [advice, setAdvice] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ ...BLANK });
  const [customOnly, setCustomOnly] = useState(false);
  const [diag, setDiag] = useState(null);
  // Automatic egress verdicts: s.id -> {mode, reason, confidence}
  const [eg, setEg] = useState({});

  const load = async () => {
    try {
      const [s, h] = await Promise.all([api.getSources(), api.getHealth().catch(() => null)]);
      setData(s);      setHealth(h);
      setAdvice((await api.listAdvice().catch(() => ({ files: [] }))).files ?? []);
      // Automatic egress verdict (a failure here does not affect the rest of the page)
      const e = await api.getEgress().catch(() => null);
      setEg(e?.byKey ?? {});
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Thumbnails: the server answers instantly when it has a cache, so only the enabled sources are lazily loaded once here
  useEffect(() => {
    if (!data) return;
    let stop = false;
    const targets = data.sources.filter((s) => s.enabled && s.url).slice(0, 14);
    (async () => {
      for (const s of targets) {
        if (stop) break;
        try {
          const r = await api.thumbMeta(s.url, s.id);
          if (!stop && r.ok) setThumbs((prev) => ({ ...prev, [s.id]: r.image }));
        } catch {
          /* nothing there is fine */
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [data]);

  const healthById = useMemo(() => new Map((health?.sources ?? []).map((h) => [h.id, h])), [health]);

  const flash = (m, ms = 3000) => {
    setMsg(m);
    if (ms) setTimeout(() => setMsg(''), ms);
  };

  const patch = async (id, body) => {
    try {
      await api.patchSource(id, body);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  /** Bulk toggle: no ids means everything; with ids only those few are touched */
  const bulk = async (action, ids) => {
    setBusy('bulk');
    try {
      const r = await api.bulkSources({ action, ids });
      flash(`${action}: ${tn('items', r.changed)}`, 4000);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const probeOne = async (id) => {
    setBusy(`probe:${id}`);
    try {
      const r = await api.probe({ ids: [id] });
      const res = r.results?.[0];
      flash(res?.hint ? `${id}: ${res.hint}` : `${id}: ${t('done')}`, 6000);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const probeAll = async () => {
    setBusy('probe:all');
    flash(t('probing'), 0);
    try {
      const r = await api.probe({});
      flash(`${t('done')}: ${tn('items', r.probed)}`, 5000);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /** Self-check: when reachability is fine no file is produced; an anomaly generates a diagnostic file and links to it */
  const diagnose = async (id) => {
    setBusy(`diag:${id}`);
    flash(t('diagnosing'), 0);
    try {
      const r = await api.diagnose(id);
      setDiag({ id, ...r });
      flash(r.healthy ? `✅ ${id}: ${t('diagnoseHealthy')}` : `⚠️ ${id}: ${t('diagnoseBad')}`, 8000);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const addCustom = async () => {
    setBusy('add');
    setErr('');
    try {
      const added = await api.addCustomSource(form);
      const id = added.source?.id ?? form.id;
      setForm({ ...BLANK });
      flash(`${t('sourceAdded')}: ${id}`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const removeCustom = async (id) => {
    setBusy(`del:${id}`);
    try {
      await api.deleteCustomSource(id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  if (err && !data) return <div className="panel">❌ {err}</div>;
  if (!data) return <div className="panel">{t('loading')}</div>;

  const filtered = customOnly ? data.sources.filter((s) => s.custom) : data.sources;
  const byCat = {};
  for (const s of filtered) (byCat[s.category] ??= []).push(s);
  const needsUid = form.fetch === 'bili-opus' || form.fetch === 'bili-dynamic';
  const problems = health?.problems ?? [];
  const obs = data.observation ?? null; // observation mode: sampling ratio, rounds, last observation time per source

  return (
    <>
      {/* ── site health board ── */}
      <section className="panel">
        <h2>{t('health')}</h2>
        <div className="hint">{t('healthHint')}</div>
        <div className="board">
          <div className="summary">
            <span>
              {health?.probed ?? 0}/{health?.total ?? 0} {t('items')}
            </span>
            <button className="ghost tiny" onClick={probeAll} disabled={!!busy}>
              {busy === 'probe:all' ? t('probing') : t('probeAll')}
            </button>
            {msg && <span className="muted">{msg}</span>}
          </div>
          {problems.length === 0 ? (
            <div className="muted small">✅ {t('healthOk')}</div>
          ) : (
            <div className="problems">
              <b>
                ⚠ {t('healthProblems')}（{problems.length}）
              </b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {problems.map((p) => (
                  <li key={p.id}>
                    <b>{p.label}</b> — {p.hint ?? (p.lastRunOk === false ? '上次运行失败' : t('verdict_unknown'))}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* ── diagnostic files ── */}
      <section className="panel">
        <h2>{t('adviceFiles')}（{advice.length}）</h2>
        <div className="hint">{t('adviceHint')}</div>
        {advice.length === 0 ? (
          <p className="muted">{t('noAdvice')}</p>
        ) : (
          <ul className="advice-list">
            {advice.slice(0, 20).map((a) => (
              <li key={a.file}>
                <a href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.file}
                </a>
                <span className="muted small"> · {new Date(a.mtime).toLocaleString()} · {(a.bytes / 1024).toFixed(1)} KB</span>{' '}
                <button
                  className="ghost tiny danger"
                  onClick={async () => {
                    await api.deleteAdvice(a.file);
                    await load();
                  }}
                >
                  {t('deleteAdvice')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {diag && !diag.healthy && diag.advice && (
          <p className="warn-text">
            {t('diagnoseBad')}：{' '}
            <a href={diag.advice.url} target="_blank" rel="noreferrer noopener">
              {t('openAdvice')} {diag.advice.file}
            </a>
          </p>
        )}
      </section>

      {/* ── source list ── */}
      <section className="panel">
        <h2>{t('sourcesTitle')}</h2>
        <div className="hint">{t('sourcesHint')}</div>
        <p className="muted">
          {data.sources.length} sources · daily <b>{data.selected.daily}</b> · merch <b>{data.selected.merch}</b>
          {/* When observation mode is on, spell out the "rounds" and the sampling ratio as well -- otherwise the "last observed" column has no context */}
          {data.observation?.enabled ? (
            <span className="muted small" style={{ marginLeft: 12 }}>
              {t('obsSampling')} · {Math.round((data.observation.ratio ?? 0.5) * 100)}% · {t('groupWindow')} {data.observation.rounds ?? 0} {t('groupDays')}
            </span>
          ) : null}
          <label className="inline-check" style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} /> {t('onlyCustom')}
          </label>
        </p>
        {/* Bulk toggle: clicking 30 sources one by one is exhausting (this request was forced by "forgot to turn the default all-on back off" during a traversal) */}
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="muted small">{t('bulkToggle')}:</span>
          <button className="ghost tiny" onClick={() => bulk('enable')} disabled={!!busy}>
            {t('enableAll')}
          </button>
          <button className="ghost tiny" onClick={() => bulk('disable')} disabled={!!busy}>
            {t('disableAll')}
          </button>
          <button className="ghost tiny" onClick={() => bulk('disable', ['merch-fanbox', 'merch-cien', 'merch-booth', 'merch-dlsite'])} disabled={!!busy}>
            {t('onlyDaily')}
          </button>
          <button className="ghost tiny" onClick={() => bulk('reset')} disabled={!!busy}>
            {t('resetDefaults')}
          </button>
        </div>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}

        {Object.entries(byCat).map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 22 }}>
            <h3 style={{ fontSize: 13, color: 'var(--muted)', margin: '14px 0 6px' }}>
              {data.categories?.[cat]?.[lang] ?? cat}
            </h3>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>{t('enabledCol')}</th>
                  <th>{t('sourceName')}</th>
                  <th style={{ width: 130 }}>{t('egressSelect')}</th>
                  <th style={{ width: 210 }}>{t('health')}</th>
                  <th style={{ width: 130 }}>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const h = healthById.get(s.id);
                  return (
                    <tr key={s.id}>
                      <td>
                        <input type="checkbox" checked={s.enabled} onChange={(e) => patch(s.id, { enabled: e.target.checked })} />
                      </td>
                      <td>
                        <div className="srcname">
                          {thumbs[s.id] ? <img className="thumb" src={thumbs[s.id]} alt="" loading="lazy" /> : <span className="thumb" />}
                          <span>
                            <div>{s.name?.[lang] ?? s.id}</div>
                            <div className="muted" style={{ fontSize: 11 }}>
                              {s.id}
                              {s.custom ? <span className="badge custom"> {t('custom')}</span> : null}
                              {' · '}
                              <span className={`badge ${s.login}`}>
                                {s.login === 'required' ? t('login_required') : s.login === 'optional' ? t('login_optional') : t('login_none')}
                              </span>
                            </div>
                          </span>
                        </div>
                      </td>
                      <td>
                        <select value={s.proxy ?? ''} onChange={(e) => patch(s.id, { proxy: e.target.value })}>
                          <option value="">{t('proxyAuto')}</option>
                          <option value="direct">{t('proxyDirect')}</option>
                          <option value="proxy">{t('proxyUse')}</option>
                          <option value="tor">Tor</option>
                        </select>
                        {/* What automatic mode picked and why -- leaving it unwritten makes it a black box */}
                        {!s.proxy || s.proxy === 'auto' ? (
                          <div className="small muted" title={eg?.[s.id]?.reason ?? ''} style={{ maxWidth: 220, marginTop: 4 }}>
                            {eg?.[s.id]
                              ? `${eg[s.id].mode === 'direct' ? '直连' : eg[s.id].mode === 'proxy' ? '代理' : 'Tor'} · ${eg[s.id].confidence === 'high' ? '已判定' : '试用中'}`
                              : t('egressNotYet')}
                          </div>
                        ) : (
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {t('egressPinned')}
                          </div>
                        )}
                        {/* "Last observed" under observation mode: with only the sampling ratio, the user cannot see
                            "who has not been seen for how long" -- and that is exactly the basis for judging whether coverage is enough. */}
                        {obs?.enabled ? (
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {t('obsLastSeen')}: {s.lastObserved ? s.lastObserved.slice(0, 10) : t('groupNever')}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Lat p={h?.direct} label={t('directEgress')} t={t} />
                        <Lat p={h?.proxy} label={t('proxyEgress')} t={t} />
                        {h?.hint ? (
                          <div className={`small ${h.verdict === 'none' ? 'delta-down' : 'muted'}`}>
                            {h.verdict === 'none' ? '❌ ' : h.verdict === 'proxy' ? '→ ' : '✓ '}
                            {h.hint}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <button className="ghost tiny" onClick={() => probeOne(s.id)} disabled={!!busy || !s.url}>
                          {busy === `probe:${s.id}` ? t('probingOne') : t('probe')}
                        </button>{' '}
                        <button className="ghost tiny" onClick={() => diagnose(s.id)} disabled={!!busy}>
                          {busy === `diag:${s.id}` ? t('diagnosing') : t('diagnose')}
                        </button>
                        {s.custom ? (
                          <>
                            {' '}
                            <button className="ghost tiny danger" onClick={() => removeCustom(s.id)} disabled={!!busy}>
                              {t('deleteSource')}
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {/* ── custom sources ── */}
      <section className="panel">
        <h2>{t('customSources')}</h2>
        <div className="hint">{t('customSourcesHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 190px' }}>
            <label>{t('sourceId')}</label>
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="my-feed" />
          </div>
          <div className="field">
            <label>{t('sourceName')}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="某某的博客" />
          </div>
          <div className="field" style={{ flex: '0 0 220px' }}>
            <label>{t('fetchKind')}</label>
            <select value={form.fetch} onChange={(e) => setForm({ ...form, fetch: e.target.value })}>
              {(data.fetchKinds ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k[lang] ?? k.zh}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>{t('sourceUrl')}</label>
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/feed.xml" />
          </div>
          {needsUid && (
            <div className="field" style={{ flex: '0 0 200px' }}>
              <label>{t('sourceUid')}</label>
              <input value={form.uid} onChange={(e) => setForm({ ...form, uid: e.target.value })} placeholder="672328094" />
            </div>
          )}
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('category')}</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {Object.entries(data.categories ?? {}).map(([id, label]) => (
                <option key={id} value={id}>
                  {label[lang] ?? label.zh}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('login')}</label>
            <select value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })}>
              <option value="none">{t('login_none')}</option>
              <option value="optional">{t('login_optional')}</option>
              <option value="required">{t('login_required')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('sourceCadence')}</label>
            <select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>
              <option value="daily">{t('cadence_daily')}</option>
              <option value="merch">{t('cadence_merch')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('egressSelect')}</label>
            <select value={form.proxy} onChange={(e) => setForm({ ...form, proxy: e.target.value })}>
              <option value="">{t('proxyAuto')}</option>
              <option value="direct">{t('proxyDirect')}</option>
              <option value="proxy">{t('proxyUse')}</option>
              <option value="tor">Tor</option>
            </select>
          </div>
        </div>
        <button className="primary" onClick={addCustom} disabled={busy === 'add' || !form.id || (!form.url && !form.uid)}>
          {t('addCustomSource')}
        </button>
        <div className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          自检在**每次运行的最后**执行：先抓完、先出报告，最后只对出异常的来源做诊断（能连通就完全不打扰）。也可以随时在上面的行里手动点「自检」。
        </div>
      </section>
    </>
  );
}
