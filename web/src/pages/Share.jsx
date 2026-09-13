// Share.jsx — one-click sharing
//
// The UI has to answer one question honestly: **which sharing methods need a login, and what am I missing
// right now**. So the target list shows each target's login requirement and readiness state directly, says
// plainly what is missing when a login is absent, and marks what cannot be done as "unsupported" instead
// of offering a button that does nothing when clicked.
//
// Posting publicly (to the bilibili feed) always requires two confirmations, and an unverified feature is
// not clickable by default - the same discipline as sending a danmaku comment: once it is out, it cannot
// be taken back.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Collapsible from '../Collapsible.jsx';
import { Inline } from '../markdown.jsx';

export default function Share({ people = [] }) {
  const { t, tn } = useI18n();
  const [targets, setTargets] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [scopeKind, setScopeKind] = useState('latest');
  const [personId, setPersonId] = useState('');
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [format, setFormat] = useState('html');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [audit, setAudit] = useState([]);

  const load = async () => {
    try {
      const r = await api.shareTargets();
      setTargets(r.targets ?? []);
      setAccounts(r.accounts ?? []);
      const a = await api.shareAudit();
      setAudit(a.entries ?? []);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const scope = () =>
    scopeKind === 'person'
      ? { kind: 'person', id: personId }
      : scopeKind === 'day'
        ? { kind: 'day', id: day }
        : { kind: 'latest' };

  const download = async () => {
    setBusy('download');
    try {
      const res = await fetch('/api/share/bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), format, note }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'share.html';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`${t('shareSaved')}: ${name}`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const copyText = async () => {
    setBusy('copy');
    try {
      const r = await api.shareText({ scope: scope() });
      await navigator.clipboard.writeText(r.text ?? '');
      setMsg(t('shareCopied'));
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const post = async (target) => {
    const ok = window.confirm(
      t('sharePostConfirm').replace('{target}', target.name?.zh ?? target.id)
    );
    if (!ok) return;
    setBusy(target.id);
    try {
      const needVerify = target.status === 'needs-verification';
      const r = await api.sharePost({ target: target.id, scope: scope(), confirm: true, verify: needVerify });
      if (r.ok) {
        setMsg(`${t('sharePosted')}${r.verified ? ` · ${t('shareVerifiedNow')}` : ''}`);
      } else {
        setErr(`${r.error ?? 'failed'}`);
      }
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const statusLabel = (s) =>
    ({
      ready: t('shareReady'),
      'needs-login': t('shareNeedsLogin'),
      'needs-verification': t('shareNeedsVerify'),
      unsupported: t('shareUnsupported'),
    })[s] ?? s;

  const canPost = (x) => x.status === 'ready' || x.status === 'needs-verification';

  return (
    <section className="panel">
      <h2>{t('shareTitle')}</h2>
      <div className="hint"><Inline text={t('shareHint')} /></div>
      {err && <div className="hint warn-text">{err}</div>}

      <div className="row">
        <div className="field" style={{ flex: '0 0 150px' }}>
          <label>{t('shareScope')}</label>
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value)}>
            <option value="latest">{t('shareScopeLatest')}</option>
            <option value="day">{t('shareScopeDay')}</option>
            <option value="person">{t('shareScopePerson')}</option>
          </select>
        </div>
        {scopeKind === 'day' && (
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('date')}</label>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
        )}
        {scopeKind === 'person' && (
          <div className="field" style={{ flex: '0 0 180px' }}>
            <label>{t('tab_people')}</label>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label>{t('shareFormat')}</label>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="html">html</option>
            <option value="md">md</option>
            <option value="json">json</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label>{t('calNote')}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('shareNotePh')} />
        </div>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <button className="primary" onClick={download} disabled={busy === 'download' || (scopeKind === 'person' && !personId)}>
            {busy === 'download' ? t('loading') : t('shareDownload')}
          </button>{' '}
          <button className="ghost" onClick={copyText} disabled={busy === 'copy'}>
            {busy === 'copy' ? t('loading') : t('shareCopy')}
          </button>
        </div>
      </div>

      <table className="reportlist" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>{t('shareTarget')}</th>
            <th style={{ width: 120 }}>{t('shareLogin')}</th>
            <th style={{ width: 130 }}>{t('shareStatus')}</th>
            <th style={{ width: 200 }}>{t('shareAction')}</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((x) => (
            <tr key={x.id}>
              <td>
                {x.name?.zh}
                <div className="muted small">{x.hint?.zh}</div>
              </td>
              <td>
                {x.needsLogin ? (
                  <span className="badge optional">{t('yes')}</span>
                ) : (
                  <span className="badge none">{t('no')}</span>
                )}
              </td>
              <td className={x.status === 'ready' ? 'ok-text' : x.status === 'unsupported' ? 'delta-down' : 'muted small'}>
                {statusLabel(x.status)}
                {x.account ? <div className="muted small">{x.account}</div> : null}
                {x.reason ? <div className="muted small">{x.reason}</div> : null}
              </td>
              <td>
                {x.declaredStatus === 'post' ? null : null}
                {canPost(x) ? (
                  <button className="ghost tiny" onClick={() => post(x)} disabled={busy === x.id}>
                    {x.status === 'needs-verification' ? t('shareVerifyPost') : t('sharePost')}
                  </button>
                ) : (
                  <span className="muted small">{x.needsLogin ? t('shareCannotWithoutLogin') : t('shareUnsupportedShort')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {accounts.length ? (
        <div className="muted small">
          {t('shareAccounts')}: {accounts.map((a) => `${a.name ?? a.id}${a.canSend ? ' ✓' : ' ✗'}`).join('、')}
        </div>
      ) : null}

      <Collapsible id="share-audit" title={t('shareAudit')} count={audit.length} summary={t('shareAuditHint')}>
        {audit.length === 0 ? (
          <p className="muted small">—</p>
        ) : (
          <ul className="muted small" style={{ paddingLeft: 18 }}>
            {audit.slice(0, 20).map((a, i) => (
              <li key={i}>
                {String(a.at).slice(11, 19)} · {a.action} · {a.target ?? a.scope ?? ''} {a.items ? tn('items', a.items) : ''}
                {a.ok === false ? ` ❌ ${a.error ?? ''}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      {msg && <div className="toast ok">{msg}</div>}
    </section>
  );
}
