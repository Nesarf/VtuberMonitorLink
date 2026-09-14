// Llm.jsx — standalone LLM + API key page / standalone LLM + API key page
//
// Why it was pulled onto its own page: it used to be buried inside "Settings", and **those inputs did not render at
// all while the profile list was empty** (they were wrapped in `{active && ...}`), with the result that "you want to
// fill in a key and cannot find anywhere to put it".
// Now: (1) a standalone top-level entry, findable at a glance; (2) an explicit "create one" button when there is no
// profile, no longer a dead end; (3) it spells out which features need it and which do not.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { SaveBar, useSaveState } from '../savebar.jsx';
import Collapsible from '../Collapsible.jsx';
import { api } from '../api.js';

/** Which features need the LLM -- answers "do I have to configure it" directly */
const NEEDS = [
  ['report', true],
  ['features', true],
  ['assist', true],
  ['search', false],
  ['live', false],
  ['danmaku', false],
  ['probe', false],
];

export default function Llm() {
  const { t, tn, fmtTime } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [presets, setPresets] = useState([]);
  const [msg, setMsg] = useState('');
  const [msgKind, setMsgKind] = useState('');
  const st = useSaveState();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [newPreset, setNewPreset] = useState('deepseek');
  const [testResult, setTestResult] = useState(null);
  const [cost, setCost] = useState(null);

  const load = async () => {
    try {
      const c = await api.getConfig();
      setCfg(c);
      const p = await api.getLlm();
      setPresets(p.presets ?? []);
      // Usage comes from another data source (it reads logs/cost.jsonl); a failure does not affect this page
      setCost(await api.cost(14).catch(() => null));
    } catch (e) {
      setMsg(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!cfg) return <div className="panel">{t('loading')}</div>;

  const providers = cfg.llm?.providers ?? [];
  const activeId = cfg.llm?.activeId ?? providers[0]?.id ?? '';
  const active = providers.find((p) => p.id === activeId) ?? providers[0] ?? null;

  const flash = (m, ms = 2500, kind = '') => {
    setMsg(m);
    setMsgKind(kind);
    if (ms) setTimeout(() => setMsg(''), ms);
  };

  const patchLlm = (patch) => {
    st.dirty();
    setCfg((c) => ({ ...c, llm: { ...c.llm, ...patch } }));
  };

  /** The usage budget also hangs under llm (llm.budget.*) and goes through the same save state */
  const patchBudget = (field, value) => patchLlm({ budget: { ...(cfg.llm?.budget ?? {}), [field]: value } });

  const patchProvider = (field, value) => {
    if (!active) return;
    st.dirty();
    setCfg((c) => {
      const next = structuredClone(c);
      const list = next.llm.providers ?? [];
      const i = list.findIndex((p) => p.id === active.id);
      if (i < 0) return next;
      list[i][field] = value;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    st.saving();
    try {
      const next = await api.putConfig(cfg);
      setCfg(next);
      st.saved();
      flash(`${t('saved')} · ${fmtTime(Date.now())}`, 4000, 'ok');
    } catch (e) {
      st.failed(e.message);
      flash(e.message, 0, 'err');
    } finally {
      setBusy(false);
    }
  };

  /** Add a profile: save the current edits first, then let the server derive one from a preset */
  const addProfile = async (presetId) => {
    setBusy(true);
    try {
      await api.putConfig(cfg);
      const r = await api.newLlmProvider(presetId ?? newPreset, {});
      const c = await api.getConfig();
      setCfg(c);
      flash(`${t('llmAddProfile')}: ${r.provider?.name} · ${r.provider?.model ?? ''}`);
    } catch (e) {
      flash(e.message, 0);
    } finally {
      setBusy(false);
    }
  };

  const deleteProfile = async () => {
    if (!active) return;
    setBusy(true);
    try {
      const next = structuredClone(cfg);
      next.llm.providers = (next.llm.providers ?? []).filter((p) => p.id !== active.id);
      next.llm.activeId = next.llm.providers[0]?.id ?? '';
      const saved = await api.putConfig(next);
      setCfg(saved);
      setTestResult(null);
      flash(t('saved'));
    } catch (e) {
      flash(e.message, 0);
    } finally {
      setBusy(false);
    }
  };

  const testLlm = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const saved = await api.putConfig(cfg);
      setCfg(saved);
      const r = await api.testLlmProvider(active);
      setTestResult(r);
      flash(r.ok ? `✅ ${t('testLlm')}: OK · ${r.provider?.model ?? ''}` : `❌ ${r.error}`, 0);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api.putConfig(cfg);
      const r = await api.listLlmModels(active);
      if (r.ok) {
        patchProvider('models', r.models);
        flash(`${t('llmModelsFetched')}: ${r.models.length}`);
      } else {
        flash(`❌ ${r.error}`, 0);
      }
    } catch (e) {
      flash(`❌ ${e.message}`, 0);
    } finally {
      setBusy(false);
    }
  };

  const hasKey = !!(active?.apiKey ?? '').trim();
  const preset = presets.find((p) => p.id === active?.preset);

  return (
    <>
      <section className="panel">
        <h2>{t('llmTitle')}</h2>
        <div className="hint">{t('llmHint')}</div>

        {/* With no profile, offer a clear path instead of a blank area */}
        {providers.length === 0 ? (
          <div className="problems" style={{ marginBottom: 12 }}>
            <b>⚠ {t('llmNeedKey')}</b>
            <div style={{ marginTop: 6 }}>{t('llmEmptyHint')}</div>
            <div className="row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
              <select value={newPreset} onChange={(e) => setNewPreset(e.target.value)} style={{ maxWidth: 260 }}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={() => addProfile(newPreset)} disabled={busy}>
                {t('llmCreateFirst')}
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <div className="field" style={{ flex: '0 0 280px' }}>
              <label>{t('llmActive')}</label>
              <select value={activeId} onChange={(e) => patchLlm({ activeId: e.target.value })}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model || '?'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 220px' }}>
              <label>{t('llmAddProfile')}</label>
              <div className="row" style={{ gap: 6 }}>
                <select value={newPreset} onChange={(e) => setNewPreset(e.target.value)} style={{ flex: 1 }}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="ghost tiny" onClick={() => addProfile(newPreset)} disabled={busy}>
                  +
                </button>
              </div>
            </div>
            <div className="field" style={{ flex: 0 }}>
              <span className={hasKey ? 'badge none' : 'badge required'}>{hasKey ? t('llmKeySet') : t('llmKeyMissing')}</span>
            </div>
          </div>
        )}
      </section>

      {/* ── cost board / cost board ──
          This tool's money is spent on the LLM, and before this the UI showed no usage at all (usage was fetched
          but nobody aggregated it).
          Only report what can be seen: calls whose usage is unavailable are counted separately, no guessing at numbers. */}
      <section className="panel">
        <h2>{t('costTitle')}</h2>
        <div className="hint">{t('costHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 240px' }}>
            <label>{t('costToday')}</label>
            <div>
              <b>{cost?.today?.tokens ?? 0}</b> tokens · {tn('costCalls', cost?.today?.calls ?? 0)}
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 240px' }}>
            <label>{t('costTotal')}</label>
            <div>
              <b>{cost?.total?.tokens ?? 0}</b> tokens · {tn('costCalls', cost?.total?.calls ?? 0)}
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('costBudget')}</label>
            <input
              type="number"
              min="0"
              step="10000"
              value={cfg.llm?.budget?.dailyTokens ?? 0}
              onChange={(e) => patchBudget('dailyTokens', Number(e.target.value) || 0)}
            />
            <div className="small muted">{Number(cfg.llm?.budget?.dailyTokens ?? 0) ? '' : t('costUnlimited')}</div>
          </div>
          <div className="field" style={{ flex: '0 0 200px' }}>
            <label>{t('costOnExceed')}</label>
            <select value={cfg.llm?.budget?.onExceed ?? 'warn'} onChange={(e) => patchBudget('onExceed', e.target.value)}>
              <option value="warn">{t('costExceedWarn')}</option>
              <option value="stop">{t('costExceedStop')}</option>
            </select>
          </div>
        </div>
        {cost?.budget?.limit ? (
          <div className={`small ${cost.budget.exceeded ? 'delta-down' : 'muted'}`}>
            {cost.budget.exceeded ? '⚠ ' : ''}
            {cost.budget.used}/{cost.budget.limit} tokens（{Math.round((cost.budget.pct ?? 0) * 100)}%）·
            {cost.budget.remaining !== null ? ` ${t('costRemaining')} ${cost.budget.remaining}` : ''}
          </div>
        ) : null}
        {cost?.unknown ? <div className="small muted">{tn('costUnknown', cost.unknown)}</div> : null}
        {(cost?.models ?? []).length ? (
          <div className="small muted" style={{ marginTop: 6 }}>
            {cost.models.slice(0, 4).map((m) => `${m.key}: ${m.tokens}`).join(' · ')}
          </div>
        ) : null}
      </section>

      {active && (
        <section className="panel">
          <h2>
            {t('llmProfileFields')} <span className="muted small">· {active.name}</span>
          </h2>

          <div className="row">
            <div className="field">
              <label>{t('baseUrl')}</label>
              <input value={active.baseUrl ?? ''} onChange={(e) => patchProvider('baseUrl', e.target.value)} placeholder="https://api.deepseek.com" />
            </div>
            <div className="field">
              <label>{t('apiKey')}</label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={active.apiKey ?? ''}
                  onChange={(e) => patchProvider('apiKey', e.target.value)}
                  placeholder="sk-..."
                  style={{ flex: 1 }}
                />
                <button className="ghost tiny" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? t('hideKey') : t('showKey')}
                </button>
              </div>
              <div className="hint" style={{ margin: 0 }}>{t('llmKeyLocalOnly')}</div>
            </div>
          </div>

          <div className="row">
            <div className="field">
              <label>{t('model')}</label>
              <input list="vml-models" value={active.model ?? ''} onChange={(e) => patchProvider('model', e.target.value)} />
              <datalist id="vml-models">
                {[...new Set([...(active.models ?? []), ...((preset?.models ?? []) || [])])].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {/vision/i.test(active.model ?? '') ? <div className="hint" style={{ margin: 0 }}>{t('llmVisionHint')}</div> : null}
            </div>
            <div className="field" style={{ flex: '0 0 160px' }}>
              <label>{t('reasoningEffort')}</label>
              <select value={active.reasoningEffort ?? ''} onChange={(e) => patchProvider('reasoningEffort', e.target.value)}>
                <option value="">-</option>
                {['low', 'medium', 'high'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label>{t('maxTokens')}</label>
              <input type="number" value={active.maxTokens ?? 8192} onChange={(e) => patchProvider('maxTokens', Number(e.target.value))} />
            </div>
          </div>

          <div className="row">
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="ghost" onClick={testLlm} disabled={busy}>
                {busy ? t('testing') : t('testLlm')}
              </button>
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="ghost" onClick={fetchModels} disabled={busy}>
                {t('llmFetchModels')}
              </button>
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <button className="ghost danger" onClick={deleteProfile} disabled={busy || providers.length <= 1}>
                {t('llmDeleteProfile')}
              </button>
            </div>
            {testResult && (
              <div className="field" style={{ flex: 1 }}>
                <span className={testResult.ok ? 'hint ok-text' : 'hint warn-text'} style={{ margin: 0 }}>
                  {testResult.ok ? `✅ ${t('testLlm')}: OK · ${testResult.provider?.model ?? ''}` : `❌ ${testResult.error}`}
                </span>
              </div>
            )}
          </div>

          <div className="hint" style={{ marginBottom: 0 }}>{t('llmSaveHint')}</div>
        </section>
      )}

      {/* "do I have to configure it" -- listed outright, so nobody has to guess. Collapsed by default:
          it is a "look once and you are done" reference table, not worth permanently taking half the screen. */}
      <section className="panel">
        <h2>{t('llmNeedsTitle')}</h2>
        <div className="hint">{t('llmNeedsHint')}</div>
        <Collapsible
          id="llm-needs"
          title={t('llmNeedsTable')}
          count={NEEDS.length}
          summary={t('llmNeedsSummary')}
        >
          <table>
          <thead>
            <tr>
              <th>{t('llmFeature')}</th>
              <th style={{ width: 140 }}>{t('llmNeedsLlmCol')}</th>
            </tr>
          </thead>
          <tbody>
            {NEEDS.map(([key, needs]) => (
              <tr key={key}>
                <td>{t(`llmFeat_${key}`)}</td>
                <td>
                  <span className={needs ? 'badge optional' : 'badge none'}>{needs ? t('yes') : t('no')}</span>
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </Collapsible>
      </section>

      <SaveBar st={st} onSave={save} busy={busy} />
      {msg && <div className={'toast ' + msgKind}>{msg}</div>}
    </>
  );
}
