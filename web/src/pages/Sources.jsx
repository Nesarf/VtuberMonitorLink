// 来源页：勾选站点 + 登录要求 + 自定义来源 / Sources page
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

const BLANK = {
  id: '',
  name: '',
  category: 'community',
  fetch: 'rss',
  url: '',
  uid: '',
  login: 'none',
  cadence: 'daily',
  proxy: '',
};

export default function Sources() {
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [customOnly, setCustomOnly] = useState(false);

  const load = () =>
    api
      .getSources()
      .then(setData)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const list = data?.sources ?? [];
    return customOnly ? list.filter((s) => s.custom) : list;
  }, [data, customOnly]);

  if (err && !data) return <div className="panel">❌ {err}</div>;
  if (!data) return <div className="panel">{t('loading')}</div>;

  const patch = async (id, patchBody) => {
    try {
      await api.patchSource(id, patchBody);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const addCustom = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.addCustomSource(form);
      setForm({ ...BLANK });
      setMsg(t('sourceAdded'));
      setTimeout(() => setMsg(''), 2000);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (id) => {
    setBusy(true);
    try {
      await api.deleteCustomSource(id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const byCat = {};
  for (const s of filtered) (byCat[s.category] ??= []).push(s);

  const needsUid = form.fetch === 'bili-opus' || form.fetch === 'bili-dynamic';

  return (
    <>
      <section className="panel">
        <h2>{t('sourcesTitle')}</h2>
        <div className="hint">{t('sourcesHint')}</div>
        <p className="muted">
          {data.sources.length} sources · daily <b>{data.selected.daily}</b> · merch <b>{data.selected.merch}</b>
          <label className="inline-check" style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} />{' '}
            {t('onlyCustom')}
          </label>
        </p>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
        {msg && <div className="hint" style={{ margin: 0 }}>{msg}</div>}

        {Object.entries(byCat).map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 22 }}>
            <h3 style={{ fontSize: 13, color: 'var(--muted)', margin: '14px 0 6px' }}>
              {data.categories?.[cat]?.[lang] ?? cat}
            </h3>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 60 }}>{t('enabledCol')}</th>
                  <th>ID</th>
                  <th style={{ width: 110 }}>{t('fetchKind')}</th>
                  <th style={{ width: 150 }}>{t('login')}</th>
                  <th>URL / 备注</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) => patch(s.id, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <div>{s.name?.[lang] ?? s.id}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {s.id}
                        {s.custom ? <span className="badge custom"> {t('custom')}</span> : null}
                      </div>
                    </td>
                    <td>
                      <span className="badge">{s.fetch}</span>
                    </td>
                    <td>
                      <select value={s.login} onChange={(e) => patch(s.id, { login: e.target.value })}>
                        <option value="none">{t('login_none')}</option>
                        <option value="optional">{t('login_optional')}</option>
                        <option value="required">{t('login_required')}</option>
                      </select>
                      <div style={{ marginTop: 4 }}>
                        <span className={`badge ${s.login}`}>
                          {s.login === 'required'
                            ? t('login_required')
                            : s.login === 'optional'
                              ? t('login_optional')
                              : t('login_none')}
                        </span>
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      <div className="row" style={{ gap: 6 }}>
                        {needsUidOf(s) ? (
                          <input
                            className="tiny-input"
                            defaultValue={s.uid ?? ''}
                            title="UID"
                            onBlur={(e) => e.target.value !== s.uid && patch(s.id, { uid: e.target.value.trim() })}
                          />
                        ) : null}
                        <input
                          className="wide-input"
                          defaultValue={s.url ?? ''}
                          title={t('sourceUrl')}
                          onBlur={(e) => e.target.value !== s.url && patch(s.id, { url: e.target.value.trim() })}
                          placeholder="(search-only)"
                        />
                      </div>
                      {s.note && <div style={{ marginTop: 2 }}>※ {s.note[lang] ?? s.note.en}</div>}
                    </td>
                    <td>
                      {s.custom ? (
                        <button className="ghost tiny danger" onClick={() => removeCustom(s.id)} disabled={busy}>
                          {t('deleteSource')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

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
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="某某的博客" />
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
            <label>{t('proxyMode')}</label>
            <select value={form.proxy} onChange={(e) => setForm({ ...form, proxy: e.target.value })}>
              <option value="">{t('proxyInherit')}</option>
              <option value="direct">{t('proxyDirect')}</option>
              <option value="proxy">{t('proxyUse')}</option>
            </select>
          </div>
        </div>
        <button className="primary" onClick={addCustom} disabled={busy || !form.id || (!form.url && !form.uid)}>
          {t('addCustomSource')}
        </button>
      </section>
    </>
  );
}

function needsUidOf(s) {
  return s.fetch === 'bili-opus' || s.fetch === 'bili-dynamic';
}
