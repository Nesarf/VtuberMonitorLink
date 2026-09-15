// Share.jsx — one-click sharing
//
// What has to be visible here, and why the page is shaped the way it is:
//
//   1) **Which method needs a login, and what is missing right now.** A posting site is three separate steps,
//      not one status, so each one gets its own column: **account** (which credential it would use, and
//      whether that credential satisfies what the site declares it needs), **verification** (whether what the
//      site requires before posting has actually been measured) and **send** (posting, which is only
//      meaningful once the first two are settled).
//   2) **Every row has a way forward.** The check button measures what the site needs (accounts are re-read,
//      the site is asked on demand), the configure panel sets the attachment mode/count and which account is
//      used and shows the site's own declared requirements, and a site this build cannot post to gets a
//      **manual hand-off** instead of a dead cell: the body and the attachment are prepared, a button opens the
//      site's compose page where the site supports a pre-filled one, and copy/download cover the rest.
//   3) **A hand-off is never a send.** Nothing is sent by the manual path, the server records it as `manual`,
//      and the send cell keeps saying that this app has not posted there.
//   4) **What goes into the file.** The image attachment is a setting now, and a bundle that could not attach
//      something says so.
//
// Posting publicly always requires an explicit confirmation, and a site whose sending code does not exist is
// not clickable for sending -- the same discipline as sending a danmaku comment: once it is out, it cannot be
// taken back.
//
// Where the wording lives: the page owns the buttons and labels it always had (dictionary entries). The
// **per-site** wording -- what a site needs, its limits, what the user has to bring, the compose template --
// travels from server/src/share.js with the site profile, so a hand-written `share.sites` entry can describe
// its own manual path without this file knowing anything about that site.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Collapsible from '../Collapsible.jsx';
import { Inline } from '../markdown.jsx';

export default function Share({ people = [] }) {
  const { t, tn, lang } = useI18n();
  const [targets, setTargets] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [scopeKind, setScopeKind] = useState('latest');
  const [personId, setPersonId] = useState('');
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [format, setFormat] = useState('html');
  const [note, setNote] = useState('');
  // Image attachment. 'none' by default: a bundle that references a remote image can go blank in front of
  // the recipient (hotlink protection), which is the one failure a share view must not have.
  const [images, setImages] = useState({ mode: 'none', maxPerBundle: 4 });
  const [imageModes, setImageModes] = useState([]);
  const [imageCountLabel, setImageCountLabel] = useState(null);
  const [loginKinds, setLoginKinds] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [audit, setAudit] = useState([]);
  // Per-target panels and the manual hand-off. Everything in `row` is per target and rebuilt on demand:
  // the account list (who could post there), the prepared body, and the hand-off the server computed.
  const [configFor, setConfigFor] = useState('');
  const [row, setRow] = useState({});
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ id: '', nameZh: '', nameEn: '', loginKind: 'bilibili', textLimit: 2000, maxImages: 4 });

  const load = async () => {
    try {
      const r = await api.shareTargets();
      setTargets(r.targets ?? []);
      setAccounts(r.accounts ?? []);
      if (r.images) setImages((cur) => ({ ...cur, mode: r.images.mode ?? cur.mode, maxPerBundle: r.images.maxPerBundle ?? cur.maxPerBundle }));
      if (r.imageModes) setImageModes(r.imageModes);
      if (r.imageCountLabel) setImageCountLabel(r.imageCountLabel);
      if (r.loginKinds) setLoginKinds(r.loginKinds);
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

  /** Bilingual product data (a site's name, hint, credential, stage detail) is picked here; UI copy goes through t() */
  const label = (v) => (v && typeof v === 'object' ? (v[lang] ?? v.zh ?? v.en ?? '') : (v ?? ''));
  const rowOf = (id) => row[id] ?? {};
  const setRowOf = (id, patch) => setRow((cur) => ({ ...cur, [id]: { ...(cur[id] ?? {}), ...patch } }));

  const download = async (targetId = null, override = null) => {
    setBusy(targetId ? `download:${targetId}` : 'download');
    try {
      const used = override ?? { mode: images.mode, maxPerBundle: images.maxPerBundle };
      const res = await fetch('/api/share/bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), format: targetId ? 'text' : format, note, images: used }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? (targetId ? 'share.txt' : 'share.html');
      const blob = await res.blob();
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
      const r = await api.shareText({ scope: scope(), images: { mode: images.mode, maxPerBundle: images.maxPerBundle } });
      await navigator.clipboard.writeText(r.text ?? '');
      setMsg(t('shareCopied'));
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * Run the verification step of one site.
   *
   * The stage is an app-level state that is only measured against the site when the user asks: the measurement
   * costs a request, and it deliberately posts nothing (for bilibili it asks the site which account the
   * credential is). The server re-reads the login state with `force: true` before measuring, so the check
   * never runs against a cached verdict, and stores the result per (target, account).
   */
  const check = async (target) => {
    setBusy(`check:${target.id}`);
    setErr('');
    try {
      const r = await api.shareVerify({ target: target.id, account: rowOf(target.id).accountId });
      const prepared = await api.sharePrepare({ target: target.id, scope: scope() });
      setRowOf(target.id, { accounts: prepared.accounts ?? [], accountId: prepared.accountId ?? '', prepared });
      if (r.ok) setMsg(label(r.detail) || t('shareReady'));
      else setErr(label(r.detail) || r.reason || r.error || 'failed');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /** Prepare the body for one site (cut to that site's own limit) and the accounts that could carry it */
  const prepare = async (target) => {
    setBusy(`prepare:${target.id}`);
    setErr('');
    try {
      const r = await api.sharePrepare({ target: target.id, scope: scope() });
      setRowOf(target.id, { accounts: r.accounts ?? [], accountId: rowOf(target.id).accountId || r.accountId || '', prepared: r });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /** The hand-off for a site this build cannot post to: text and links only, and the server audits it as manual */
  const handoff = async (target, { record = false } = {}) => {
    setBusy(`manual:${target.id}`);
    setErr('');
    try {
      const h = await api.shareHandoff({ target: target.id, scope: scope(), accountId: rowOf(target.id).accountId, handoff: record });
      setRowOf(target.id, { handoff: h, accounts: h.accounts ?? [] });
      return h;
    } catch (e) {
      setErr(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const openCompose = async (target) => {
    const h = rowOf(target.id).handoff ?? (await handoff(target, { record: true }));
    if (!h?.composeUrl) return;
    window.open(h.composeUrl, '_blank', 'noopener,noreferrer');
  };

  const copyManual = async (target) => {
    const h = rowOf(target.id).handoff ?? (await handoff(target, { record: true }));
    if (!h?.text) return;
    try {
      await navigator.clipboard.writeText(h.text);
      setMsg(t('shareCopied'));
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveImages = async (patch) => {
    const next = { ...images, ...patch };
    setImages(next);
    try {
      const r = await api.shareSettings({ images: next });
      if (r.images) setImages((cur) => ({ ...cur, ...r.images }));
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveAccount = async (target, accountId) => {
    setRowOf(target.id, { accountId });
    try {
      await api.shareSettings({ accounts: { [target.id]: accountId || null } });
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const addSite = async () => {
    setBusy('addSite');
    setErr('');
    try {
      const r = await api.shareSettings({
        sites: [
          {
            id: draft.id.trim(),
            name: { zh: draft.nameZh.trim(), en: draft.nameEn.trim() },
            loginKind: draft.loginKind === '' ? null : draft.loginKind,
            textLimit: Number(draft.textLimit) || undefined,
            maxImages: Number(draft.maxImages) || undefined,
          },
        ],
      });
      if (r.sitesError) setErr(r.sitesError);
      else {
        setMsg(`${t('shareSiteAdd')}: ${draft.id.trim()}`);
        setAdding(false);
        setDraft({ id: '', nameZh: '', nameEn: '', loginKind: 'bilibili', textLimit: 2000, maxImages: 4 });
        await load();
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const removeSite = async (id) => {
    setBusy(`remove:${id}`);
    try {
      await api.shareSettings({ removeSites: [id] });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const post = async (target) => {
    const ok = window.confirm(t('sharePostConfirm').replace('{target}', label(target.name) || target.id));
    if (!ok) return;
    setBusy(target.id);
    setErr('');
    try {
      const r = await api.sharePost({
        target: target.id,
        scope: scope(),
        confirm: true,
        accountId: rowOf(target.id).accountId || undefined,
      });
      if (r.ok) setMsg(t('sharePosted'));
      else setErr(`${r.error ?? 'failed'}`);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  // The dictionary entry for each stage state.
  //
  // There is deliberately **no call with a computed key here**: the tooling finds keys by reading call sites
  // that name the key as a string constant, so an entry reached only through a variable stops being seen as
  // used -- and an entry nothing uses is dropped from the coverage baseline and is no longer proofread or
  // translated in the other locales. Measured: doing it the variable way dropped all locales by exactly the
  // five share entries. So the mapping names the key literally at every call.
  const stageLabel = (stage) => {
    if (!stage) return '';
    const s = stage.status;
    if (stage.id === 'account') {
      if (s === 'satisfied') return t('shareReady');
      if (s === 'missing' || s === 'unknown') return t('shareNeedsLogin');
      if (s === 'not-required') return t('yes');
    }
    if (stage.id === 'verification') {
      if (s === 'done') return t('shareReady');
      if (s === 'needed' || s === 'unknown') return t('shareNeedsVerify');
      if (s === 'blocked') return t('shareUnsupported');
      if (s === 'not-required') return t('yes');
    }
    if (stage.id === 'send') {
      if (s === 'ready') return t('shareReady');
      if (s === 'blocked') return t('shareUnsupported');
      if (s === 'unimplemented') return t('shareUnsupportedShort');
      if (s === 'unknown') return t('shareCannotWithoutLogin');
    }
    // A state this page does not know (a newer server) falls back to the bilingual label the server sent
    // rather than to a raw status code.
    return label(stage.label) || stage.status || '';
  };

  /** Why the check button cannot run right now -- shown as its title, so the cell is never just empty */
  const checkHint = (x) => {
    const st = x.stages ?? {};
    if (st.verification?.status === 'done') return `${t('shareReady')} · ${(st.verification.detail && label(st.verification.detail)) || ''}`.trim();
    if (!x.site?.verify) return `${label(st.verification?.detail)} · ${t('shareSiteNeeds')}: ${label(x.site?.credential)}`;
    if (st.account?.status !== 'satisfied') return `${label(st.account?.detail)}`;
    return label(st.verification?.detail);
  };

  const stageCell = (stage) => (
    <>
      {stageLabel(stage)}
      {stage?.accountName ? <div className="muted small">{stage.accountName}</div> : null}
      {stage?.detail ? <div className="muted small">{label(stage.detail)}</div> : null}
    </>
  );

  const stagesOf = (x) => x.stages ?? {};
  const fileTargets = targets.filter((x) => x.kind !== 'post');
  const siteTargets = targets.filter((x) => x.kind === 'post');
  const manualSite = (x) => !stagesOf(x).send?.implemented && !!x.site;
  const currentLoginKind = loginKinds.find((k) => (k.id ?? '') === draft.loginKind);

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
          <button className="primary" onClick={() => download()} disabled={busy === 'download' || (scopeKind === 'person' && !personId)}>
            {busy === 'download' ? t('loading') : t('shareDownload')}
          </button>{' '}
          <button className="ghost" onClick={copyText} disabled={busy === 'copy'}>
            {busy === 'copy' ? t('loading') : t('shareCopy')}
          </button>
        </div>
      </div>

      {/* What goes into the file: the attachment mode and the count are saved (a per-visit setting would be
          forgotten the moment the page is reloaded, which is not what a settings box means). */}
      <div className="row">
        <div className="field" style={{ flex: '0 0 230px' }}>
          <label>{t('shareImages')}</label>
          <select value={images.mode} onChange={(e) => saveImages({ mode: e.target.value })}>
            {(imageModes.length ? imageModes : [{ id: 'none', label: { zh: 'none', en: 'none' } }]).map((m) => (
              <option key={m.id} value={m.id}>
                {label(m.label)}
              </option>
            ))}
          </select>
        </div>
        {images.mode !== 'none' ? (
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('shareImagesCount')}</label>
            <input
              type="number"
              min="0"
              max="9"
              value={images.maxPerBundle}
              onChange={(e) => setImages((cur) => ({ ...cur, maxPerBundle: Math.max(0, Math.min(9, Number(e.target.value) || 0)) }))}
              onBlur={() => saveImages({ maxPerBundle: images.maxPerBundle })}
            />
            <div className="muted small">{label(imageCountLabel)}</div>
          </div>
        ) : null}
        <div className="field" style={{ flex: '0 0 auto' }}>
          <button className="ghost" onClick={() => setAdding((v) => !v)}>
            {adding ? t('shareSiteCancel') : t('shareSiteAdd')}
          </button>
        </div>
      </div>

      {adding ? (
        <div className="row">
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('shareSiteId')}</label>
            <input value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))} placeholder={t('shareSitePh')} />
          </div>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('shareSiteName')} (zh)</label>
            <input value={draft.nameZh} onChange={(e) => setDraft((d) => ({ ...d, nameZh: e.target.value }))} />
          </div>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label>{t('shareSiteName')} (en)</label>
            <input value={draft.nameEn} onChange={(e) => setDraft((d) => ({ ...d, nameEn: e.target.value }))} />
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('shareSiteLoginKind')}</label>
            <select value={draft.loginKind} onChange={(e) => setDraft((d) => ({ ...d, loginKind: e.target.value }))}>
              {loginKinds.map((k) => (
                <option key={String(k.id)} value={k.id ?? ''}>
                  {label(k.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="primary" onClick={addSite} disabled={busy === 'addSite' || draft.id.trim().length < 2}>
              {busy === 'addSite' ? t('loading') : t('shareSiteSave')}
            </button>
          </div>
          {/* The detection the form can promise: what this build can look for with that login kind, said
              before the site exists rather than after it fails. */}
          <div className="muted small" style={{ flex: '1 1 100%' }}>
            {t('shareSiteNeeds')}: {currentLoginKind ? label(currentLoginKind.probe?.label) : ''}
          </div>
        </div>
      ) : null}

      <table className="reportlist" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>{t('shareTarget')}</th>
            <th style={{ width: 90 }}>{t('shareLogin')}</th>
            <th style={{ width: 110 }}>{t('shareStatus')}</th>
            <th style={{ width: 240 }}>{t('shareAction')}</th>
          </tr>
        </thead>
        <tbody>
          {fileTargets.map((x) => (
            <tr key={x.id}>
              <td>
                {label(x.name)}
                <div className="muted small">{label(x.hint)}</div>
              </td>
              <td>
                <span className="badge none">{t('no')}</span>
              </td>
              <td className="ok-text">{t('shareReady')}</td>
              <td className="muted small">{label(stagesOf(x).send?.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The posting sites: three separate steps, so three separate columns, and a way forward in each. */}
      {siteTargets.length ? (
        <table className="reportlist" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th style={{ width: 230 }}>{t('shareTarget')}</th>
              <th style={{ width: 200 }}>{t('shareStageAccount')}</th>
              <th style={{ width: 250 }}>{t('shareStageVerify')}</th>
              <th>{t('shareStageSend')}</th>
            </tr>
          </thead>
          <tbody>
            {siteTargets.map((x) => {
              const st = stagesOf(x);
              const r = rowOf(x.id);
              const verified = st.verification?.status === 'done';
              const isManual = manualSite(x) || st.send?.implemented === false;
              return (
                <tr key={x.id}>
                  <td>
                    {label(x.name)}
                    {x.custom ? ' +' : ''}
                    <div className="muted small">{label(x.hint)}</div>
                    {x.site?.credential ? (
                      <div className="muted small">
                        {t('shareLogin')}: {label(x.site.credential)}
                      </div>
                    ) : null}
                    <button className="ghost tiny" onClick={() => setConfigFor(configFor === x.id ? '' : x.id)} style={{ marginTop: 4 }}>
                      {t('shareConfig')}
                    </button>
                  </td>
                  <td className={st.account?.status === 'satisfied' ? 'ok-text' : 'muted small'}>{stageCell(st.account)}</td>
                  <td className={verified ? 'ok-text' : 'muted small'}>
                    {stageCell(st.verification)}
                    {/* Always present, never hidden: when it cannot run it is disabled with the reason in its
                        title, so the cell shows *what* is missing instead of being empty. */}
                    <button
                      className="ghost tiny"
                      title={checkHint(x)}
                      onClick={() => check(x)}
                      disabled={busy === `check:${x.id}` || verified || !st.account?.accountId || (x.site && !x.site.verify)}
                      style={{ marginTop: 4 }}
                    >
                      {busy === `check:${x.id}` ? t('loading') : t('shareCheck')}
                    </button>
                    {r.accounts?.length ? (
                      <select
                        className="small"
                        value={r.accountId ?? ''}
                        onChange={(e) => saveAccount(x, e.target.value)}
                        title={t('shareAccountPick')}
                      >
                        <option value="">{t('shareAccountPick')}</option>
                        {r.accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} {a.usable ? '✓' : '✗'}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {st.account?.requirementRows?.length ? (
                      <ul className="muted small" style={{ paddingLeft: 16, margin: '2px 0 0' }}>
                        {st.account.requirementRows.map((q) => (
                          <li key={q.id}>
                            {q.satisfied === true ? '✓' : q.satisfied === false ? '✗' : q.checkable ? '·' : '?'} {label(q.label)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className={st.send?.status === 'ready' ? 'ok-text' : 'muted small'}>
                    {stageCell(st.send)}
                    {st.send?.actionable ? (
                      <button className="ghost tiny" onClick={() => post(x)} disabled={busy === x.id} style={{ marginTop: 4 }}>
                        {t('sharePost')}
                      </button>
                    ) : null}
                    {isManual ? (
                      <div style={{ marginTop: 4 }}>
                        <div className="muted small">{t('shareManual')}</div>
                        <button className="ghost tiny" onClick={() => openCompose(x)} disabled={busy === `manual:${x.id}`}>
                          {t('shareManualOpen')}
                        </button>{' '}
                        <button className="ghost tiny" onClick={() => copyManual(x)}>
                          {t('shareManualCopy')}
                        </button>{' '}
                        <button
                          className="ghost tiny"
                          onClick={() => download(x.id, (rowOf(x.id).handoff ?? r.prepared)?.images)}
                        >
                          {t('shareManualDownload')}
                        </button>
                        {r.handoff?.fits === false ? <div className="warn-text small">{t('shareManualFull')}</div> : null}
                        {r.handoff?.textLimit ? (
                          <div className="muted small">
                            {t('shareTextLimit').replace('{n}', String(r.handoff.textLimit))}
                            {r.handoff.truncated ? ` · ${r.handoff.droppedLines} ✂` : ''}
                          </div>
                        ) : null}
                        <div className="muted small">
                          {t('shareSiteNeeds')}: {label(r.handoff?.needs ?? x.site?.manual?.needs)}
                        </div>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {/* The per-target configuration panel: the attachment setting for this target, which account it uses,
          and what the site itself declares (read from the profile, not restated here). */}
      {configFor ? (
        (() => {
          const x = targets.find((y) => y.id === configFor);
          if (!x) return null;
          const r = rowOf(x.id);
          const st = stagesOf(x);
          return (
            <div className="panel" style={{ marginTop: 10 }}>
              <h3 className="muted small">{t('shareConfig')} · {label(x.name)}</h3>
              <div className="row">
                <div className="field" style={{ flex: '0 0 220px' }}>
                  <label>{t('shareAccountPick')}</label>
                  <select value={r.accountId ?? ''} onChange={(e) => saveAccount(x, e.target.value)}>
                    <option value="">—</option>
                    {(r.accounts ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} {a.usable ? '✓' : '✗'} {a.unsatisfied?.length ? `(${a.unsatisfied.map((u) => u.id).join(',')})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: '0 0 200px' }}>
                  <label>{t('shareImages')}</label>
                  <select value={images.mode} onChange={(e) => saveImages({ mode: e.target.value })}>
                    {(imageModes.length ? imageModes : [{ id: 'none', label: { zh: 'none', en: 'none' } }]).map((m) => (
                      <option key={m.id} value={m.id}>
                        {label(m.label)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: '0 0 160px' }}>
                  <label>{t('shareImagesCount')}</label>
                  <input
                    type="number"
                    min="0"
                    max={x.site?.maxImages ?? 9}
                    value={images.maxPerBundle}
                    onChange={(e) => setImages((cur) => ({ ...cur, maxPerBundle: Math.max(0, Math.min(60, Number(e.target.value) || 0)) }))}
                    onBlur={() => saveImages({ maxPerBundle: images.maxPerBundle })}
                  />
                </div>
                <div className="field" style={{ flex: '0 0 auto' }}>
                  <button className="ghost" onClick={() => prepare(x)} disabled={busy === `prepare:${x.id}`}>
                    {busy === `prepare:${x.id}` ? t('loading') : t('shareCopy')}
                  </button>
                  {x.custom ? (
                    <button className="ghost" onClick={() => removeSite(x.id)} disabled={busy === `remove:${x.id}`}>
                      {t('shareSiteRemove')}
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="muted small">
                {t('shareLogin')}: {label(x.site?.credential)}
                {x.site?.textLimit ? ` · ${t('shareTextLimit').replace('{n}', String(x.site.textLimit))}` : ''}
                {x.site?.maxImages !== undefined ? ` · 🖼 ≤ ${x.site.maxImages}` : ''}
                {x.site?.publish ? ` · ${x.site.publish}` : ''}
              </div>
              {st.account?.requirementRows?.length ? (
                <ul className="muted small" style={{ paddingLeft: 16 }}>
                  {st.account.requirementRows.map((q) => (
                    <li key={q.id}>
                      {q.satisfied === true ? '✓' : q.satisfied === false ? '✗' : q.checkable ? '·' : '?'} {label(q.label)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {r.prepared?.text ? (
                <pre className="muted small" style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {r.prepared.text}
                </pre>
              ) : null}
              {x.site?.manual?.compose ? (
                <div className="muted small">
                  {t('shareSiteLink')}: {x.site.manual.compose}
                </div>
              ) : null}
            </div>
          );
        })()
      ) : null}

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
                {a.images ? ` · 🖼 ${a.images}` : ''}
                {a.host ? ` · ${a.host}` : ''}
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
