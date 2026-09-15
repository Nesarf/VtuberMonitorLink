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
import LoginCheckButton, { LoginActionLink, countKey, loginCheckMessage, textCounter } from '../LoginCheck.jsx';

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
  // Per target: the server's prepared body (`prepared`), the person's edit for that site (`draftText`, null
  // while untouched), the account list, the last hand-off and the last login check.
  //
  // The draft lives in React state and is deliberately **not persisted**: a draft is a decision in progress,
  // and writing it to config.json would mean a config write per keystroke -- the exact pattern the region box
  // on the sources page commits on blur to avoid (each write rewrites the file and reloads the list). The
  // session keeps it, the box says which text is the app's and which is the person's, and the reset button
  // puts the prepared text back, so a stale draft can never quietly pass itself off as freshly prepared.
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

  /**
   * The text this site would carry **right now**: the person's edit when there is one, otherwise the body the
   * server prepared. `null` means "nothing decided here", which is what lets the server (the single owner of
   * that rule, resolveSiteBody in server/src/share.js) decide between the two.
   */
  const bodyOf = (target) => {
    const r = rowOf(target.id);
    return r.draftText !== undefined && r.draftText !== null ? r.draftText : null;
  };
  /** The box's contents: the draft, or the prepared body as its starting point */
  const shownBody = (target) => {
    const r = rowOf(target.id);
    return r.draftText !== undefined && r.draftText !== null ? r.draftText : r.text ?? '';
  };
  /** An edit is a keystroke-level thing: state only, never a config write (see the note on `row`). Named
   *  `setEdit` because `setDraft` is already the add-a-site form's state setter on this page. */
  const setEdit = (target, value) => setRowOf(target.id, { draftText: value });
  /** The explicit way back: forget the edit so the app's prepared body is what is carried again */
  const resetDraft = (target) => setRowOf(target.id, { draftText: null });

  /** Build the body a per-site action should carry: the edit when there is one, the server's own otherwise */
  const bodyPayload = (target) => {
    const b = bodyOf(target);
    return b === null ? {} : { text: b };
  };

  const download = async (targetId = null, override = null, text = null) => {
    setBusy(targetId ? `download:${targetId}` : 'download');
    try {
      const used = override ?? { mode: images.mode, maxPerBundle: images.maxPerBundle };
      // A per-target download is the file version of the hand-off, so it carries **the edited body** when
      // there is one: the person is about to paste this into a site, and the file must hold their words.
      const res = await fetch('/api/share/bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: scope(),
          format: targetId ? 'text' : format,
          note,
          images: used,
          ...(text === null || text === undefined ? {} : { text }),
        }),
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
   * The verification step of one site — the measurement the **send** stage depends on.
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
      const prepared = await api.sharePrepare({ target: target.id, scope: scope(), text: bodyOf(target) });
      setRowOf(target.id, { ...(prepared ?? {}), accountId: rowOf(target.id).accountId ?? prepared.accountId ?? '' });
      if (r.ok) setMsg(label(r.detail) || t('shareReady'));
      else setErr(label(r.detail) || r.reason || r.error || 'failed');
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * The login state of one site, measured on demand.
   *
   * Separate from `check` above on purpose: that one is the send-stage verification and only exists for sites
   * whose publishing has a probe, while **every** site that needs a login can answer "am I signed in there?"
   * -- the site's own probe where there is one, and otherwise the read-only cookie probe for the site's own
   * host. It is the same measurement the login state is configured with, so it works on the sites this build
   * cannot post to at all (X is the example), which is exactly where a person is about to paste by hand.
   */
  const checkLogin = async (target) => {
    const r = await api.shareCheckLogin({ target: target.id, account: rowOf(target.id).accountId });
    setRowOf(target.id, { loginState: { ...r, message: loginCheckMessage(r, t, tn) } });
    // A fresh read of the account list is what makes the chooser show an account that was just signed in.
    if (target.site?.accountDiscovery) {
      api.sharePrepare({ target: target.id, scope: scope(), text: bodyOf(target) })
        .then((p) => setRowOf(target.id, { ...(p ?? {}), accountId: rowOf(target.id).accountId ?? p?.accountId ?? '' }))
        .catch(() => {});
    }
    return r;
  };

  /** Prepare the body for one site (cut to that site's own limit) and the accounts that could carry it */
  const prepare = async (target) => {
    setBusy(`prepare:${target.id}`);
    setErr('');
    try {
      const r = await api.sharePrepare({ target: target.id, scope: scope(), text: bodyOf(target) });
      setRowOf(target.id, { ...(r ?? {}), accountId: rowOf(target.id).accountId ?? r?.accountId ?? '' });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  /**
   * The hand-off for a site this build cannot post to: text and links only, and the server audits it as manual.
   *
   * The body sent is the **edited** one when there is one, and the server decides the same way for the
   * compose link: `composeUrl` comes back only when the text that would actually be pasted fits, so a draft
   * grown past the site's limit loses the link rather than getting a truncated compose box.
   */
  const handoff = async (target, { record = false } = {}) => {
    setBusy(`manual:${target.id}`);
    setErr('');
    try {
      const h = await api.shareHandoff({
        target: target.id,
        scope: scope(),
        accountId: rowOf(target.id).accountId,
        handoff: record,
        ...bodyPayload(target),
      });
      setRowOf(target.id, { handoff: h, accounts: h.accounts ?? [] });
      return h;
    } catch (e) {
      setErr(e.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  /**
   * Open the site's compose page.
   *
   * The hand-off is recomputed before opening rather than reused: it is measured against the text as it is
   * now, so a link can never be opened for a body that has since grown past the limit.
   */
  const openCompose = async (target) => {
    const h = await handoff(target, { record: true });
    setRowOf(target.id, { handoff: h });
    if (!h?.composeUrl) {
      setErr(h?.composeNote ? label(h.composeNote) : t('shareManualFull'));
      return;
    }
    window.open(h.composeUrl, '_blank', 'noopener,noreferrer');
  };

  /** Copy the body **as it is now** (the edit when there is one): what is on the clipboard must be what the box shows */
  const copyManual = async (target) => {
    const h = await handoff(target, { record: true });
    setRowOf(target.id, { handoff: h });
    if (!h?.text) return;
    try {
      await navigator.clipboard.writeText(h.text);
      setMsg(t('shareCopied'));
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  /**
   * Copy the body of **any** target (a hand-off is only available for the sites this build cannot post to, so
   * the copy action cannot go through it for the rest).
   *
   * For an edited body the box already holds exactly the text to copy. For an untouched one the server's
   * prepared text is the thing to copy -- and if it has not been prepared yet in this session, it is asked for
   * rather than copied from a stale render.
   */
  const copyBody = async (target) => {
    const edited = bodyOf(target);
    let text = edited;
    if (text === null) {
      const r = rowOf(target.id);
      text = r.preparedText ?? null;
      if (text === null) {
        try {
          const p = await api.sharePrepare({ target: target.id, scope: scope() });
          setRowOf(target.id, { ...(p ?? {}), accountId: r.accountId ?? p?.accountId ?? '' });
          text = p?.preparedText ?? p?.text ?? '';
        } catch (e) {
          setErr(e.message);
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(text ?? '');
      setMsg(t('shareCopied'));
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
        // The body that is actually sent is the one in the box: a person who edited the text for this site and
        // then pressed send must not have the app's prepared text published under their name instead.
        ...bodyPayload(target),
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
                  <td className={st.account?.status === 'satisfied' ? 'ok-text' : 'muted small'}>
                    {stageCell(st.account)}
                    {/* What a login state **is** for this site, and whether this app can look one up at all.
                        "which account to use" is the chooser below when one can be discovered; for a kind
                        nothing discovers, the cell says so instead of showing an empty chooser that reads
                        like "you have no login" (server/src/accounts.js discovers bilibili logins only). */}
                    <div className="muted small">
                      {t('shareLogin')}: {x.loginKind ?? '—'}
                      {x.site?.host ? ` · ${x.site.host}` : x.loginKind ? ` · ${t('loginNoHost')}` : ''}
                    </div>
                    {x.loginKind && x.site?.accountDiscovery === false ? <div className="muted small">{t('loginNoDiscovery')}</div> : null}
                    {/* The login state itself, measured on demand and always pressable: the site's own probe
                        where one exists (bilibili's login-probe, Mastodon's token-scope), otherwise the
                        read-only cookie probe for the site's own host. It stays available on the sites this
                        build cannot post to -- the login stage is independent of the send stage, and that is
                        exactly where someone is about to paste by hand. */}
                    <LoginCheckButton
                      onCheck={() => checkLogin(x)}
                      disabledReason={!x.site?.host && !x.site?.verify ? t('loginNoHost') : !x.loginKind ? t('loginNotCheckable') : ''}
                      onResult={() => {}}
                    />
                    {r.loginState?.message ? (
                      <div className={r.loginState.message.ok ? 'ok-text small' : 'warn-text small'}>
                        {r.loginState.message.text}
                        {/* When the check came back "no profile dir is configured", the way to the page that
                            fills it in is right here. That absence is the whole reason the browser page exists:
                            the answer used to be the cookie reader's internal string and nothing to press. */}
                        <LoginActionLink action={r.loginState.message.action} />
                      </div>
                    ) : null}
                    {/* Which account this site would use -- the configuration half of "configure and check the
                        login state", available for every target including the ones whose publishing is
                        unsupported. */}
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
                  <td className={verified ? 'ok-text' : 'muted small'}>
                    {stageCell(st.verification)}
                    {/* The send-stage verification. Unlike the login check above, this one needs the site's own
                        probe: with no probe and no account there is nothing to measure here, and the button
                        says so in its title rather than being absent. The login state is checked next door. */}
                    <button
                      className="ghost tiny"
                      title={checkHint(x)}
                      onClick={() => check(x)}
                      disabled={busy === `check:${x.id}` || verified || !x.site?.verify || !st.account?.accountId}
                      style={{ marginTop: 4 }}
                    >
                      {busy === `check:${x.id}` ? t('loading') : t('shareCheck')}
                    </button>
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
                        <button className="ghost tiny" onClick={() => copyManual(x)} disabled={busy === `manual:${x.id}`}>
                          {t('shareManualCopy')}
                        </button>{' '}
                        <button
                          className="ghost tiny"
                          onClick={() => download(x.id, (rowOf(x.id).handoff ?? r).images, bodyOf(x))}
                          disabled={busy === `download:${x.id}`}
                        >
                          {t('shareManualDownload')}
                        </button>
                        {/* A hand-off is exactly when "am I signed in there?" matters: somebody is about to
                            paste into that site by hand. So the check sits here as well, next to the buttons
                            that use it -- and a site whose sending code does not exist is precisely one of
                            these. */}
                        <div style={{ marginTop: 4 }}>
                          <LoginCheckButton
                            onCheck={() => checkLogin(x)}
                            disabledReason={!x.site?.host && !x.site?.verify ? t('loginNoHost') : !x.loginKind ? t('loginNotCheckable') : ''}
                            onResult={() => {}}
                          />
                          {r.loginState?.message ? (
                            <div className={r.loginState.message.ok ? 'ok-text small' : 'warn-text small'}>
                              {r.loginState.message.text}
                              <LoginActionLink action={r.loginState.message.action} />
                            </div>
                          ) : null}
                        </div>
                        {r.handoff?.composeUrl === null && r.handoff?.textSource === 'edited' && !r.handoff?.fits ? (
                          <div className="warn-text small">{label(r.handoff.composeNote)}</div>
                        ) : r.handoff?.fits === false ? (
                          <div className="warn-text small">{t('shareManualFull')}</div>
                        ) : null}
                        {x.site?.textLimit ? (
                          <div className="muted small">
                            {t('shareTextLimit').replace('{n}', String(x.site.textLimit))}
                            {r.handoff?.truncated ? ` · ${r.handoff.droppedLines} ✂` : ''}
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
          const counter = textCounter(shownBody(x), x.site?.textLimit);
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
                  {/* Copy is offered once, in the body block below: it copies whatever the box currently holds. */}
                </div>
              </div>
              {/* The body this site would carry, editable **here** -- independently per site, because each site
                  has its own limit and its own audience. It is seeded with what the app prepared (cut to this
                  site's limit) and the moment it is touched it becomes the person's own text: everything
                  downstream reads it (copy, the compose link, the hand-off, the file, and posting where it is
                  implemented), and the label above the box says which of the two it currently is.

                  Why a textarea per target rather than one shared box: the limits differ by an order of
                  magnitude (X takes 280 characters, Reddit 40000), so one shared body would be wrong for at
                  least one site at all times. Why it is not saved on every keystroke: a patch writes
                  config.json and reloads the list, so a keystroke would be a config write (the same reason the
                  region box on the sources page commits on blur). */}
              <div className="field">
                <label>{t('shareManual')}</label>
                <textarea
                  rows={5}
                  value={shownBody(x)}
                  onChange={(e) => setEdit(x, e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
                />
                <div className="muted small">
                  {r.draftText !== undefined && r.draftText !== null ? t('shareTextEdited') : t('shareTextPrepared')}
                  {' · '}
                  {/* A bare used/limit pair needs no dictionary entry (the requirement says so); the sentence
                      that names which limit it is reuses shareTextLimit, which already carries {n}. */}
                  <span key={countKey(counter.used, counter.limit ?? 0)} className={counter.over ? 'warn-text' : 'muted'}>
                    {counter.used}/{counter.limit ?? '∞'}
                  </span>
                  {x.site?.textLimit ? ` · ${t('shareTextLimit').replace('{n}', String(x.site.textLimit))}` : ''}
                </div>
                <div className="row" style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
                  <button className="ghost tiny" onClick={() => resetDraft(x)} disabled={r.draftText === undefined || r.draftText === null}>
                    {t('shareTextPrepared')}
                  </button>
                  <button className="ghost tiny" onClick={() => prepare(x)} disabled={busy === `prepare:${x.id}`}>
                    {busy === `prepare:${x.id}` ? t('loading') : t('shareTextPrepare')}
                  </button>
                  <button className="ghost tiny" onClick={() => copyBody(x)}>
                    {t('shareCopy')}
                  </button>
                  <LoginCheckButton
                    onCheck={() => checkLogin(x)}
                    disabledReason={!x.site?.host && !x.site?.verify ? t('loginNoHost') : !x.loginKind ? t('loginNotCheckable') : ''}
                    onResult={() => {}}
                  />
                </div>
                {r.loginState?.message ? (
                  <div className={r.loginState.message.ok ? 'ok-text small' : 'warn-text small'}>{r.loginState.message.text}</div>
                ) : null}
                {/* The app's own prepared text, kept visible and labelled as the app's: the edited box must never
                    be the only place the report text exists, or "reset" would have nothing to reset to. */}
                {r.preparedText ? (
                  <details>
                    <summary className="muted small">{t('shareTextPrepared')}</summary>
                    <pre className="muted small" style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {r.preparedText}
                    </pre>
                  </details>
                ) : null}
              </div>
              <div className="muted small">
                {t('shareLogin')}: {label(x.site?.credential)}
                {x.site?.host ? ` · ${x.site.host}` : ''}
                {x.site?.textLimit ? ` · ${t('shareTextLimit').replace('{n}', String(x.site.textLimit))}` : ''}
                {x.site?.maxImages !== undefined ? ` · 🖼 ≤ ${x.site.maxImages}` : ''}
                {x.site?.publish ? ` · ${x.site.publish}` : ''}
              </div>
              {x.loginKind && x.site?.accountDiscovery === false ? <div className="muted small">{t('loginNoDiscovery')}</div> : null}
              {st.account?.requirementRows?.length ? (
                <ul className="muted small" style={{ paddingLeft: 16 }}>
                  {st.account.requirementRows.map((q) => (
                    <li key={q.id}>
                      {q.satisfied === true ? '✓' : q.satisfied === false ? '✗' : q.checkable ? '·' : '?'} {label(q.label)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="row" style={{ alignItems: 'center' }}>
                {manualSite(x) ? (
                  <>
                    <button className="ghost tiny" onClick={() => openCompose(x)} disabled={busy === `manual:${x.id}`}>
                      {t('shareManualOpen')}
                    </button>
                    <button className="ghost tiny" onClick={() => copyManual(x)} disabled={busy === `manual:${x.id}`}>
                      {t('shareManualCopy')}
                    </button>
                    <button className="ghost tiny" onClick={() => download(x.id, (r.handoff ?? r).images, bodyOf(x))} disabled={busy === `download:${x.id}`}>
                      {t('shareManualDownload')}
                    </button>
                  </>
                ) : null}
                {x.custom ? (
                  <button className="ghost" onClick={() => removeSite(x.id)} disabled={busy === `remove:${x.id}`}>
                    {t('shareSiteRemove')}
                  </button>
                ) : null}
              </div>
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
