// Sources page: site list + live reachability data + per-site egress + thumbnails + self-check
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { cachedThumb, loadThumb } from '../thumb-cache.js';
import { Inline } from '../markdown.jsx';
import LoginCheckButton, { cookieProbeMessage } from '../LoginCheck.jsx';

const BLANK = { id: '', name: '', category: 'community', fetch: 'rss', url: '', uid: '', login: 'none', cadence: 'daily', proxy: '', region: '' };

/**
 * Which host a source's login state would come from — the same rule the server applies to its fallback
 * (server/src/sources.js, sourceLoginHost): the source's own `url`, and only for the bilibili sources the
 * parent domain `bilibili.com` (their urls live on `space.bilibili.com`, which is not where the login cookie
 * is stored).
 *
 * It is repeated on this side for one reason: this decides **whether the button can run at all**, and that
 * has to be known while rendering rather than after a request. When it says "no host" the button says so
 * instead of sending a probe that could only answer "nothing found" — which would read as "not logged in".
 */
export function sourceProbeHost(source = {}) {
  const raw = String(source.url ?? '').trim();
  if (raw) {
    try {
      const host = new URL(raw).host.toLowerCase();
      if (host) return host.replace(/^www\./, '');
    } catch {
      /* fall through to the bilibili rule below */
    }
  }
  const isBili = source.category === 'bili' || String(source.fetch ?? '').startsWith('bili-');
  return isBili ? 'bilibili.com' : null;
}

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
  const { t, tn, lang, fmtDateTime } = useI18n();
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
  // Per-row login-check results: s.id -> {ok, text}. Kept here (not in a child) so the row can show the
  // outcome next to the login badge it belongs to, in the same narrow cell.
  const [loginState, setLoginState] = useState({});
  // The domains the cookie probe would read. Only the host, never a path: the probe matches cookie rows by
  // `host_key LIKE %domain%`, so passing a URL would match nothing.
  const checkSourceLogin = async (s) => {
    const host = sourceProbeHost(s);
    if (!host) return null;
    const r = await api.checkCookies({ domains: [host] });
    return r;
  };
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

  // Thumbnails: asked once per source per session, through web/src/thumb-cache.js.
  //
  // This used to depend on the whole `data` object, so replacing it - which happens on every reload, and
  // twice when React double-invokes an effect - re-asked for all fourteen, and every visit to the page
  // started over. The request log caught the shape of it: bursts of 14 and of 28, with single fetches
  // taking up to two seconds. The dependency is now the list itself, so reloading the same list costs
  // nothing and toggling one source only re-asks for what changed.
  const thumbListKey = (data?.sources ?? []).map((s) => `${s.id}:${s.enabled ? 1 : 0}`).join(',');
  const thumbTargets = useMemo(
    () => (data?.sources ?? []).filter((s) => s.enabled && s.url).slice(0, 14),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [thumbListKey],
  );
  useEffect(() => {
    let stop = false;
    // Whatever is already known is shown at once, without waiting a microtask for it.
    for (const s of thumbTargets) {
      const known = cachedThumb(s);
      if (known !== undefined) setThumbs((prev) => ({ ...prev, [s.id]: known }));
    }
    (async () => {
      for (const s of thumbTargets) {
        if (stop) break;
        const image = await loadThumb(s, api.thumbMeta);
        if (!stop && image) setThumbs((prev) => ({ ...prev, [s.id]: image }));
      }
    })();
    return () => {
      stop = true;
    };
  }, [thumbTargets]);

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

  /**
   * Commit the region box, but only when it actually changed.
   *
   * Why not patch on every keystroke like the selects do: a select changes once per decision, while a text
   * box changes once per character, and every patch here writes the config file and reloads the whole list.
   * The box is therefore uncontrolled (defaultValue + a key tied to the stored value), which also means the
   * normalised value the server kept is what the box shows after the reload - typing `cn` must end up
   * reading `CN`, not disagreeing with the setting it just wrote.
   */
  const commitRegion = (id, typed, current) => {
    const code = String(typed ?? '').trim().toUpperCase();
    if (code !== String(current ?? '')) patch(id, { region: code });
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
              {health?.probed ?? 0}/{tn('items', health?.total ?? 0)}
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
                    <b>{p.label}</b> — {p.hint ?? (p.lastRunOk === false ? t('lastRunFailed') : t('verdict_unknown'))}
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
                <span className="muted small"> · {fmtDateTime(a.mtime)} · {(a.bytes / 1024).toFixed(1)} KB</span>{' '}
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
              {t('obsSampling')} · {Math.round((data.observation.ratio ?? 0.5) * 100)}% · {t('groupWindow')} {tn('groupDays', data.observation.rounds ?? 0)}
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
                            {/* Every source carries a login setting, so every row carries a way to check it.
                                The measurement is the read-only cookie probe for **this source's own host** —
                                counts and names only, never a value. A source that declares no login has no
                                login state to check, and a source with no usable address cannot be probed:
                                both say which of the two they are (in the button's title) instead of
                                pretending, and neither case hides the button. */}
                            <div className="muted" style={{ fontSize: 11, marginTop: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                              <LoginCheckButton
                                onCheck={() => checkSourceLogin(s)}
                                disabledReason={s.login === 'none' ? t('loginNotCheckable') : !sourceProbeHost(s) ? t('loginNoHost') : ''}
                                onResult={(r) => setLoginState((cur) => ({ ...cur, [s.id]: cookieProbeMessage(r, t, tn) }))}
                              />
                              {loginState[s.id] ? (
                                <span className={loginState[s.id].ok ? 'ok-text' : 'warn-text'} title={t('cookieDomain').replace('{domain}', sourceProbeHost(s) ?? '')}>
                                  {loginState[s.id].text}
                                </span>
                              ) : null}
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
                        {/* Which country this source wants to be seen from. Empty is a real answer - "no
                            preference" - which is also what every source behaved like before the setting
                            existed. It is placed above the verdict because the verdict takes it into
                            account, and it is only read in automatic mode, so a pinned egress says so. */}
                        <div className="small muted" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <label htmlFor={`region-${s.id}`}>{t('sourceRegion')}</label>
                          <input
                            id={`region-${s.id}`}
                            key={s.region ?? ''}
                            defaultValue={s.region ?? ''}
                            placeholder="—"
                            maxLength={2}
                            style={{ width: 48, textTransform: 'uppercase' }}
                            onBlur={(e) => commitRegion(s.id, e.target.value, s.region ?? '')}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                          />
                        </div>
                        {/* What automatic mode picked and why -- leaving it unwritten makes it a black box */}
                        {!s.proxy || s.proxy === 'auto' ? (
                          <div className="small muted" title={eg?.[s.id]?.reason ?? ''} style={{ maxWidth: 220, marginTop: 4 }}>
                            {eg?.[s.id]
                              ? `${eg[s.id].mode === 'direct' ? t('directEgress') : eg[s.id].mode === 'proxy' ? t('proxyEgress') : t('torEgress')} · ${eg[s.id].confidence === 'high' ? t('egressSettled') : t('egressTrial')}`
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
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('customNamePh')} />
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
          {/* The same setting as the one in the list, available at creation time, so a source that wants a
              particular country does not have to be created first and corrected afterwards. */}
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('sourceRegion')}</label>
            <input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
              placeholder="CN / JP"
              maxLength={2}
              style={{ textTransform: 'uppercase' }}
            />
          </div>
        </div>
        <button className="primary" onClick={addCustom} disabled={busy === 'add' || !form.id || (!form.url && !form.uid)}>
          {t('addCustomSource')}
        </button>
        <div className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          <Inline text={t('selfCheckHint')} />
        </div>
      </section>
    </>
  );
}
