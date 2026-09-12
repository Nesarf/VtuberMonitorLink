// savebar.jsx — the unified "save + status" bar
//
// Why it exists: a successful save used to flash a 2.5-second toast in the bottom-right
// corner of the screen -- tiny and easy to miss; next to the save button there was
// **nothing at all**, so "did the save succeed?" was impossible to answer
// (measured: the toast did show up, but 71×43px glued to the very corner of the viewport
// is not something users see).
// The convention now:
//   idle  = untouched        dirty = unsaved changes (amber, persistent)
//   saving= saving           saved = saved + timestamp (persistent, green)
//   error = failure reason (persistent, red, never cleared -- if it failed it must stay visible)
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
