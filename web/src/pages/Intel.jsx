// Intel.jsx — 情报卡片流 / intel card stream
// 把最近一次运行抓到的条目按来源/关键词过滤后铺成卡片；B 站配图直接内联显示
// （i0.hdslb.com 有防盗链，靠 referrerPolicy="no-referrer" 绕过）。
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString();
}

export default function Intel() {
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setData(await api.getIntel({ q, source, alerts: alertsOnly ? 1 : undefined }));
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
    for (const it of data?.items ?? []) {
      const name = it.sourceName?.[lang] ?? it.sourceId;
      map.set(it.sourceId, name);
    }
    return [...map.entries()];
  }, [data, lang]);

  const watchBlock = (data?.watch ?? []).filter((w) => w.ok && (w.changed || w.growth));

  return (
    <>
      <section className="panel">
        <h2>{t('intelTitle')}</h2>
        <div className="hint">{t('intelHint')}</div>

        <div className="row">
          <div className="field">
            <label>{t('search')}</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder={t('intelSearchPlaceholder')} />
          </div>
          <div className="field">
            <label>{t('sources')}</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t('all')}</option>
              {sourceOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('onlyAlerts')}</label>
            <select value={String(alertsOnly)} onChange={(e) => setAlertsOnly(e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={load} disabled={busy}>
              {busy ? t('loading') : t('refresh')}
            </button>
          </div>
        </div>
        <div className="hint" style={{ margin: 0 }}>
          {data?.generatedAt ? `${t('generatedAt')}: ${fmtTime(data.generatedAt)} · ${data.count}/${data.total} ${t('items')}` : t('noIntel')}
        </div>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
      </section>

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

      <section className="cards">
        {(data?.items ?? []).map((it) => (
          <article className="card" key={it.id}>
            <header>
              <span className="chip">{it.sourceName?.[lang] ?? it.sourceId}</span>
              {it.time ? <span className="muted small">{fmtTime(it.time)}</span> : null}
              {it.keywords?.length ? <span className="chip alert">⚠ {it.keywords.join('/')}</span> : null}
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
            {it.images?.length ? (
              <div className="thumbs">
                {it.images.slice(0, 6).map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noreferrer noopener">
                    <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" />
                  </a>
                ))}
              </div>
            ) : null}
            <footer>
              {it.stats?.like ? <span className="muted small">👍 {it.stats.like}</span> : null}
              {it.stats?.user ? <span className="muted small">✎ {it.stats.user}</span> : null}
              {typeof it.stats?.delta === 'number' && it.stats.delta !== 0 ? (
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
        ))}
        {data && (data.items ?? []).length === 0 && <p className="muted">{t('noIntel')}</p>}
      </section>
    </>
  );
}
