// Intel.jsx — intel stream
// The layout is DIY-able (card wall / list / compact / timeline / table), with starring and
// read state, and a this-run vs last-run comparison.
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { layoutClass, normalizeLayout } from '../layout.js';
import Collapsible from '../Collapsible.jsx';

/** image kind -> icon (matching IMAGE_KINDS in vision.js) */
const IMAGE_KIND_ICON = {
  illustration: '🎨',
  screenshot: '🖥',
  photo: '📷',
  meme: '😂',
  merch: '🛍',
  poster: '📰',
  event: '🎉',
  other: '🖼',
};

function fmtTimeOf(value, format) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : format(d);
}

export default function Intel({ layout }) {
  const { t, tn, lang, fmtDateTime } = useI18n();
  // The formatter comes from the application's locale rather than from the browser: a bare
  // `toLocaleString()` follows the *browser's* language, so a reader using the Thai UI in an en-US
  // browser saw English dates while the page around them was Thai (docs/BUGS.md #79). Binding it here
  // keeps the four call sites below unchanged.
  const fmtTime = (value) => fmtTimeOf(value, fmtDateTime);
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
  // Same event from several sources merged: when on, the stream is presented by "event" rather
  // than by "item"
  const [merge, setMerge] = useState(false);
  const [events, setEvents] = useState(null);
  // Image tagging: the ready state decides whether the button is clickable (when it is not
  // enabled, the reason goes into the tooltip)
  const [visionReadyOk, setVisionReadyOk] = useState(null);
  const [visionReason, setVisionReason] = useState('');

  useEffect(() => {
    api
      .visionStats()
      .then((v) => {
        setVisionReadyOk(v?.ready?.ok === true);
        setVisionReason(v?.ready?.reason ?? '');
      })
      .catch(() => setVisionReadyOk(false));
  }, []);

  const tagImages = async () => {
    setBusy('vision');
    try {
      const r = await api.tagImages({ limit: 40 });
      setErr('');
      window.alert(`${t('visionTagged')}: ${r.tagged ?? 0}（${t('visionCached')} ${r.cached ?? 0}）`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const loadEvents = async (on) => {
    if (!on) return;
    setBusy(true);
    try {
      setEvents(await api.getEvents({ per: 40 }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

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

  // `|| w.growth` used to be part of this: a growth reading is a change even when nothing else moved. No
  // handler produces one any more, so the filter is "changed" alone (the field itself stays, see the
  // `follower` comment in server/src/server.js).
  const watchBlock = (data?.watch ?? []).filter((w) => w.ok && w.changed);

  const renderCard = (it) => (
    <article className={`card${it.flag?.starred ? ' starred' : ''}${it.flag?.read ? '' : ' unread'}`} key={it.id}>
      <header>
        {L.showSource && <span className="chip">{it.sourceName?.[lang] ?? it.sourceId}</span>}
        {L.showTime && it.time ? <span className="muted small">{fmtTime(it.time)}</span> : null}
        {it.keywords?.length ? <span className="chip alert">⚠ {it.keywords.join('/')}</span> : null}
        {/* Image tags: produced by vision-model tagging (merged from the cache at read time). The icon comes from kind, so what the image is can be told at a glance */}
        {(it.imageTags ?? []).map((tag) => (
          <span className="chip img-tag" key={'img-' + tag} title={(it.imageKinds ?? []).join('/')}>
            {IMAGE_KIND_ICON[it.imageKinds?.[0]] ?? '🖼'} {tag}
          </span>
        ))}
        {it.imageText ? (
          <span className="chip" title={it.imageText}>
            🔤 {it.imageText.slice(0, 24)}
          </span>
        ) : null}
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
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('mergeEvents')}</label>
            <select
              value={String(merge)}
              onChange={(e) => {
                const on = e.target.value === 'true';
                setMerge(on);
                loadEvents(on);
              }}
            >
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={load} disabled={busy}>
              {busy ? t('loading') : t('refresh')}
            </button>{' '}
            <button
              className="ghost"
              onClick={tagImages}
              disabled={busy === 'vision' || visionReadyOk === false}
              title={visionReason ?? ''}
            >
              {busy === 'vision' ? t('loading') : t('visionTag')}
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
                  setErr(r.ok ? '' : `${t('featuresShort')}: ${r.error}`);
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
            ? `${t('generatedAt')}: ${fmtTime(data.generatedAt)} · ${data.count}/${tn('items', data.total)}${data.starred ? ` · ★ ${data.starred}` : ''}`
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
              </li>
            ))}
          </ul>
        </section>
      )}

      {merge && events ? (
        <section className="panel">
          <h2>
            {t('eventsTitle')}
            <span className="muted small" style={{ marginLeft: 12 }}>
              {t('eventsStats')}: {events.stats.events} · {t('eventsMerged')}: {events.stats.duplicatesRemoved} · {t('eventsConfirmed')}:{' '}
              {events.stats.confirmedEvents}
            </span>
          </h2>
          <div className="hint">{t('eventsHint')}</div>
          {(events.events ?? []).map((ev) => (
            <div key={ev.id} className={'event-row' + (ev.confirmed ? ' confirmed' : '')}>
              <div className="event-head">
                {ev.confirmed ? <span className="badge optional">✔ {t('eventsConfirmedBadge')}</span> : null}
                <b>{ev.title}</b>
              </div>
              <div className="muted small">
                {t('eventsSources')}: {ev.sourceCount}（{ev.sources.join('、')}）
                {ev.duplicateCount ? ` · ${t('eventsMergedShort')} ${ev.duplicateCount}` : ''}
                {ev.leadSourceId ? ` · lead: ${ev.leadSourceId}` : ''}
                {ev.firstAt ? ` · ${ev.firstAt.slice(0, 16).replace('T', ' ')}` : ''}
              </div>
              {ev.items.length > 1 ? (
                <Collapsible id={'ev-' + ev.id} title={t('eventsItems')} count={ev.items.length} summary={t('eventsItemsHint')}>
                  {ev.items.map((it, i) => (
                    <div key={it.id ?? i} className="small">
                      · {String(it.title ?? '').slice(0, 100)} <span className="muted">({it.sourceId})</span>
                      {it.url ? (
                        <>
                          {' '}
                          <a href={it.url} target="_blank" rel="noreferrer noopener">
                            {t('open')}
                          </a>
                        </>
                      ) : null}
                    </div>
                  ))}
                </Collapsible>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

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
