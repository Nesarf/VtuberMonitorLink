import { useState } from 'react';
import { useI18n } from './i18n.jsx';
import Settings from './pages/Settings.jsx';
import Sources from './pages/Sources.jsx';
import Run from './pages/Run.jsx';
import Reports from './pages/Reports.jsx';

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState('run');
  const tabs = [
    ['run', t('tab_run')],
    ['sources', t('tab_sources')],
    ['settings', t('tab_settings')],
    ['reports', t('tab_reports')],
  ];
  return (
    <>
      <header className="top">
        <div>
          <h1>{t('appTitle')}</h1>
          <div className="sub">{t('appSub')}</div>
        </div>
        <div className="spacer" />
        <button className="ghost lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
          {lang === 'zh' ? 'English' : '中文'}
        </button>
      </header>
      <nav className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'run' && <Run />}
        {tab === 'sources' && <Sources />}
        {tab === 'settings' && <Settings />}
        {tab === 'reports' && <Reports />}
      </main>
    </>
  );
}
