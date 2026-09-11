// Live.jsx — 开播监测 + 多屏观看 / live status + multi-player grid
//
// 功能来源：dd-center/bilibili-dd-monitor（MIT, (c) 2020 wdpm）——「专为 DD 设计的多屏直播观看工具」。
// 这里按本项目栈（React）重新实现，**没有复制上游代码或资源**：
//   • 播放器用 B 站官方内嵌页 /blanc/<roomId>（实测无 X-Frame-Options，可直接 iframe，
//     不需要任何转发、代理或本地服务，也就不涉及任何登录态）；
//   • 开播数据用本项目实测可用的批量接口，并区分「直播中」(1) 与「轮播」(2) ——
//     轮播当成开播会误报，这是上游那套数据源失效后最需要小心的地方。
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

const LS_KEY = 'vml-live-grid';
const LS_COLS = 'vml-live-cols';

function statusOf(s) {
  if (s === 1) return { key: 'live', label: '直播中', cls: 'badge required' };
  if (s === 2) return { key: 'round', label: '轮播', cls: 'badge optional' };
  return { key: 'off', label: '未开播', cls: 'badge' };
}

export default function Live() {
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [grid, setGrid] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    } catch {
      return [];
    }
  });
  const [cols, setCols] = useState(() => localStorage.getItem(LS_COLS) ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [rosterQ, setRosterQ] = useState('');
  const [roster, setRoster] = useState(null);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(grid));
    document.documentElement.style.setProperty('--vml-live-cols', cols === 'auto' ? 'auto' : cols);
    localStorage.setItem(LS_COLS, cols);
  }, [grid, cols]);

  const load = async (fresh) => {
    setBusy(true);
    try {
      setData(await api.getLive(fresh));
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load(true);
  }, []);

  const all = useMemo(() => [...(data?.live ?? []), ...(data?.round ?? []), ...(data?.off ?? [])], [data]);
  const inGrid = (roomId) => grid.some((g) => g.roomId === roomId);
  const addToGrid = (room) =>
    setGrid((g) => (g.some((x) => x.roomId === room.roomId) ? g : [...g, { roomId: room.roomId, name: room.name || room.uname }]));
  const removeFromGrid = (roomId) => setGrid((g) => g.filter((x) => x.roomId !== roomId));

  const addAllLive = () => {
    const live = data?.live ?? [];
    if (!live.length) return setMsg(t('noLiveNow'));
    setGrid((g) => {
      const have = new Set(g.map((x) => x.roomId));
      return [...g, ...live.filter((x) => !have.has(x.roomId)).map((x) => ({ roomId: x.roomId, name: x.name || x.uname }))];
    });
    setMsg(`${live.length} ${t('items')}`);
  };

  const findUid = async () => {
    setBusy(true);
    try {
      setRoster(await api.searchRoster(rosterQ));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addUid = async (uid) => {
    setBusy(true);
    try {
      const cfg = await api.getConfig();
      const uids = [...new Set([...(cfg.live?.uids ?? []).map((x) => (typeof x === 'string' ? x : x.uid)), String(uid)])];
      await api.putConfig({ ...cfg, live: { ...(cfg.live ?? {}), uids } });
      setMsg(`${t('added')}: ${uid}`);
      await load(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data && busy) return <div className="panel">{t('loading')}</div>;

  const gridStyle =
    cols === 'auto'
      ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }
      : { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10 };

  return (
    <>
      <section className="panel">
        <h2>{t('liveTitle')}</h2>
        <div className="hint">{t('liveHint')}</div>
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="primary" onClick={() => load(true)} disabled={busy}>
              {busy ? t('checking') : t('liveCheck')}
            </button>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={addAllLive} disabled={busy}>
              {t('addAllLive')}
            </button>{' '}
            <button className="ghost" onClick={() => setGrid([])} disabled={!grid.length}>
              {t('clearGrid')}
            </button>
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('gridColumns')}</label>
            <select value={cols} onChange={(e) => setCols(e.target.value)}>
              <option value="auto">{t('columns_auto')}</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="hint" style={{ margin: 0 }}>
              {(data?.live ?? []).length} {t('liveNow')} · {(data?.round ?? []).length} {t('liveRound')} ·{' '}
              {(data?.off ?? []).length} {t('liveOff')} · {t('liveMonitored')} {data?.monitored ?? all.length}
              {data?.at ? ` · ${new Date(data.at).toLocaleTimeString()}` : ''}
            </div>
          </div>
        </div>
        {msg && <div className="hint" style={{ margin: 0 }}>{msg}</div>}
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
      </section>

      {/* 多屏网格：iframe 直接嵌 B 站官方播放器 */}
      {grid.length > 0 && (
        <section className="panel">
          <h2>
            {t('multiScreen')}（{grid.length}）
          </h2>
          <div style={gridStyle}>
            {grid.map((g) => (
              <div className="player" key={g.roomId}>
                <div className="player-head">
                  <span>{g.name || g.roomId}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <a href={`https://live.bilibili.com/${g.roomId}`} target="_blank" rel="noreferrer noopener" className="small">
                    ↗
                  </a>
                  <button className="ghost tiny" onClick={() => removeFromGrid(g.roomId)}>
                    ✕
                  </button>
                </div>
                <iframe
                  src={`https://live.bilibili.com/blanc/${g.roomId}?hidePanel=1`}
                  title={String(g.name || g.roomId)}
                  allowFullScreen
                  referrerPolicy="no-referrer"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="cards">
        {all.map((r) => {
          const st = statusOf(r.status);
          return (
            <article className={`card${st.key === 'live' ? ' starred' : ''}`} key={r.uid}>
              <header>
                <span className={st.cls}>{st.label}</span>
                <span className="muted small">{r.uname || r.name}</span>
                {r.online ? <span className="muted small">👁 {r.online}</span> : null}
                <span className="spacer" style={{ flex: 1 }} />
                {r.roomId ? (
                  <button className="ghost tiny" onClick={() => (inGrid(r.roomId) ? removeFromGrid(r.roomId) : addToGrid(r))}>
                    {inGrid(r.roomId) ? t('removeFromGrid') : t('addToGrid')}
                  </button>
                ) : null}
              </header>
              {r.cover ? <img className="thumb big" src={r.cover} alt="" referrerPolicy="no-referrer" loading="lazy" /> : null}
              <p>{r.title || <span className="muted">{t('liveNoTitle')}</span>}</p>
              <footer>
                {r.areaName ? <span className="muted small">{r.areaName}</span> : null}
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer noopener">
                    {t('openStream')} ↗
                  </a>
                ) : null}
              </footer>
            </article>
          );
        })}
      </section>
      {all.length === 0 && <p className="muted">{t('liveNoTargets')}</p>}

      <section className="panel">
        <h2>{t('liveFindUid')}</h2>
        <div className="hint">{t('liveFindHint')}</div>
        <div className="row">
          <div className="field">
            <input
              value={rosterQ}
              onChange={(e) => setRosterQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && findUid()}
              placeholder={t('liveFindPlaceholder')}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={findUid} disabled={busy || !rosterQ.trim()}>
              {t('search')}
            </button>
          </div>
        </div>
        {roster && (
          <ul className="muted small" style={{ paddingLeft: 18 }}>
            {roster.ok === false ? <li>{roster.error}</li> : null}
            {(roster.hits ?? []).map((h) => (
              <li key={h.mid}>
                {h.uname} <span className="muted">uid {h.mid}</span>{' '}
                <button className="ghost tiny" onClick={() => addUid(h.mid)} disabled={busy}>
                  {t('add')}
                </button>
              </li>
            ))}
            {roster.ok && !(roster.hits ?? []).length ? <li>{t('noMatches')}</li> : null}
          </ul>
        )}
      </section>
    </>
  );
}
