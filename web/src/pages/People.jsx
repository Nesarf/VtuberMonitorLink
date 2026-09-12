// People.jsx — 按「人」关注 / follow people rather than sources
//
// 界面要回答的三个问题，按重要性排序：
//   1) 我关注的人今天有动静吗（→ 顶部按「最近出现」排序的名单 + 条数）
//   2) 凭什么说这条是他的（→ 每条都显示命中的别名与字段，匹配永远可解释）
//   3) 怎么把人加进来最省事（→ 名字 + 账号；再从已有实体统计里一键导入）
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import Collapsible from '../Collapsible.jsx';

const BLANK = {
  id: '',
  name: '',
  enName: '',
  agency: '',
  aliases: '',
  tags: '',
  notes: '',
  notifyLevel: 'alert',
  bilibili: '',
  twitter: '',
  youtube: '',
  twitch: '',
};
const LEVELS = ['info', 'alert', 'urgent'];

export default function People() {
  const { t, fmtDateTime } = useI18n();
  const [data, setData] = useState(null);
  const [feed, setFeed] = useState(null);
  const [open, setOpen] = useState('');
  const [form, setForm] = useState({ ...BLANK });
  const [sug, setSug] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [gv, setGv] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getPeople();
      setData(r);
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
    // 箱视角单独取（它读归档，跟关注对象列表不是一个数据源）
    try {
      setGv(await api.groups(30));
    } catch (e) {
      setGv({ ok: false, groups: [], people: 0, error: e.message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openFeed = async (id) => {
    if (open === id) return setOpen('');
    setBusy(id);
    try {
      const r = await api.peopleFeed(id);
      setFeed({ id, rows: r.feed?.[0]?.items ?? [] });
      setOpen(id);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const add = async () => {
    setBusy('add');
    try {
      const links = {};
      for (const k of ['bilibili', 'twitter', 'youtube', 'twitch']) if (form[k].trim()) links[k] = form[k].trim();
      await api.addPerson({
        id: form.id.trim() || undefined,
        name: form.name,
        enName: form.enName,
        agency: form.agency,
        aliases: form.aliases.split(/[,，\s]+/).filter(Boolean),
        tags: form.tags.split(/[,，\s]+/).filter(Boolean),
        notes: form.notes,
        notifyLevel: form.notifyLevel,
        links,
      });
      setForm({ ...BLANK });
      setMsg(t('peopleAdded'));
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
      await api.deletePerson(id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const suggest = async () => {
    setBusy('sug');
    try {
      setSug(await api.suggestPeople(2));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const importSuggestion = async (name) => {
    try {
      await api.addPerson({ name, aliases: [] });
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const people = data?.people ?? [];
  const linked = (p) =>
    ['bilibili', 'twitter', 'youtube', 'twitch']
      .filter((k) => p.links?.[k])
      .map((k) => `${k}:${p.links[k]}`)
      .join(' · ');

  return (
    <>
      {err && (
        <section className="panel">
          <div className="hint warn-text">{err}</div>
        </section>
      )}

      {/* ── 箱视角 / group view ──
          逐条情报流回答不了「这个箱现在怎么样」。这里按 agency 聚成一块：
          每日热力图（谁在动、谁停了）、同刻出现（企划/联动）、共同沉默（整箱安静）、
          以及每个人相对**自己**节奏的异常。 */}
      <section className="panel">
        <h2>
          {t('groupViewTitle')}
          <span className="muted small" style={{ marginLeft: 12 }}>
            {t('groupWindow')}: {gv?.days ?? 30} {t('groupDays')}
          </span>
        </h2>
        <div className="hint">{t('groupViewHint')}</div>
        {gv && gv.groups.length === 0 && (
          <p className="muted">
            {t('groupNoAgency')} —— {gv.people} {t('groupPeopleCount')}
          </p>
        )}
        {(gv?.groups ?? []).map((g) => (
          <div key={g.agency} className="group-card">
            <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
              <b style={{ fontSize: 15 }}>{g.agency}</b>
              <span className="muted small">
                {g.totals.members} {t('groupMembers')} · {t('groupActive7')} {g.activeLast7}/{g.totals.members} · {t('items')} {g.totals.items}
              </span>
              {g.groupSignal && (
                <span className={`chip ${g.groupSignal.level === 'high' ? 'alert' : 'optional'}`}>{g.groupSignal.reason}</span>
              )}
            </div>
            {/* 热力图：一行一个人，一格一天（越深的格子条目越多） */}
            <div className="heat">
              {g.members.map((m) => (
                <div key={m.id} className="heat-row">
                  <span className="heat-name" title={`${m.name}${m.quietDays !== null ? ` · ${t('groupQuiet')} ${m.quietDays} ${t('groupDays')}` : ''}`}>
                    {m.level === 'high' ? '🔴' : m.level === 'warn' ? '🟡' : m.level === 'unknown' ? '⚪' : '🟢'} {m.name}
                  </span>
                  <span className="heat-cells">
                    {m.counts.map((n, i) => (
                      <i
                        key={i}
                        className={n > 0 ? 'heat-on' : 'heat-off'}
                        style={n > 0 ? { opacity: Math.min(1, 0.35 + n * 0.25) } : undefined}
                        title={`${gv.axis[i]} · ${n} ${t('items')}`}
                      />
                    ))}
                  </span>
                  <span className="muted small" style={{ minWidth: 120 }}>
                    {m.lastDay ? `${t('groupLast')} ${m.lastDay}` : t('groupNever')}
                    {m.toleranceDays ? ` · ${t('groupTolerance')} ${m.toleranceDays}${t('groupDays')}` : ''}
                  </span>
                </div>
              ))}
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>
              {t('groupCoActive')}: {g.coActiveDays}
              {g.coActive.length
                ? `（${g.coActive.map((c) => `${c.day.slice(5)} ${c.count}${t('groupPeopleUnit')}`).join(' / ')}）`
                : ''}
              {g.quietStreak ? ` · ${t('groupQuietStreak')} ${g.quietStreak} ${t('groupDays')}` : ''}
              {g.fullHouseDays ? ` · ${t('groupFullHouse')} ${g.fullHouseDays} ${t('groupDays')}` : ''}
            </div>
          </div>
        ))}
        {gv?.ungrouped && gv.ungrouped.totals.members > 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            {t('groupUngrouped')}: {gv.ungrouped.totals.members} {t('groupPeopleCount')}（{t('groupUngroupedHint')}）
          </div>
        )}
      </section>

      <section className="panel">
        <h2>
          {t('tab_people')}
          <span className="muted small" style={{ marginLeft: 12 }}>
            {t('peopleScanned')}: {data?.scanned ?? 0} · {t('peopleMatched')}: {data?.matched ?? 0}
          </span>
        </h2>
        <div className="hint">{t('peopleHint')}</div>

        {people.length === 0 ? (
          <p className="muted">{t('peopleEmpty')}</p>
        ) : (
          <table className="people-list">
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td style={{ width: 26 }}>
                    <button className="ghost tiny" onClick={() => openFeed(p.id)} disabled={busy === p.id} title={t('peopleShowFeed')}>
                      {open === p.id ? '▾' : '▸'}
                    </button>
                  </td>
                  <td>
                    <b>{p.name}</b>
                    {p.enName ? <span className="muted small"> / {p.enName}</span> : null}
                    {p.agency ? <span className="badge none">{p.agency}</span> : null}
                    {p.notifyLevel === 'urgent' ? <span className="badge optional">{t('peopleUrgent')}</span> : null}
                    {p.aliases?.length ? <div className="muted small">{t('peopleAliases')}: {p.aliases.join('、')}</div> : null}
                    {linked(p) ? <div className="muted small">{linked(p)}</div> : null}
                  </td>
                  <td style={{ width: 90 }} className={p.stats?.count ? 'ok-text' : 'muted small'}>
                    {p.stats?.count ?? 0} {t('peopleItems')}
                  </td>
                  <td style={{ width: 170 }} className="muted small">
                    {p.stats?.lastAt ? fmtDateTime(p.stats.lastAt) : '—'}
                  </td>
                  <td style={{ width: 70 }}>
                    <button className="ghost tiny danger" onClick={() => remove(p.id)} disabled={busy === p.id}>
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {open && feed ? (
          <div className="people-feed">
            {feed.rows.length === 0 ? (
              <p className="muted small">{t('peopleNoItems')}</p>
            ) : (
              feed.rows.map((it, i) => (
                <div key={it.id ?? i} className="people-feed-row">
                  <div>{it.title ?? String(it.text ?? '').slice(0, 120)}</div>
                  <div className="muted small">
                    {/* 匹配必须可解释：写清是哪个别名、在哪个字段命中的 */}
                    {t('peopleWhy')}: {(it.peopleHits ?? []).map((h) => `${h.alias}@${h.field}`).join('、')}
                    {it.url ? (
                      <>
                        {' · '}
                        <a href={it.url} target="_blank" rel="noreferrer noopener">
                          {t('open')}
                        </a>
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>

      <section className="panel">
        <Collapsible id="people-add" title={t('peopleAddTitle')} summary={t('peopleAddSummary')}>
          <div className="row">
            <div className="field" style={{ flex: '1 1 160px' }}>
              <label>{t('name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('peopleNamePh')} />
            </div>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label>{t('peopleEnName')}</label>
              <input value={form.enName} onChange={(e) => setForm({ ...form, enName: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label>{t('peopleAgency')}</label>
              <input value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} placeholder="A-SOUL / にじさんじ" />
            </div>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label>{t('peopleNotifyLevel')}</label>
              <select value={form.notifyLevel} onChange={(e) => setForm({ ...form, notifyLevel: e.target.value })}>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{t('peopleAliases')}</label>
              <input
                value={form.aliases}
                onChange={(e) => setForm({ ...form, aliases: e.target.value })}
                placeholder={t('peopleAliasesPh')}
              />
            </div>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label>bilibili uid</label>
              <input value={form.bilibili} onChange={(e) => setForm({ ...form, bilibili: e.target.value })} placeholder="672328094" />
            </div>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label>X / Twitter</label>
              <input value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} placeholder="@handle" />
            </div>
            <div className="field" style={{ flex: '0 0 170px' }}>
              <label>YouTube / Twitch</label>
              <div className="row" style={{ gap: 6 }}>
                <input value={form.youtube} onChange={(e) => setForm({ ...form, youtube: e.target.value })} placeholder="channel" />
                <input value={form.twitch} onChange={(e) => setForm({ ...form, twitch: e.target.value })} placeholder="login" />
              </div>
            </div>
            <button className="primary" onClick={add} disabled={busy === 'add' || !form.name.trim()}>
              {t('add')}
            </button>
          </div>
        </Collapsible>

        <Collapsible id="people-suggest" title={t('peopleSuggestTitle')} summary={t('peopleSuggestSummary')}>
          <div className="row">
            <button className="ghost" onClick={suggest} disabled={busy === 'sug'}>
              {busy === 'sug' ? t('loading') : t('peopleSuggestRun')}
            </button>
            {sug ? <span className="muted small">{t('peopleSuggestFrom')}: {sug.scanned}</span> : null}
          </div>
          {(sug?.suggestions ?? []).length === 0 && sug ? <p className="muted small">{t('peopleSuggestNone')}</p> : null}
          {(sug?.suggestions ?? []).map((s) => (
            <div key={s.name} className="sug-row">
              <span style={{ flex: 1 }}>
                <b>{s.name}</b> <span className="muted small">× {s.count}</span>
              </span>
              <button className="ghost tiny" onClick={() => importSuggestion(s.name)}>
                {t('add')}
              </button>
            </div>
          ))}
        </Collapsible>
      </section>

      {msg && <div className="toast ok">{msg}</div>}
    </>
  );
}
