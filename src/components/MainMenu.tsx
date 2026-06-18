import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onStart: () => void;
  onSettings: () => void;
  onAbout: () => void;
}

export default function MainMenu({ onStart, onSettings, onAbout }: Props) {
  const { language, set } = useSettings();
  const lang = language;

  return (
    <div className="menu">
      <header className="header">
        <div className="header-logo">
          <img src="/images/logo.png" alt="Bounce Royale" />
          <span className="title">{t('welcomeTitle', lang).split(' ').slice(-1)[0]}</span>
        </div>
        <div className="header-actions">
          <div className="lang-pill">
            <button className={lang === 'en' ? 'active' : ''} onClick={() => set('language', 'en')}>
              EN
            </button>
            <button className={lang === 'fa' ? 'active' : ''} onClick={() => set('language', 'fa')}>
              فا
            </button>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <div className="nav-item" onClick={onStart}>
          <span className="icon">🏁</span>
          <span>{t('startGame', lang)}</span>
        </div>
        <div className="nav-item" onClick={onSettings}>
          <span className="icon">⚙️</span>
          <span>{t('settings', lang)}</span>
        </div>
        <div className="nav-item" onClick={onAbout}>
          <span className="icon">❓</span>
          <span>{t('about', lang)}</span>
        </div>
        <div className="nav-item" onClick={() => window.close()}>
          <span className="icon">🚪</span>
          <span>{t('exit', lang)}</span>
        </div>
      </aside>

      <main className="main">
        <div className="welcome">
          <h1>{t('welcomeTitle', lang)}</h1>
          <p>{t('welcomeDesc', lang)}</p>
          <div className="cta">
            <button className="primary" onClick={onStart}>
              🏁 {t('startGame', lang)}
            </button>
            <button className="ghost" onClick={onSettings}>
              ⚙️ {t('settings', lang)}
            </button>
          </div>
          <p className="hint">{t('controlsHint', lang)}</p>
        </div>
      </main>
    </div>
  );
}
