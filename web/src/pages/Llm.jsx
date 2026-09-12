// Llm.jsx — LLM 与 API Key 的独立分区 / standalone LLM + API key page
//
// 为什么单独拉一页：之前它埋在「设置」里，而且**档位为空时那几个输入框根本不渲染**
// （包在 `{active && ...}` 里），结果就是「想填 Key 却找不到地方填」。
// 现在：① 独立顶层入口，一眼能找到；② 没有档位时给一个明确的「建一个」按钮，
// 不再是死路；③ 明确写出哪些功能需要它、哪些不需要。
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { SaveBar, useSaveState } from '../savebar.jsx';
import Collapsible from '../Collapsible.jsx';
import { api } from '../api.js';

/** 哪些功能需要 LLM —— 直接回答「我必须配吗」 */
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
  const { t } = useI18n();
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
      // 用量是另一个数据源（读 logs/cost.jsonl），失败不影响这一页
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

  /** 用量预算也挂在 llm 下（llm.budget.*），走同一套保存状态 */
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
      flash(`${t('saved')} · ${new Date().toLocaleTimeString()}`, 4000, 'ok');
    } catch (e) {
      st.failed(e.message);
      flash(e.message, 0, 'err');
    } finally {
      setBusy(false);
    }
  };

  /** 新增档位：先保存当前编辑，再让服务端从预设派生一个 */
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

        {/* 没档位时给一条明确的路，而不是一片空白 */}
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

      {/* ── 用量与预算 / cost board ──
          这个工具的钱花在 LLM 上，而在此之前界面上看不到任何用量（usage 取回来了但没人聚合）。
          只报能看到的：拿不到用量的一次单独计数，不猜数字。 */}
      <section className="panel">
        <h2>{t('costTitle')}</h2>
        <div className="hint">{t('costHint')}</div>
        <div className="row">
          <div className="field" style={{ flex: '0 0 240px' }}>
            <label>{t('costToday')}</label>
            <div>
              <b>{cost?.today?.tokens ?? 0}</b> tokens · {cost?.today?.calls ?? 0} {t('costCalls')}
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 240px' }}>
            <label>{t('costTotal')}</label>
            <div>
              <b>{cost?.total?.tokens ?? 0}</b> tokens · {cost?.total?.calls ?? 0} {t('costCalls')}
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
        {cost?.unknown ? <div className="small muted">{cost.unknown} {t('costUnknown')}</div> : null}
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

      {/* 「我必须配吗」——直接列出来，省得猜。默认收起：
          这是「查一次就够」的参考表，长期占着半屏不值当。 */}
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
