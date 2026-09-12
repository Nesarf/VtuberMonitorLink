// Reports page: list + rendered view + full-text search + export
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Markdown from '../markdown.jsx';
import Charts from './Charts.jsx';
import Share from './Share.jsx';

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
  const [cmp, setCmp] = useState(null);
  const [cmpTo, setCmpTo] = useState('');
  // The share scope has to allow picking by person, so the watch list is needed
  const [people, setPeople] = useState([]);

  const compare = async (from, to) => {
    setCmpTo(to);
    if (!to) return setCmp(null);
    try {
      setCmp({ from, to, ...(await api.diffReports(from, to)) });
    } catch (e) {
      setErr(e.message);
    }
  };

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
    api
      .getPeople()
      .then((r) => setPeople(r.people ?? []))
      .catch(() => {});
  }, []);

  const open = async (name) => {
    setCur(name);
    setContent(t('loading'));
    try {
      const raw = await api.getReport(name);
      // .json source files hold the markdown source, so pull it out and show it with the in-app renderer;
      // .html reports are previewed directly in an iframe (the same file you would open in VSCode).
      if (/\.json$/i.test(name)) {
        try {
          const j = JSON.parse(raw);
          const md = Array.isArray(j.runs) ? j.runs.map((r) => r.markdown).join('\n\n---\n\n') : (j.markdown ?? raw);
          setContent(md);
        } catch {
          setContent(raw);
        }
      } else {
        setContent(raw);
      }
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
      <Charts />
      <Share people={people} />
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
                <th style={{ width: 150 }}>{t('compare')}</th>
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
                    </a>{' '}
                    <a className="ghost tiny" href={api.exportUrl(r.name, 'docx')}>
                      {t('exportDocxReport')}
                    </a>
                  </td>
                  <td style={{ width: 150 }}>
                    {cur === r.name || !list ? null : (
                      <select value="" onChange={(e) => e.target.value && compare(r.name, e.target.value)}>
                        <option value="">{t('compare')}…</option>
                        {list
                          .filter((x) => x.name !== r.name)
                          .slice(0, 12)
                          .map((x) => (
                            <option key={x.name} value={x.name}>
                              {x.name}
                            </option>
                          ))}
                      </select>
                    )}
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
          {/\.html$/i.test(cur) ? (
            // The daily intelligence report is by default such a self-styled .html: the rendered view
            // previews it as-is, and the raw toggle switches to the source, so both routes work.
            raw ? (
              <pre className="report">{content}</pre>
            ) : (
              <iframe
                title={cur}
                className="report-frame"
                sandbox=""
                src={`/api/reports/${encodeURIComponent(cur)}`}
              />
            )
          ) : raw || /\.adoc$/i.test(cur) ? (
            <pre className="report">{content}</pre>
          ) : (
            <Markdown text={content} className="report-md" highlight={kw} />
          )}
        </section>
      )}

      {cmp && (
        <section className="panel">
          <h2>
            {t('compare')}: {cmp.from} → {cmp.to}
            <button className="ghost tiny" style={{ marginLeft: 12 }} onClick={() => compare('', '')}>
              {t('close')}
            </button>
          </h2>
          <div className="hint" style={{ marginBottom: 8 }}>
            <span className="chip delta-up">+{cmp.stats?.added ?? 0}</span>
            <span className="chip delta-down">-{cmp.stats?.removed ?? 0}</span>
          </div>
          <pre className="diff">
            {(cmp.hunks ?? []).slice(0, 300).map((l, i) => (
              <div key={i} className={`diff-line op-${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '@' ? 'ctx' : 'same'}`}>
                {l.op === '@' ? '' : l.op + ' '}
                {l.text}
              </div>
            ))}
          </pre>
        </section>
      )}
    </>
  );
}
