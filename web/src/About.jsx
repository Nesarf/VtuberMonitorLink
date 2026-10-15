// About.jsx — the documents, readable inside the app
//
// Why it exists: the README is the only place that explains what the eleven pages are for and what
// the tool deliberately refuses to do, and the answer used to be "go find the file on disk". This
// renders it in place, over whatever page you are on, and — the point of the whole thing — switches
// language **instantly**: both documents are fetched once and kept in state, so the toggle is a
// re-render, not a navigation or a reload.
//
// The panel shows more than the Readme now: `docs/PRIVACY.md` and `SECURITY.md` are in the same allowlist
// (`server/src/docs.js`), so the privacy posture and the security policy are readable inside the app rather than
// only in the folder next to it. Two deliberate consequences:
//
//   · the **tab labels are the documents' own names** from that allowlist rather than new i18n keys. A new key
//     moves three ratcheted surfaces (the UI key count, the per-locale coverage denominators, the proofread
//     counts), and the config-fault banner already set this precedent: chrome may reuse existing keys, and text
//     that belongs to a document comes from that document. The tooltip carries the document's own title, which is
//     its first heading and therefore cannot drift from the file.
//   · the **language switch appears only when the current document has more than one language**. The Readmes do;
//     the privacy and security documents do not, and offering a switch that silently shows the same file twice
//     would be a control that does nothing.
//
// The language of this panel is independent of the UI language on purpose: a user running the
// interface in Japanese may still want to read the Chinese README, or hand the English one to a
// friend. The toggle therefore defaults to the current UI language but never follows it afterwards.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n.jsx';
import { Markdown } from './markdown.jsx';
import { api } from './api.js';

/** The languages each document may exist in. The document list itself comes from the server (see the header). */
const LANGS = [
  { code: 'en', labelKey: 'readmeLangEn' },
  { code: 'zh', labelKey: 'readmeLangZh' },
];

export default function About({ open, onClose }) {
  const { t, localeCode } = useI18n();
  // 'zh' for any Chinese locale, English otherwise — a default, not a rule
  const [lang, setLang] = useState(String(localeCode ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const [doc, setDoc] = useState('readme');
  const [docs, setDocs] = useState({}); // "doc:lang" -> { markdown, file }
  const [available, setAvailable] = useState(null); // languages the current document has
  const [documents, setDocuments] = useState(null); // [{ name, label, title, file }] as the server lists them
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);

  // Fetch on demand and keep it: switching document or language back and forth must never hit the network twice.
  // The cache key carries both, because `privacy` has one language and `readme` has two - a cache keyed on the
  // language alone would hand the Readme to the privacy tab.
  const load = async (code, name) => {
    const key = `${name}:${code}`;
    if (docs[key]) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.readme(code, name);
      setDocs((d) => ({ ...d, [`${r.doc ?? name}:${r.lang}`]: { markdown: r.markdown, file: r.file } }));
      setAvailable(r.available ?? null);
      setDocuments(Array.isArray(r.documents) && r.documents.length ? r.documents : null);
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
    if (!docs[`${doc}:${lang}`]) load(lang, doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc, lang]);

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

  const current = docs[`${doc}:${lang}`];
  const choices = available ? LANGS.filter((d) => available.includes(d.code)) : LANGS;

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal about-modal" role="dialog" aria-label={t('aboutTitle')} ref={panel}>
        <header className="modal-head">
          <h2>{t('aboutTitle')}</h2>
          <div className="spacer" />
          {/* Which document. Labels come from the server's own list - see the header for why there are no new
              i18n keys, and the tooltip carries the document's first heading. */}
          {documents && documents.length > 1 && (
            <div className="seg" role="group" aria-label={t('aboutTitle')} data-testid="about-docs">
              {documents.map((d) => (
                <button
                  key={d.name}
                  type="button"
                  className={doc === d.name ? 'active' : ''}
                  onClick={() => setDoc(d.name)}
                  aria-pressed={doc === d.name}
                  title={d.title}
                >
                  {d.label ?? d.name}
                </button>
              ))}
            </div>
          )}
          {/* Instant switch: both documents stay in state, so this is a re-render and nothing else. Shown only
              when this document exists in more than one language. */}
          {choices.length > 1 && (
            <div className="seg" role="group" aria-label={t('readmeLang')} data-testid="about-langs">
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
          )}
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
