// Charts.jsx — trend charts (pure inline SVG, no charting library pulled in)
//
// A portable exe should not carry a few hundred KB of dependencies just to draw some bars; and these charts are simple:
// bars (items per day), horizontal bars (share per source), lines (keyword / followed-person trends), a table (source health).
//
// One deliberate design choice: **no fake empty chart when there is no data** — it shows "no archive data yet" and tells the user
// how to produce some (run a run, or click backfill). Drawing a zero line on an empty chart is a lie.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Collapsible from '../Collapsible.jsx';

function BarChart({ data, height = 90, label }) {
  if (!data?.length) return null;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="chart">
      <div className="chart-title">{label}</div>
      <svg viewBox={`0 0 ${data.length * 12} ${height}`} preserveAspectRatio="none" className="chart-svg" role="img" aria-label={label}>
        {data.map((d, i) => {
          const h = Math.round((d.value / max) * (height - 18));
          return (
            <g key={d.key ?? i}>
              <rect x={i * 12 + 1} y={height - 16 - h} width={10} height={Math.max(d.value ? 2 : 0, h)} rx={2} className="chart-bar" />
              <title>{`${d.key}: ${d.value}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="chart-axis muted small">
        <span>{data[0]?.key}</span>
        <span>
          {label} · max {max}
        </span>
        <span>{data.at(-1)?.key}</span>
      </div>
    </div>
  );
}

function HBars({ rows, label, formatter }) {
  if (!rows?.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="chart">
      <div className="chart-title">{label}</div>
      {rows.map((r) => (
        <div key={r.key} className="hbar-row">
          <span className="hbar-label" title={r.key}>
            {r.key}
          </span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${Math.round((r.value / max) * 100)}%` }} />
          </span>
          <span className="muted small">{formatter ? formatter(r) : r.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Charts() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [stat, setStat] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = async (d = days) => {
    setBusy('load');
    try {
      const [s, a] = await Promise.all([api.archiveSeries(d), api.archiveStats()]);
      setStat(a);
      setData(s);
      setErr('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backfill = async () => {
    setBusy('ingest');
    try {
      await api.archiveIngest(500);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const empty = !stat?.items;

  return (
    <section className="panel">
      <h2>
        {t('chartsTitle')}
        <span className="muted small" style={{ marginLeft: 12 }}>
          {t('chartsArchive')}: {stat?.items ?? 0} {t('peopleItems')} · {stat?.days ?? 0} {t('chartsDays')} · {stat?.sources ?? 0}{' '}
          {t('sources')}
          {stat?.firstDay ? ` · ${stat.firstDay} → ${stat.lastDay}` : ''}
        </span>
      </h2>
      <div className="hint">{t('chartsHint')}</div>

      {err && <div className="hint warn-text">{err}</div>}

      <div className="row">
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label>{t('chartsRange')}</label>
          <select
            value={days}
            onChange={(e) => {
              const d = Number(e.target.value);
              setDays(d);
              load(d);
            }}
          >
            {[7, 30, 90, 180].map((d) => (
              <option key={d} value={d}>
                {d} {t('chartsDays')}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <button className="ghost" onClick={() => load()} disabled={busy === 'load'}>
            {busy === 'load' ? t('loading') : t('refresh')}
          </button>{' '}
          <button className="ghost" onClick={backfill} disabled={busy === 'ingest'}>
            {busy === 'ingest' ? t('loading') : t('chartsBackfill')}
          </button>
        </div>
      </div>

      {empty ? (
        <p className="muted">{t('chartsEmpty')}</p>
      ) : (
        <>
          <Collapsible id="chart-daily" title={t('chartsDaily')} summary={t('chartsDailyHint')} defaultOpen>
            <BarChart
              data={(data?.daily?.days ?? []).map((d) => ({ key: d.day.slice(5), value: d.items }))}
              label={t('chartsDaily')}
            />
          </Collapsible>

          <Collapsible id="chart-sources" title={t('chartsSources')} summary={t('chartsSourcesHint')}>
            <HBars
              rows={(data?.bySource?.totals ?? []).slice(0, 12).map((r) => ({ key: r.sourceId, value: r.items }))}
              label={t('chartsSources')}
            />
            <BarChart
              data={(data?.daily?.days ?? []).map((d) => ({ key: d.day.slice(5), value: d.alerts }))}
              label={t('chartsAlerts')}
            />
          </Collapsible>

          <Collapsible id="chart-people" title={t('chartsPeople')} summary={t('chartsPeopleHint')}>
            {(data?.people?.totals ?? []).length === 0 ? (
              <p className="muted small">{t('chartsNoPeople')}</p>
            ) : (
              <HBars
                rows={(data?.people?.totals ?? []).slice(0, 12).map((r) => ({ key: r.personId, value: r.items }))}
                label={t('chartsPeople')}
              />
            )}
          </Collapsible>

          <Collapsible id="chart-keywords" title={t('chartsKeywords')} summary={t('chartsKeywordsHint')}>
            {(data?.keywords?.keywords ?? []).length === 0 ? (
              <p className="muted small">{t('chartsNoKeywords')}</p>
            ) : (
              <HBars rows={(data?.keywords?.keywords ?? []).map((k) => ({ key: k.keyword, value: k.total }))} label={t('chartsKeywords')} />
            )}
          </Collapsible>

          <Collapsible id="chart-health" title={t('chartsHealth')} summary={t('chartsHealthHint')}>
            <table className="reportlist">
              <thead>
                <tr>
                  <th>{t('sources')}</th>
                  <th style={{ width: 90 }}>{t('chartsChecks')}</th>
                  <th style={{ width: 90 }}>{t('chartsRate')}</th>
                  <th style={{ width: 100 }}>{t('latency')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.health?.sources ?? []).map((s) => (
                  <tr key={s.sourceId}>
                    <td>{s.sourceId}</td>
                    <td className="muted small">{s.checks}</td>
                    <td className={s.rate !== null && s.rate < 0.8 ? 'delta-down' : 'ok-text'}>
                      {s.rate === null ? '—' : `${Math.round(s.rate * 100)}%`}
                    </td>
                    <td className="muted small">{s.avgMs === null ? '—' : `${s.avgMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Collapsible>
        </>
      )}
    </section>
  );
}
