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
import { Inline } from '../markdown.jsx';

const LS_KEY = 'vml-live-grid';
const LS_COLS = 'vml-live-cols';

/**
 * 多屏格子的地址规则。三家都实测可嵌（2026-09-11）：
 *   bilibili  live.bilibili.com/blanc/<roomId>      无 frame 限制
 *   twitch    player.twitch.tv/?channel=&parent=    CSP frame-ancestors 明确放行 127.0.0.1
 *   youtube   youtube.com/embed/...                 无 frame-ancestors
 * Twitch 的 parent 必须等于**嵌入页的域名**，否则拒绝；本工具跑在 127.0.0.1，所以就是它。
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
    // UC 开头是频道（用 live_stream 取当前直播），否则当成视频 ID
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
  const [net, setNet] = useState({});
  const [probing, setProbing] = useState('');
  const [manualPlatform, setManualPlatform] = useState('twitch');
  const [manualId, setManualId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  // 发弹幕（写操作）相关状态
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
    setMsg(`${live.length} ${t('items')}`);
  };

  /** 网络层测速：第三方页面能诚实测到的只有这一层（延迟 / 失败率） */
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
    // 故意**不在挂载时**读登录态。两个原因：
    // ① 读它要同步解 DPAPI（实测 3~4 秒），而这期间整个 Node 事件循环是停的 ——
    //    打开直播页会让**别的页面**一起卡在「加载中」（实测：点完直播页再点设置，设置页 4 秒白屏）；
    // ② 它读的是浏览器的 cookie 库。使用者还没打算发弹幕时，本来就不该去碰它（隐私闸门）。
    // 需要时点「检查登录态」即可，服务端那边也加了 60 秒缓存。
    api
      .getDanmakuAudit()
      .then((r) => setAudit(r.entries ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 发送：把「确认」这件事传成参数，服务端也会再检查一次 */
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
      // 后端拒绝时（400）也是正常的护栏行为，把 body 里的说明取出来
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

      {/* 多屏网格：iframe 直接嵌 B 站官方播放器 */}
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
              {/* 网络层实测延迟/丢包：这是第三方页面**能**诚实测到的部分 */}
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
              {/* 码率/帧数是**测不到**的，如实说明而不是编一个数字 */}
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

      {/* 手动添加其他平台的直播源 —— Twitch / YouTube 都实测可嵌（见 docs/LIVE.md） */}
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

      {/* 发评论 —— 用使用者本人身份公开发言，所以必须手动确认 */}
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
            {/* 还没主动去读登录态时，把「要去读浏览器 cookie 库」这件事说清楚（复用人写过的文案，不新增词条） */}
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
