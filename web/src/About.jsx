// About.jsx — the README, readable inside the app
//
// Why it exists: the README is the only place that explains what the eleven pages are for and what
// the tool deliberately refuses to do, and the answer used to be "go find the file on disk". This
// renders it in place, over whatever page you are on, and — the point of the whole thing — switches
// language **instantly**: both documents are fetched once and kept in state, so the toggle is a
// re-render, not a navigation or a reload.
//
// The language of this panel is independent of the UI language on purpose: a user running the
// interface in Japanese may still want to read the Chinese README, or hand the English one to a
// friend. The toggle therefore defaults to the current UI language but never follows it afterwards.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n.jsx';
import { Markdown } from './markdown.jsx';
import { api } from './api.js';

const DOCS = [
  { code: 'en', file: 'README.md', labelKey: 'readmeLangEn' },
  { code: 'zh', file: 'README.zh-CN.md', labelKey: 'readmeLangZh' },
];

export default function About({ open, onClose }) {
  const { t, localeCode } = useI18n();
  // 'zh' for any Chinese locale, English otherwise — a default, not a rule
  const [lang, setLang] = useState(String(localeCode ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const [docs, setDocs] = useState({}); // code -> { markdown, file }
  const [available, setAvailable] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);

  // Fetch on demand and keep it: switching back and forth must never hit the network twice
  const load = async (code) => {
    if (docs[code]) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.readme(code);
      setDocs((d) => ({ ...d, [r.lang]: { markdown: r.markdown, file: r.file } }));
      setAvailable(r.available ?? null);
      // A missing translation should not strand the reader on an empty panel
      if (r.lang !== code) setLang(r.lang);
    } catch (e) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!docs[lang]) load(lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lang]);

  // Esc closes; that is the least surprising thing a panel like this can do
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const current = docs[lang];
  const choices = available ? DOCS.filter((d) => available.includes(d.code)) : DOCS;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal about-modal" role="dialog" aria-label={t('aboutTitle')} ref={panel}>
        <header className="modal-head">
          <h2>{t('aboutTitle')}</h2>
          <div className="spacer" />
          {/* Instant switch: both documents stay in state, so this is a re-render and nothing else */}
          <div className="seg" role="group" aria-label={t('readmeLang')}>
            {choices.map((d) => (
              <button
                key={d.code}
                type="button"
                className={lang === d.code ? 'active' : ''}
                onClick={() => setLang(d.code)}
                aria-pressed={lang === d.code}
              >
                {t(d.labelKey)}
              </button>
            ))}
          </div>
          <button type="button" className="ghost" onClick={onClose} title={t('close')}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          {err && <p className="save-status err">{t('readmeFail')}: {err}</p>}
          {!err && !current && <p className="muted">{busy ? t('loading') : t('readmeFail')}</p>}
          {current && <Markdown text={current.markdown} className="readme-doc" />}
        </div>
        <footer className="modal-foot muted small">
          {t('readmeNote')}
          {current ? ` · ${current.file}` : ''}
        </footer>
      </section>
    </div>
  );
}
