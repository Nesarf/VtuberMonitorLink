// Live.jsx - live status + multi-player grid
//
// Feature provenance: dd-center/bilibili-dd-monitor (MIT, (c) 2020 wdpm) - "a multi-screen live
// viewing tool designed for DD".
// Reimplemented here on this project's stack (React), **without copying any upstream code or
// assets**:
//   • the player uses bilibili's official embed page /blanc/<roomId> (measured: no
//     X-Frame-Options, so it can be iframed directly, needing no forwarding, proxy or local
//     service, and therefore involving no login state);
//   • live data comes from the batch endpoint this project measured as working, and "live" (1)
//     is kept apart from "round/loop" (2) - treating a loop as live produces false alarms, which
//     is the thing to be most careful about now that the upstream data source has stopped
//     working.
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { Inline } from '../markdown.jsx';

const LS_KEY = 'vml-live-grid';
const LS_COLS = 'vml-live-cols';

/**
 * URL rules for the multi-screen grid tiles. All three measured embeddable (2026-09-11):
 *   bilibili  live.bilibili.com/blanc/<roomId>      no frame restriction
 *   twitch    player.twitch.tv/?channel=&parent=    CSP frame-ancestors explicitly allows 127.0.0.1
 *   youtube   youtube.com/embed/...                 no frame-ancestors
 * Twitch's parent must equal **the domain of the embedding page**, or it refuses; this tool runs
 * on 127.0.0.1, so that is what it is.
 */
export const PLATFORMS = [
  { id: 'bilibili', label: 'bilibili', hint: '直播间号，如 22637261', needsProxy: false },
  { id: 'twitch', label: 'Twitch', hint: '频道名，如 neurosama', needsProxy: true },
  { id: 'youtube', label: 'YouTube', hint: '频道 ID(UC…，取直播) 或视频 ID', needsProxy: true },
];

export function tileSrc(tile) {
  const id = String(tile.id ?? '').trim();
  if (tile.platform === 'twitch') {
    return `https://player.twitch.tv/?channel=${encodeURIComponent(id)}&parent=127.0.0.1&muted=true&autoplay=true`;
  }
  if (tile.platform === 'youtube') {
    // A leading UC means a channel (use live_stream to fetch the current live), otherwise treat
    // it as a video ID
    return id.startsWith('UC')
      ? `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(id)}`
      : `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
  }
  return `https://live.bilibili.com/blanc/${encodeURIComponent(id)}?hidePanel=1`;
}

export function tileUrl(tile) {
  const id = String(tile.id ?? '').trim();
  if (tile.platform === 'twitch') return `https://twitch.tv/${id}`;
  if (tile.platform === 'youtube') return id.startsWith('UC') ? `https://www.youtube.com/channel/${id}/live` : `https://youtu.be/${id}`;
  return `https://live.bilibili.com/${id}`;
}

function statusOf(s) {
  if (s === 1) return { key: 'live', label: '直播中', cls: 'badge required' };
  if (s === 2) return { key: 'round', label: '轮播', cls: 'badge optional' };
  return { key: 'off', label: '未开播', cls: 'badge' };
}

export default function Live() {
  const { t, tn, lang } = useI18n();
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
  const [net, setNet] = useState({});
  const [probing, setProbing] = useState('');
  const [manualPlatform, setManualPlatform] = useState('twitch');
  const [manualId, setManualId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  // State related to sending danmaku (a write operation)
  const [accounts, setAccounts] = useState(null);
  const [acctId, setAcctId] = useState('');
  const [sendRoom, setSendRoom] = useState('');
  const [sendRoomManual, setSendRoomManual] = useState('');
  const [sendText, setSendText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [sent, setSent] = useState(null);
  const [audit, setAudit] = useState([]);
  const [maxLen, setMaxLen] = useState(20);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(grid));
    document.documentElement.style.setProperty('--vml-live-cols', cols === 'auto' ? 'auto' : cols);
    localStorage.setItem(LS_COLS, cols);
  }, [grid, cols]);

  const load = async (fresh) => {
    setBusy(true);
    try {
      const d = await api.getLive(fresh);
      setData(d);
      for (const r of (d.live ?? []).slice(0, 6)) probeRoom(r);
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
  const inGrid = (roomId) => grid.some((g) => g.platform === 'bilibili' && g.id === String(roomId));
  const addToGrid = (room) =>
    setGrid((g) =>
      g.some((x) => x.platform === 'bilibili' && x.id === String(room.roomId))
        ? g
        : [...g, { platform: 'bilibili', id: String(room.roomId), label: room.name || room.uname || String(room.roomId) }]
    );
  const removeFromGrid = (platform, id) => setGrid((g) => g.filter((x) => !(x.platform === platform && x.id === id)));

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    setGrid((g) =>
      g.some((x) => x.platform === manualPlatform && x.id === id)
        ? g
        : [...g, { platform: manualPlatform, id, label: manualLabel.trim() || id }]
    );
    setManualId('');
    setManualLabel('');
  };

  const addAllLive = () => {
    const live = data?.live ?? [];
    if (!live.length) return setMsg(t('noLiveNow'));
    setGrid((g) => {
      const have = new Set(g.filter((x) => x.platform === 'bilibili').map((x) => x.id));
      return [...g, ...live.filter((x) => !have.has(String(x.roomId))).map((x) => ({ platform: 'bilibili', id: String(x.roomId), label: x.name || x.uname || String(x.roomId) }))];
    });
    setMsg(tn('items', live.length));
  };

  /** Network-layer probing: this layer (latency / failure rate) is the only one a third-party page can honestly measure */
  const probeRoom = async (r) => {
    setProbing(r.uid);
    try {
      const res = await api.probe({ url: r.url || `https://live.bilibili.com/${r.roomId}`, samples: 3 });
      const one = res.results?.[0];
      if (one) setNet((n) => ({ ...n, [r.uid]: one }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setProbing('');
    }
  };

  const sendable = (accounts ?? []).filter((a) => a.canSend);
  const room = (sendRoomManual || sendRoom || '').replace(/\D/g, '');

  const loadAccounts = async () => {
    setBusy('accounts');
    try {
      const r = await api.getAccounts();
      setAccounts(r.accounts ?? []);
      setMaxLen(r.limits?.maxLen ?? 20);
      if (!acctId) {
        const first = (r.accounts ?? []).find((a) => a.canSend);
        if (first) setAcctId(first.id);
      }
      setAudit((await api.getDanmakuAudit()).entries ?? []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    // Deliberately does **not** read the login state on mount. Two reasons:
    // 1) reading it decrypts DPAPI synchronously (measured 3-4 seconds), and the whole Node
    //    event loop is stopped for that long - opening the live page would make **other pages**
    //    sit on "loading" too (measured: click the live page, then settings, and settings is
    //    blank for 4 seconds);
    // 2) it reads the browser's cookie store. While the user has no intention of sending
    //    danmaku, it should not be touched at all (a privacy gate).
    // Click "check login state" when needed; the server side also caches it for 60 seconds.
    api
      .getDanmakuAudit()
      .then((r) => setAudit(r.entries ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Send: "confirmed" is passed along as a parameter, and the server checks it once more */
  const doSend = async () => {
    if (!confirmed) return;
    setBusy('danmaku');
    setSent(null);
    try {
      const r = await api.sendDanmaku({ accountId: acctId, roomId: room, text: sendText, confirm: true });
      setSent(r);
      if (r.ok) {
        setSendText('');
        setConfirmed(false);
        setAudit((await api.getDanmakuAudit()).entries ?? []);
      }
    } catch (e) {
      // A backend rejection (400) is normal guard-rail behaviour; pull the explanation out of the body
      try {
        setSent(JSON.parse(e.message));
      } catch {
        setSent({ ok: false, error: e.message });
      }
    } finally {
      setBusy('');
    }
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

      {/* Multi-screen grid: iframe bilibili's official player directly */}
      {grid.length > 0 && (
        <section className="panel">
          <h2>
            {t('multiScreen')}（{grid.length}）
          </h2>
          <div style={gridStyle}>
            {grid.map((g) => (
              <div className="player" key={g.platform + ':' + g.id}>
                <div className="player-head">
                  <span className="chip">{g.platform}</span>
                  <span>{g.label || g.id}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <a href={tileUrl(g)} target="_blank" rel="noreferrer noopener" className="small">
                    ↗
                  </a>
                  <button className="ghost tiny" onClick={() => removeFromGrid(g.platform, g.id)}>
                    ✕
                  </button>
                </div>
                <iframe src={tileSrc(g)} title={String(g.label || g.id)} allowFullScreen referrerPolicy="no-referrer" loading="lazy" />
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
              {/* Measured network-layer latency / packet loss: the part a third-party page **can** honestly measure */}
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <button className="ghost tiny" onClick={() => probeRoom(r)} disabled={!!probing}>
                  {probing === r.uid ? t('probingOne') : t('liveProbe')}
                </button>
                {net[r.uid] ? (
                  <>
                    <span className={`lat ${net[r.uid].direct?.ok ? (net[r.uid].direct.loss > 0 ? 'warn' : 'ok') : 'bad'}`}>
                      {t('directEgress')} {net[r.uid].direct?.ok ? `${net[r.uid].direct.avg}ms` : '✕'} ·{' '}
                      {Math.round((net[r.uid].direct?.loss ?? 0) * 100)}%
                    </span>
                    <span className={`lat ${net[r.uid].proxy?.skipped ? 'stale' : net[r.uid].proxy?.ok ? 'ok' : 'bad'}`}>
                      {t('proxyEgress')}{' '}
                      {net[r.uid].proxy?.skipped ? '—' : net[r.uid].proxy?.ok ? `${net[r.uid].proxy.avg}ms` : '✕'} ·{' '}
                      {net[r.uid].proxy?.skipped ? '—' : `${Math.round((net[r.uid].proxy?.loss ?? 0) * 100)}%`}
                    </span>
                    <span className="muted small">{net[r.uid].hint}</span>
                  </>
                ) : null}
              </div>
              {/* Bitrate / frame rate are **not measurable**: say so honestly instead of inventing a number */}
              <div className="muted small" title={t('liveQualityWhy')}>
                {t('liveQualityUnavailable')}
              </div>
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

      {/* Manually add live sources from other platforms - Twitch / YouTube both measured embeddable (see docs/LIVE.md) */}
      <section className="panel">
        <h2>{t('liveAddOther')}</h2>
        <div className="hint">{t('liveAddOtherHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('livePlatform')}</label>
            <select value={manualPlatform} onChange={(e) => setManualPlatform(e.target.value)}>
              {PLATFORMS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.needsProxy ? ' *' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t('liveId')}</label>
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addManual()}
              placeholder={PLATFORMS.find((p) => p.id === manualPlatform)?.hint ?? ''}
            />
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('label')}</label>
            <input value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} placeholder="显示用的名字" />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="primary" onClick={addManual} disabled={!manualId.trim()}>
              {t('addToGrid')}
            </button>
          </div>
        </div>
        <div className="hint" style={{ margin: 0 }}><Inline text={t('liveProxyCaveat')} /></div>
      </section>

      {/* Posting a comment - it speaks publicly as the user themselves, so manual confirmation is required */}
      <section className="panel">
        <h2>{t('danmakuTitle')}</h2>
        <div className="problems" style={{ marginBottom: 10 }}>
          <Inline text={t('danmakuWarn')} />
        </div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 260px' }}>
            <label>{t('danmakuAccount')}</label>
            <select value={acctId} onChange={(e) => setAcctId(e.target.value)} disabled={!sendable.length}>
              <option value="">—</option>
              {sendable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.uname ?? a.mid} （{a.browser}）
                </option>
              ))}
            </select>
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="ghost tiny" onClick={loadAccounts} disabled={busy}>
                {accounts === null ? t('checkLogin') : t('danmakuRefresh')}
              </button>
              {accounts && !sendable.length ? <span className="muted small">{t('danmakuNoAccount')}</span> : null}
            </div>
            {/* When the login state has not been read yet, spell out that this would read the browser cookie store (reusing existing copy, adding no new entries) */}
            {accounts === null ? <div className="hint" style={{ margin: '4px 0 0' }}><Inline text={t('loginHint')} /></div> : null}
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{t('danmakuRoom')}</label>
            <select value={sendRoom} onChange={(e) => setSendRoom(e.target.value)}>
              <option value="">—</option>
              {grid
                .filter((x) => x.platform === 'bilibili')
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label || x.id}（{x.id}）
                  </option>
                ))}
            </select>
            <input
              style={{ marginTop: 4 }}
              value={sendRoomManual}
              onChange={(e) => setSendRoomManual(e.target.value.replace(/\D/g, ''))}
              placeholder="也可手填"
            />
          </div>
          <div className="field">
            <label>
              {t('danmakuText')}（{[...sendText].length}/{maxLen} {t('danmakuLen')}）
            </label>
            <input
              value={sendText}
              onChange={(e) => setSendText(e.target.value)}
              maxLength={maxLen}
              onKeyDown={(e) => e.key === 'Enter' && confirmed && doSend()}
              placeholder="要发的内容"
            />
          </div>
        </div>
        <label className="inline-check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {t('danmakuConfirm')}
        </label>
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="primary" onClick={doSend} disabled={!!busy || !confirmed || !sendText.trim() || !room || !acctId}>
              {busy === 'danmaku' ? t('danmakuSending') : t('danmakuSend')}
            </button>
          </div>
          <div className="field" style={{ flex: 1 }}>
            {sent && (
              <span className={sent.ok ? 'hint ok-text' : 'hint warn-text'} style={{ margin: 0 }}>
                {sent.ok ? `✅ ${t('danmakuOk')}` : `❌ code=${sent.code ?? '-'} ${sent.error ?? sent.message ?? ''}${sent.hint ? ` — ${sent.hint}` : ''}`}
              </span>
            )}
          </div>
        </div>
        {audit?.length ? (
          <details style={{ marginTop: 8 }}>
            <summary className="muted small">
              {t('danmakuAudit')}（{audit.length}）· {t('danmakuAuditHint')}
            </summary>
            <ul className="muted small" style={{ paddingLeft: 18 }}>
              {audit.slice(0, 10).map((a, i) => (
                <li key={i}>
                  {new Date(a.at).toLocaleString()} · {a.uname ?? a.mid} → 房间 {a.roomId} · 「{a.text}」 ·{' '}
                  {a.ok ? '✅' : `❌ ${a.code ?? ''} ${a.error ?? ''}`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

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
