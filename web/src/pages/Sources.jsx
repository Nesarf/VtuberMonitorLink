// 来源页：勾选站点 + 设置登录要求 / Sources page
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

export default function Sources() {
  const { t, lang } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = () =>
    api
      .getSources()
      .then(setData)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  if (err) return <div className="panel">❌ {err}</div>;
  if (!data) return <div className="panel">{t('loading')}</div>;

  const patch = async (id, field, value) => {
    try {
      const r = await api.patchSource(id, { [field]: value });
      setData((d) => ({ ...d, sources: r.sources, selected: { ...d.selected } }));
      const fresh = await api.getSources();
      setData(fresh);
    } catch (e) {
      setErr(e.message);
    }
  };

  const byCat = {};
  for (const s of data.sources) (byCat[s.category] ??= []).push(s);

  return (
    <section className="panel">
      <h2>{t('sourcesTitle')}</h2>
      <div className="hint">{t('sourcesHint')}</div>
      <p className="muted">
        {data.sources.length} sources · daily <b>{data.selected.daily}</b> · merch <b>{data.selected.merch}</b>
      </p>

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
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => patch(s.id, 'enabled', e.target.checked)}
                    />
                  </td>
                  <td>
                    <div>{s.name?.[lang] ?? s.id}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s.id}
                    </div>
                  </td>
                  <td>
                    <span className="badge">{s.fetch}</span>
                  </td>
                  <td>
                    <select value={s.login} onChange={(e) => patch(s.id, 'login', e.target.value)}>
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
                    {s.url ? (
                      <div style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.url}
                      </div>
                    ) : (
                      <em>search-only</em>
                    )}
                    {s.note && <div style={{ marginTop: 2 }}>※ {s.note[lang] ?? s.note.en}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
