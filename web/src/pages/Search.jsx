// Search.jsx - local search
//
// Stance: **search itself needs no LLM and no network**. It is a local index plus
// keyword/tag/time-range matching. The "help me identify people" box in the top left is an
// optional assistant, used only for "I remember the traits but forgot the name"; with no LLM
// configured it simply says it cannot be used.
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { layoutClass, normalizeLayout } from '../layout.js';
import { Inline } from '../markdown.jsx';

const FIELDS = ['any', 'title', 'text', 'tag', 'source', 'url'];
const RANGES = [
  ['all', 0],
  ['7d', 7],
  ['30d', 30],
  ['90d', 90],
  ['365d', 365],
];

function iso(d) {
  return d.toISOString().slice(0, 10);
}

export default function Search({ layout }) {
  const { t, tn, lang, fmtDate } = useI18n();
  const L = normalizeLayout(layout);

  const [q, setQ] = useState('');
  const [field, setField] = useState('any');
  const [tags, setTags] = useState([]);
  const [source, setSource] = useState('');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('relevance');
  const [starred, setStarred] = useState(false);
  const [res, setRes] = useState(null);
  const [cloud, setCloud] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [assistText, setAssistText] = useState('');
  const [assistOut, setAssistOut] = useState(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [entities, setEntities] = useState(null);

  const run = async (override) => {
    setBusy(true);
    try {
      const body = {
        q,
        field,
        tags,
        source,
        category,
        from,
        to,
        sort,
        starred: starred || undefined,
        ...(override ?? {}),
      };
      setRes(await api.search(body));
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api.searchTags().then(setCloud).catch(() => {});
    api.getEntities().then(setEntities).catch(() => {});
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyRange = (key) => {
    const days = RANGES.find(([k]) => k === key)?.[1] ?? 0;
    if (!days) {
      setFrom('');
      setTo('');
      return run({ from: '', to: '' });
    }
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    setFrom(iso(start));
    setTo(iso(end));
    run({ from: iso(start), to: iso(end) });
  };

  const toggleTag = (tag) => {
    const next = tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag];
    setTags(next);
    run({ tags: next });
  };

  const doAssist = async () => {
    setAssistBusy(true);
    try {
      const r = await api.assist(assistText);
      setAssistOut(r);
      if (r.ok && Array.isArray(r.searchTerms) && r.searchTerms.length) {
        setQ(r.searchTerms.join(' '));
        run({ q: r.searchTerms.join(' ') });
      }
    } catch (e) {
      setAssistOut({ ok: false, error: e.message });
    } finally {
      setAssistBusy(false);
    }
  };

  const vocabTags = useMemo(() => (cloud?.vocabulary ?? []).filter((v) => v.aliases?.length), [cloud]);

  return (
    <>
      <section className="panel">
        <h2>{t('searchTitle')}</h2>
        <div className="hint"><Inline text={t('searchHint')} /></div>

        <div className="row">
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label>{t('search')}</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder={t('searchPlaceholder2')}
            />
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('searchField')}</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {t(`field_${f}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px' }}>
            <label>{t('sortBy')}</label>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="relevance">{t('sort_relevance')}</option>
              <option value="time">{t('sort_time')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="primary" onClick={() => run()} disabled={busy}>
              {busy ? t('loading') : t('search')}
            </button>
          </div>
        </div>

        {/* Time range: narrow the scope the way a paper search does */}
        <div className="row">
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('timeRange')}</label>
            <select value="" onChange={(e) => e.target.value && applyRange(e.target.value)}>
              <option value="">{t('range_all')}</option>
              <option value="7d">{t('range_7d')}</option>
              <option value="30d">{t('range_30d')}</option>
              <option value="90d">{t('range_90d')}</option>
              <option value="365d">{t('range_365d')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('from')}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('to')}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{t('onlyStarred')}</label>
            <select value={String(starred)} onChange={(e) => setStarred(e.target.value === 'true')}>
              <option value="false">off</option>
              <option value="true">on</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('sources')}</label>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t('all')}</option>
              {(res?.facets?.sources ?? []).map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('category')}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('all')}</option>
              {(res?.facets?.categories ?? []).map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Selected tags */}
        <div className="row" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted small">{t('tagsInUse')}:</span>
          {tags.length === 0 ? <span className="muted small">{t('noTags')}</span> : null}
          {tags.map((tg) => (
            <button key={tg} className="chip alert" onClick={() => toggleTag(tg)} title={t('clickToRemove')}>
              {tg} ✕
            </button>
          ))}
        </div>

        {/* Tag cloud: the clickable facets you get in a paper search */}
        <div className="tagcloud">
          <div className="muted small" style={{ marginBottom: 4 }}>
            {t('tagCloud')} · {t('vocabHint')}
          </div>
          {vocabTags.map((v) => (
            <button
              key={v.canon}
              className={`chip ${tags.includes(v.canon) ? 'alert' : ''}`}
              onClick={() => toggleTag(v.canon)}
              title={v.aliases.join(' / ')}
            >
              {v.canon}
              {v.count ? ` ${v.count}` : ''}
            </button>
          ))}
          {(cloud?.auto ?? [])
            .filter((x) => !vocabTags.some((v) => v.canon === x.value))
            .slice(0, 40)
            .map((x) => (
              <button key={x.value} className={`chip ${tags.includes(x.value) ? 'alert' : ''}`} onClick={() => toggleTag(x.value)}>
                {x.value} {x.count}
              </button>
            ))}
        </div>

        <div className="hint" style={{ margin: 0 }}>
          {res
            ? `${tn('items', res.total)} · ${res.took}ms · ${t('corpus')}: ${tn('items', res.corpus.items)} / ${res.corpus.runs} runs` +
              (res.outsideTimeRange ? ` · ${tn('outsideRange', res.outsideTimeRange)}` : '')
            : t('loading')}
          {res?.expanded?.length ? (
            <>
              {' '}
              · {t('expandedTo')}: {res.expanded.map((g) => (g.length > 1 ? `[${g.join('/')}]` : g[0])).join(' ')}
            </>
          ) : null}
        </div>
        {err && <p style={{ color: 'var(--err)' }}>❌ {err}</p>}
      </section>

      {/* People profiles: objects aggregated by feature extraction, one click runs a search */}
      {entities?.top?.length > 0 && (
        <section className="panel">
          <h2>
            {t('entitiesTitle')}（{entities.total}）
          </h2>
          <div className="hint">{t('entitiesHint')}</div>
          <div className="row" style={{ gap: 6 }}>
            {entities.top.map((e) => (
              <button
                key={e.key}
                className="chip"
                title={[e.agencies?.map((a) => a.value).join('/'), e.games?.map((g) => g.value).join('/')].filter(Boolean).join(' · ')}
                onClick={() => {
                  setQ(e.name);
                  run({ q: e.name });
                }}
              >
                {e.name} <b>{e.count}</b>
                {e.indie ? t('indieTag') : ''}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Optional assistant: needs an LLM, rarely used */}
      <section className="panel">
        <h2>
          {t('assistTitle')} <span className="badge optional">{t('needsLlm')}</span>
        </h2>
        <div className="hint">{t('assistHint')}</div>
        <div className="row">
          <div className="field">
            <label>{t('assistDescribe')}</label>
            <input
              value={assistText}
              onChange={(e) => setAssistText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && assistText.trim() && doAssist()}
              placeholder={t('assistPlaceholder')}
            />
          </div>
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button className="ghost" onClick={doAssist} disabled={assistBusy || !assistText.trim()}>
              {assistBusy ? t('loading') : t('assistRun')}
            </button>
          </div>
        </div>
        {assistOut && (
          <div className="hint" style={{ margin: 0 }}>
            {!assistOut.ok ? (
              <span className="warn-text">⚠ {assistOut.error}</span>
            ) : (
              <>
                {(assistOut.candidates ?? []).map((c, i) => (
                  <div key={i}>
                    <b>{c.name}</b>
                    {typeof c.confidence === 'number' ? ` (${Math.round(c.confidence * 100)}%)` : ''} — {c.reason}
                  </div>
                ))}
                {assistOut.searchTerms?.length ? (
                  <div style={{ marginTop: 6 }}>
                    {t('assistTerms')}:{' '}
                    {assistOut.searchTerms.map((s) => (
                      <button
                        key={s}
                        className="chip"
                        onClick={() => {
                          setQ(s);
                          run({ q: s });
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
                {assistOut.tags?.length ? (
                  <div style={{ marginTop: 6 }}>
                    {t('assistTags')}:{' '}
                    {assistOut.tags.map((s) => (
                      <button key={s} className="chip" onClick={() => toggleTag(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </section>

      <section className={layoutClass(layout)}>
        {(res?.items ?? []).map((it) => (
          <article className="card" key={`${it.id}-${it.runDate}`}>
            <header>
              {L.showSource && <span className="chip">{it.sourceName?.[lang] ?? it.sourceId}</span>}
              {L.showTime && it.time ? <span className="muted small">{it.time}</span> : null}
              {it.ts ? <span className="muted small">{fmtDate(it.ts)}</span> : null}
              {it.keywords?.length ? <span className="chip alert">⚠ {it.keywords.join('/')}</span> : null}
            </header>
            {it.title ? <h3>{it.title}</h3> : null}
            {it.text ? <p>{it.text}</p> : null}
            {L.showThumbs && it.images?.length ? (
              <div className="thumbs">
                {it.images.slice(0, 6).map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noreferrer noopener">
                    <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" />
                  </a>
                ))}
              </div>
            ) : null}
            {(it.tags ?? []).length ? (
              <div className="row" style={{ gap: 4, alignItems: 'center' }}>
                {it.tags.slice(0, 10).map((tg) => (
                  <button key={tg} className="chip" onClick={() => toggleTag(tg)}>
                    {tg}
                  </button>
                ))}
              </div>
            ) : null}
            <footer>
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer noopener">
                  {t('openSource')} ↗
                </a>
              ) : null}
            </footer>
          </article>
        ))}
      </section>
      {res && res.total === 0 && <p className="muted">{t('noMatches')}</p>}
    </>
  );
}
