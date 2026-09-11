// Intel.jsx — 情报卡片流 / intel stream
// 排版可 DIY（卡片墙 / 列表 / 紧凑 / 时间线 / 表格），支持星标与已读、本次 vs 上次对比。
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { layoutClass, normalizeLayout } from '../layout.js';

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString();
}

export default function Intel({ layout }) {
  const { t, lang } = useI18n();
  const L = normalizeLayout(layout);
  const [data, setData] = useState(null);
  const [diffData, setDiffData] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setData(
        await api.getIntel({
          q,
          source,
          alerts: alertsOnly ? 1 : undefined,
          starred: starredOnly ? 1 : undefined,
          unread: unreadOnly ? 1 : undefined,
        })
      );
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceOptions = useMemo(() => {
    const map = new Map();
    for (const it of data?.items ?? []) map.set(it.sourceId, it.sourceName?.[lang] ?? it.sourceId);
    return [...map.entries()];
  }, [data, lang]);

  const flag = async (item, patch) => {
    try {
      await api.flagIntel(item.id, patch);
      setData((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, flag: { ...(i.flag ?? {}), ...patch } } : i)) }));
    } catch (e) {
      setErr(e.message);
    }
  };

  const toggleDiff = async () => {
    if (showDiff) return setShowDiff(false);
    try {
      setDiffData(await api.getIntelDiff());
      setShowDiff(true);
    } catch (e) {
      setErr(e.message);
    }
  };

  const watchBlock = (data?.watch ?? []).filter((w) => w.ok && (w.changed || w.growth));

  const renderCard = (it) => (
    <article className={`card${it.flag?.starred ? ' starred' : ''}${it.flag?.read ? '' : ' unread'}`} key={it.id}>
      <header>
        {L.showSource && <span className="chip">{it.sourceName?.[lang] ?? it.sourceId}</span>}
        {L.showTime && it.time ? <span className="muted small">{fmtTime(it.time)}</span> : null}
        {it.keywords?.length ? <span className="chip alert">⚠ {it.keywords.join('/')}</span> : null}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="flagbar">
          <button
            className={it.flag?.starred ? 'on' : ''}
            title={t('starred')}
            onClick={() => flag(it, { starred: !it.flag?.starred })}
          >
            {it.flag?.starred ? '★' : '☆'}
          </button>
          <button
            title={it.flag?.read ? t('markUnread') : t('markRead')}
            onClick={() => flag(it, { read: !it.flag?.read })}
          >
            {it.flag?.read ? '✓' : '·'}
          </button>
        </span>
      </header>
      {it.title ? <h3>{it.title}</h3> : null}
      {it.text ? (
        <p>
          {it.text.split(/(\[[^\]]{1,24}\])/).map((seg, i) =>
            /^\[[^\]]{1,24}\]$/.test(seg) ? (
              <span className="emote" key={i} title={seg}>
                {seg}
              </span>
            ) : (
              <span key={i}>{seg}</span>
            )
          )}
        </p>
      ) : null}
      {L.showThumbs && it.images?.length ? (
        <div className="thumbs">
          {it.images.slice(0, 6).map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noreferrer noopener">
              <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      <footer>
        {L.showStats && it.stats?.like ? <span className="muted small">👍 {it.stats.like}</span> : null}
        {L.showStats && it.stats?.comment ? <span className="muted small">💬 {it.stats.comment}</span> : null}
        {L.showStats && it.stats?.user ? <span className="muted small">✎ {it.stats.user}</span> : null}
        {L.showStats && typeof it.stats?.delta === 'number' && it.stats.delta !== 0 ? (
          <span className="muted small">
            Δ {it.stats.delta > 0 ? '+' : ''}
            {it.stats.delta}
          </span>
        ) : null}
        {it.url ? (
          <a href={it.url} target="_blank" rel="noreferrer noopener">
            {t('openSource')} ↗
          </a>
        ) : null}
      </footer>
    </article>
  );

  return (
    <>
      <section className="panel">
        <h2>{t('intelTitle')}</h2>
        <div className="hint">{t('intelHint')}</div>

        <div className="row">
          <div className="field">
            <label>{t('search')}</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder={t('intelSearchPlaceholder')}
            />
          </div>
          <div className="field">
            <label>{t('sources')}</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t('all')}</option>
              {sourceOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('onlyAlerts')}</label>
            <select value={String(alertsOnly)} onChange={(e) => setAlertsOnly(e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('onlyStarred')}</label>
            <select value={String(starredOnly)} onChange={(e) => setStarredOnly(e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('onlyUnread')}</label>
            <select value={String(unreadOnly)} onChange={(e) => setUnreadOnly(e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={load} disabled={busy}>
              {busy ? t('loading') : t('refresh')}
            </button>{' '}
            <button className="ghost" onClick={toggleDiff}>
              {showDiff ? t('close') : t('compare')}
            </button>{' '}
            <a className="ghost" href={api.intelExportUrl('xlsx')}>
              {t('exportXlsx')}
            </a>{' '}
            <a className="ghost" href={api.intelExportUrl('docx')}>
              {t('exportDocx')}
            </a>{' '}
            <button
              className="ghost"
              title={t('featuresHint')}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.extractFeatures();
                  setErr(r.ok ? '' : `特征抽取：${r.error}`);
                  if (r.ok) await load();
                } catch (e) {
                  setErr(e.message);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              {t('extractFeatures')}
            </button>
          </div>
        </div>
        <div className="hint" style={{ margin: 0 }}>
          {data?.generatedAt
            ? `${t('generatedAt')}: ${fmtTime(data.generatedAt)} · ${data.count}/${data.total} ${t('items')}${data.starred ? ` · ★ ${data.starred}` : ''}`
            : t('noIntel')}
        </div>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
      </section>

      {showDiff && (
        <section className="panel">
          <h2>{t('compare')}</h2>
          {!diffData?.hasPrevious ? (
            <p className="muted">{t('noPreviousRun')}</p>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                <span className="chip">{t('comparedAdded')} {diffData.added.length}</span>
                <span className="chip">{t('comparedChanged')} {diffData.changed.length}</span>
                <span className="chip">{t('comparedRemoved')} {diffData.removed.length}</span>
                <span className="muted small">
                  {fmtTime(diffData.previous.at)} → {fmtTime(diffData.current.at)}
                </span>
              </div>
              {diffData.added.length > 0 && (
                <>
                  <h3 style={{ fontSize: 13 }}>{t('comparedAdded')}</h3>
                  <ul className="muted small">
                    {diffData.added.slice(0, 20).map((i) => (
                      <li key={i.id}>
                        [{i.sourceId}] {String(i.text || i.title).replace(/\s+/g, ' ').slice(0, 110)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {diffData.changed.length > 0 && (
                <>
                  <h3 style={{ fontSize: 13 }}>{t('comparedChanged')}</h3>
                  <ul className="muted small">
                    {diffData.changed.slice(0, 20).map((c) => (
                      <li key={c.id}>
                        [{c.after.sourceId}] {String(c.before.text).slice(0, 50)} → {String(c.after.text).slice(0, 60)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {diffData.removed.length > 0 && (
                <>
                  <h3 style={{ fontSize: 13 }}>{t('comparedRemoved')}</h3>
                  <ul className="muted small">
                    {diffData.removed.slice(0, 20).map((i) => (
                      <li key={i.id}>
                        [{i.sourceId}] {String(i.text || i.title).replace(/\s+/g, ' ').slice(0, 110)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}

      {watchBlock.length > 0 && (
        <section className="panel">
          <h2>{t('watchDigest')}</h2>
          <ul className="watch-digest">
            {watchBlock.map((w) => (
              <li key={w.id}>
                <b>{w.label}</b>
                <span className="muted"> · {w.summary}</span>
                {w.growth && (
                  <span className={w.growth.delta >= 0 ? 'delta-up' : 'delta-down'}>
                    {' '}
                    粉丝 {w.growth.delta >= 0 ? '+' : ''}
                    {w.growth.delta}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {L.mode === 'table' ? (
        <section className="panel">
          <table className="reportlist">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>{t('sources')}</th>
                <th>{t('intelTitle')}</th>
                <th style={{ width: 120 }}>{t('latency')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((it) => (
                <tr key={it.id}>
                  <td>
                    <button
                      className={it.flag?.starred ? 'link on' : 'link'}
                      onClick={() => flag(it, { starred: !it.flag?.starred })}
                    >
                      {it.flag?.starred ? '★' : '☆'}
                    </button>
                  </td>
                  <td className="muted small">{it.sourceName?.[lang] ?? it.sourceId}</td>
                  <td>
                    <a href={it.url} target="_blank" rel="noreferrer noopener">
                      {String(it.text || it.title).replace(/\s+/g, ' ').slice(0, 140)}
                    </a>
                    {it.keywords?.length ? <span className="chip alert">⚠ {it.keywords.join('/')}</span> : null}
                  </td>
                  <td className="muted small">{L.showTime ? fmtTime(it.time) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className={layoutClass(layout)}>{(data?.items ?? []).map(renderCard)}</section>
      )}

      {data && (data.items ?? []).length === 0 && <p className="muted">{t('noIntel')}</p>}
    </>
  );
}
