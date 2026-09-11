// savebar.jsx — 统一的「保存 + 状态」条
//
// 为什么要有它：以前保存成功只 flash 一个 2.5 秒的 toast，位置在屏幕右下角，
// 又小又容易错过；保存按钮旁边则是**什么都没有**，所以「保存成功了吗」根本无从判断
// （实测：toast 确实出现了，但 71×43px 贴在视口最角上，用户看不到）。
// 现在的约定：
//   idle  = 还没动过        dirty = 有未保存的改动（琥珀色，常驻）
//   saving= 保存中          saved = 已保存 + 时间戳（常驻，绿色）
//   error = 失败原因（常驻，红色，不清掉 —— 失败了就必须一直看得见）
import { useCallback, useState } from 'react';
import { useI18n } from './i18n.jsx';

export function useSaveState() {
  const [state, setState] = useState('idle');
  const [at, setAt] = useState(null);
  const [error, setError] = useState('');

  const dirty = useCallback(() => setState((s) => (s === 'saving' || s === 'error' ? s : 'dirty')), []);
  const saving = useCallback(() => setState('saving'), []);
  const saved = useCallback(() => {
    setState('saved');
    setAt(new Date());
    setError('');
  }, []);
  const failed = useCallback((m) => {
    setState('error');
    setError(String(m ?? ''));
  }, []);

  return { state, at, error, dirty, saving, saved, failed };
}

export function SaveBar({ st, onSave, busy, children }) {
  const { t } = useI18n();
  const cls =
    st.state === 'saved' ? 'ok' : st.state === 'error' ? 'err' : st.state === 'dirty' ? 'dirty' : st.state === 'saving' ? 'busy' : 'idle';

  let label = t('saveStateIdle');
  if (st.state === 'dirty') label = t('saveStateDirty');
  else if (st.state === 'saving') label = t('saving');
  else if (st.state === 'saved') label = `${t('saved')} · ${st.at ? st.at.toLocaleTimeString() : ''}`;
  else if (st.state === 'error') label = `❌ ${st.error}`;

  return (
    <div className="save-bar">
      <button className="primary" onClick={onSave} disabled={busy}>
        {busy ? t('saving') : t('save')}
      </button>
      <span className={'save-status ' + cls} role="status" aria-live="polite">
        {st.state === 'saved' ? '✅ ' : ''}
        {label}
      </span>
      {children}
    </div>
  );
}
