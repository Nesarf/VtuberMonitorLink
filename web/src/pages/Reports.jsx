// 报告页：列表 + 渲染视图 + 全文检索 + 导出 / Reports page
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Markdown from '../markdown.jsx';

export default function Reports() {
  const { t } = useI18n();
  const [list, setList] = useState(null);
  const [cur, setCur] = useState(null);
  const [content, setContent] = useState('');
  const [raw, setRaw] = useState(false);
  const [err, setErr] = useState('');
  const [kw, setKw] = useState([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);

  const load = () =>
    api
      .getReports()
      .then((r) => setList(r ?? []))
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    api
      .getWatch()
      .then((w) => setKw(w.rules?.keywords ?? []))
      .catch(() => {});
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

  const doSearch = async () => {
    if (!q.trim()) return setHits(null);
    try {
      const r = await api.searchReports(q);
      setHits(r.hits ?? []);
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <section className="panel">
        <h2>{t('reportsTitle')}</h2>
        <div className="hint">{t('reportsHint')}</div>
        <div className="row">
          <div className="field">
            <label>{t('searchReports')}</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              placeholder={t('searchPlaceholder')}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={doSearch}>
              {t('search')}
            </button>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={load}>
              {t('refresh')}
            </button>
          </div>
        </div>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}

        {hits && (
          <div className="search-hits">
            {hits.length === 0 ? (
              <p className="muted">{t('noMatches')}</p>
            ) : (
              hits.map((h) => (
                <details key={h.name}>
                  <summary>
                    <button className="link" onClick={() => open(h.name)}>
                      {h.name}
                    </button>{' '}
                    <span className="muted small">
                      {h.count} {t('matches')}
                    </span>
                  </summary>
                  <ul className="muted small">
                    {h.matches.map((m, i) => (
                      <li key={i}>
                        <span className="muted">L{m.line}</span> {m.text}
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
          </div>
        )}

        {list === null ? (
          <p className="muted">{t('loading')}</p>
        ) : list.length === 0 ? (
          <p className="muted">{t('noReports')}</p>
        ) : (
          <table className="reportlist">
            <thead>
              <tr>
                <th>file</th>
                <th style={{ width: 100 }}>size</th>
                <th style={{ width: 180 }}>modified</th>
                <th style={{ width: 200 }}>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.name}>
                  <td>
                    <button className="link" onClick={() => open(r.name)}>
                      {r.name}
                    </button>
                  </td>
                  <td className="muted">{(r.bytes / 1024).toFixed(1)} KB</td>
                  <td className="muted">{new Date(r.mtime).toLocaleString()}</td>
                  <td>
                    <a className="ghost tiny" href={api.exportUrl(r.name, 'html')}>
                      {t('exportHtml')}
                    </a>{' '}
                    <a className="ghost tiny" href={api.exportUrl(r.name, 'json')}>
                      {t('exportJson')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {cur && (
        <section className="panel">
          <h2>
            {cur}
            <button className="ghost tiny" style={{ marginLeft: 12 }} onClick={() => setRaw((v) => !v)}>
              {raw ? t('rendered') : t('rawMarkdown')}
            </button>
          </h2>
          {raw ? (
            <pre className="report">{content}</pre>
          ) : (
            <Markdown text={content} className="report-md" highlight={kw} />
          )}
        </section>
      )}
    </>
  );
}
