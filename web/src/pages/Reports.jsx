// 报告页：列表 + 查看 / Reports page
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';

export default function Reports() {
  const { t } = useI18n();
  const [list, setList] = useState(null);
  const [cur, setCur] = useState(null);
  const [content, setContent] = useState('');
  const [err, setErr] = useState('');

  const load = () =>
    api
      .getReports()
      .then((r) => setList(r ?? []))
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
  }, []);

  const open = async (name) => {
    setCur(name);
    setContent(t('loading'));
    try {
      setContent(await api.getReport(name));
    } catch (e) {
      setContent(`❌ ${e.message}`);
    }
  };

  return (
    <>
      <section className="panel">
        <h2>{t('reportsTitle')}</h2>
        <div className="hint">{t('reportsHint')}</div>
        <button className="ghost" onClick={load}>
          {t('refresh')}
        </button>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
        {list === null ? (
          <p className="muted">{t('loading')}</p>
        ) : list.length === 0 ? (
          <p className="muted">{t('noReports')}</p>
        ) : (
          <table className="reportlist">
            <thead>
              <tr>
                <th>file</th>
                <th style={{ width: 120 }}>size</th>
                <th style={{ width: 200 }}>modified</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.name}>
                  <td>
                    <button onClick={() => open(r.name)}>{r.name}</button>
                  </td>
                  <td className="muted">{(r.bytes / 1024).toFixed(1)} KB</td>
                  <td className="muted">{new Date(r.mtime).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {cur && (
        <section className="panel">
          <h2>{cur}</h2>
          <pre className="report">{content}</pre>
        </section>
      )}
    </>
  );
}
