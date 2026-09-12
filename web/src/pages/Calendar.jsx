// Calendar.jsx — 纪念日 / 生日 / 3D披露 / 周年 倒计时
//
// 时间算术全部在服务端（server/src/calendar.js，有独立自检），
// 界面只负责呈现与录入 —— 闰日顺延、时区、夏令时这些不该在渲染层重算一遍。
//
// 两个细节特意做了：
//   1) 一周起始日跟着地区走：美国/日本/韩国/港台是周日，中国/欧洲/俄是周一。
//      直接吃上一轮建的 locale 信息（useI18n().weekdays 已经按 weekStart 轮转过）。
//   2) 「从情报里找线索」是**本地正则**抽取，不联网不用 LLM；
//      而且只给建议、不自动落库 —— 猜测不能污染日历。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Collapsible from '../Collapsible.jsx';

const KIND_ICON = { birthday: '🎂', debut: '🎉', '3d': '🧊', anniversary: '🎊', event: '📌', other: '·' };

const blankForm = { name: '', kind: 'birthday', date: '', since: '', note: '', remindDaysBefore: 3 };
const blankGridForm = { name: '', kind: 'event', date: '', since: '', note: '', remindDaysBefore: 3 };

export default function Calendar() {
  const { t, weekdays, weekdaysSunFirst, fmtDateTime } = useI18n();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ ...blankForm });
  const [gridForm, setGridForm] = useState({ ...blankGridForm });
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [sug, setSug] = useState(null);
  const [picked, setPicked] = useState({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.getCalendar({ days: 400, month, year, weekStart: weekdays.length === 7 ? 1 : 1 });
      setData(r);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [month, year, weekdays.length]);

  useEffect(() => {
    load();
  }, [load]);

  const due = data?.due ?? [];
  const all = data?.all ?? [];
  const grid = data?.grid;

  // 月历表头：按地区的一周起始日轮转
  const header = useMemo(() => {
    const start = data?.grid?.weekStart ?? 1;
    return weekdaysSunFirst.slice(start).concat(weekdaysSunFirst.slice(0, start));
  }, [data, weekdaysSunFirst]);

  const save = async () => {
    setBusy('add');
    try {
      await api.addCalendarEntry({ ...form, since: form.since ? Number(form.since) : null });
      setForm({ ...blankForm });
      setMsg(t('calAdded'));
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const addFromGrid = async () => {
    setBusy('grid');
    try {
      await api.addCalendarEntry({ ...gridForm, since: gridForm.since ? Number(gridForm.since) : null });
      setGridForm({ ...blankGridForm });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id) => {
    setBusy(id);
    try {
      await api.deleteCalendarEntry(id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const detect = async () => {
    setBusy('detect');
    try {
      const r = await api.detectCalendar();
      setSug(r);
      setPicked({});
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const importPicked = async () => {
    const entries = (sug?.suggestions ?? [])
      .filter((s, i) => picked[i])
      .map((s) => ({ name: s.evidence.slice(0, 60), kind: s.kind, date: s.date, sourceId: s.sourceId, note: s.evidence, url: s.url }));
    if (!entries.length) return;
    setBusy('import');
    try {
      const r = await api.importCalendar(entries);
      setMsg(`${t('calImported')}: ${r.added}`);
      setSug(null);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const prevMonth = () => {
    const m = month === 1 ? 12 : month - 1;
    setMonth(m);
    if (m === 12) setYear((y) => y - 1);
  };
  const nextMonth = () => {
    const m = month === 12 ? 1 : month + 1;
    setMonth(m);
    if (m === 1) setYear((y) => y + 1);
  };

  // 天数必须进句子，不能拼在后面：「天后」这种后缀式标签在别的语言里位置不一样
  // （pt「daqui a 3 dias」/ ru「через 3 дня」/ ar「بعد 3 أيام」都在前面），
  // 而且「天后」单独看还有歧义 —— 模型把它当成「歌后」，翻出了 Diva / Королева。
  // 所以源串写成带占位符的整句（{n} 会被管线保护起来，模型不能动它）。
  const when = (d) =>
    d === 0 ? t('calToday') : d === 1 ? t('calTomorrow') : t('calDaysLater').replace('{n}', String(d));

  return (
    <>
      {err && (
        <section className="panel">
          <div className="hint warn-text">{err}</div>
        </section>
      )}

      <section className="panel">
        <h2>
          {t('tab_calendar')}
          <span className="muted small" style={{ marginLeft: 12 }}>
            {t('calToday')}: {data?.today ?? '—'} · {data?.timeZone ?? ''}
          </span>
        </h2>
        <div className="hint">{t('calHint')}</div>

        {due.length === 0 ? (
          <p className="muted">{t('calEmpty')}</p>
        ) : (
          <table className="cal-list">
            <tbody>
              {due.slice(0, 40).map((e) => (
                <tr key={e.id} className={e.days <= (e.remindDaysBefore ?? 3) ? 'best' : ''}>
                  <td style={{ width: 34 }}>{KIND_ICON[e.kind] ?? '·'}</td>
                  <td style={{ width: 96 }}>
                    <b>{when(e.days)}</b>
                  </td>
                  <td>
                    {e.name}
                    {e.turns ? <span className="muted small">（{t('calYearN')} {e.turns}）</span> : null}
                    {e.leapAdjusted ? <span className="badge optional">⚠ {t('calLeap')}</span> : null}
                    {e.note ? <div className="muted small">{e.note.slice(0, 110)}</div> : null}
                  </td>
                  <td className="muted small" style={{ width: 110 }}>
                    {e.day}
                  </td>
                  <td style={{ width: 70 }}>
                    <button className="ghost tiny" onClick={() => remove(e.id)} disabled={busy === e.id}>
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="muted small" style={{ marginTop: 6 }}>
          {t('calTotal')}: {all.length} · {t('calRemindWindow')}: {due.filter((e) => e.days <= (e.remindDaysBefore ?? 3)).length}
        </div>
      </section>

      <section className="panel">
        <div className="row" style={{ alignItems: 'center' }}>
          <button className="ghost tiny" onClick={prevMonth}>
            ◀
          </button>
          <b style={{ minWidth: 120, textAlign: 'center' }}>
            {year}-{String(month).padStart(2, '0')}
          </b>
          <button className="ghost tiny" onClick={nextMonth}>
            ▶
          </button>
          <span className="muted small">
            {t('calWeekStart')}: {weekdaysSunFirst[data?.grid?.weekStart ?? 1]}
          </span>
        </div>
        <div className="cal-grid">
          {header.map((d, i) => (
            <div key={'h' + i} className="cal-dow">
              {d}
            </div>
          ))}
          {(grid?.cells ?? []).map((c) => (
            <div key={c.day} className={'cal-cell' + (c.inMonth ? '' : ' out') + (c.day === data?.today ? ' today' : '')}>
              <span className="cal-daynum">{c.dayOfMonth}</span>
              <span className="cal-marks">
                {(c.marks ?? []).map((m) => (
                  <span key={m.id} title={`${m.name}`}>
                    {KIND_ICON[m.kind] ?? '·'}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <Collapsible id="cal-add" title={t('calAddTitle')} summary={t('calAddSummary')}>
          <div className="row">
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label>{t('name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('calNamePh')} />
            </div>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label>{t('calKind')}</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {['birthday', 'debut', '3d', 'anniversary', 'event', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {KIND_ICON[k]} {t('calKind_' + k)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label>{t('date')}</label>
              <input value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} placeholder="MM-DD / YYYY-MM-DD" />
            </div>
            <div className="field" style={{ flex: '0 0 110px' }}>
              <label>{t('calSince')}</label>
              <input value={form.since} onChange={(e) => setForm({ ...form, since: e.target.value })} placeholder="2021" />
            </div>
            <div className="field" style={{ flex: '0 0 130px' }}>
              <label>{t('calRemind')}</label>
              <input
                type="number"
                min="0"
                max="60"
                value={form.remindDaysBefore}
                onChange={(e) => setForm({ ...form, remindDaysBefore: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('calNote')}</label>
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <button className="primary" onClick={save} disabled={busy === 'add' || !form.name || !form.date}>
              {t('add')}
            </button>
          </div>
        </Collapsible>

        <Collapsible id="cal-detect" title={t('calDetectTitle')} summary={t('calDetectSummary')}>
          <div className="row">
            <button className="ghost" onClick={detect} disabled={busy === 'detect'}>
              {busy === 'detect' ? t('loading') : t('calDetectRun')}
            </button>
            {sug ? (
              <span className="muted small">
                {t('calDetectScanned')}: {sug.scanned} · {t('calDetectFound')}: {sug.suggestions.length}
              </span>
            ) : null}
            {sug && sug.suggestions.length ? (
              <button className="primary" onClick={importPicked} disabled={busy === 'import' || !Object.values(picked).some(Boolean)}>
                {t('calImport')}
              </button>
            ) : null}
          </div>
          {sug && sug.suggestions.length === 0 ? <p className="muted small">{t('calDetectNone')}</p> : null}
          {(sug?.suggestions ?? []).map((s, i) => (
            <label key={i} className="sug-row">
              <input type="checkbox" checked={!!picked[i]} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />
              <span>
                {KIND_ICON[s.kind]} <b>{s.date}</b> — {s.evidence}
              </span>
              {s.alreadyAdded ? <span className="badge none">{t('calAlready')}</span> : null}
            </label>
          ))}
        </Collapsible>

        <div className="hint">{t('calGridAddHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label>{t('name')}</label>
            <input value={gridForm.name} onChange={(e) => setGridForm({ ...gridForm, name: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 0 170px' }}>
            <label>{t('date')}</label>
            <input value={gridForm.date} onChange={(e) => setGridForm({ ...gridForm, date: e.target.value })} placeholder="YYYY-MM-DD" />
          </div>
          <button className="ghost" onClick={addFromGrid} disabled={busy === 'grid' || !gridForm.name || !gridForm.date}>
            {t('add')}
          </button>
        </div>
      </section>

      {msg && <div className="toast ok">{msg}</div>}
      {data?.today ? <div className="muted small" style={{ marginTop: 8 }}>{fmtDateTime(Date.now())}</div> : null}
    </>
  );
}
