import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const s = useSettings();
  const lang = s.language;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ {t('settings', lang)}</h2>

        {/* Language */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsLanguage', lang)}</label>
          </div>
          <div className="seg-control">
            <button className={lang === 'en' ? 'active' : ''} onClick={() => s.set('language', 'en')}>English</button>
            <button className={lang === 'fa' ? 'active' : ''} onClick={() => s.set('language', 'fa')}>فارسی</button>
          </div>
        </div>

        {/* Game speed */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsGameSpeed', lang)}</label>
            <span className="value-display">{s.gameSpeed.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={s.gameSpeed}
            onChange={(e) => s.set('gameSpeed', parseFloat(e.target.value))}
          />
          <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{t('speedSlow', lang)} 0.25×</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>1×</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{t('speedFast', lang)} 2×</span>
          </div>
        </div>

        {/* Island damage multiplier */}
        <div className="setting-row">
          <div className="row-header">
            <label>🏝️ {t('settingsIslandDamage', lang)}</label>
            <span className="value-display">{s.islandDamageMultiplier.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.05}
            value={s.islandDamageMultiplier}
            onChange={(e) => s.set('islandDamageMultiplier', parseFloat(e.target.value))}
          />
          <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>0.1×</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>1×</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>3×</span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '0.3rem', lineHeight: 1.4 }}>
            {lang === 'fa'
              ? 'هرچه سرعت فرود بالاتر باشد، آسیب بیشتری به جزیره وارد می‌شود.'
              : 'Higher fall speed = more damage. Land hard to crater the island.'}
          </p>
        </div>

        {/* Island size */}
        <div className="setting-row">
          <div className="row-header">
            <label>🗺️ {t('settingsIslandSize', lang)}</label>
          </div>
          <div className="seg-control">
            <button className={s.islandSize === 'small' ? 'active' : ''} onClick={() => s.set('islandSize', 'small')}>{t('islandSmall', lang)}</button>
            <button className={s.islandSize === 'medium' ? 'active' : ''} onClick={() => s.set('islandSize', 'medium')}>{t('islandMedium', lang)}</button>
            <button className={s.islandSize === 'large' ? 'active' : ''} onClick={() => s.set('islandSize', 'large')}>{t('islandLarge', lang)}</button>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '0.3rem', lineHeight: 1.4 }}>
            {lang === 'fa'
              ? 'در نسخه تک‌نفره اعمال می‌شود. در حالت چندنفره، اندازه میزبان استفاده می‌شود.'
              : 'Applies to single-player. In multiplayer the host’s size is used.'}
          </p>
        </div>

        {/* Master volume */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsVolume', lang)}</label>
            <span className="value-display">{Math.round(s.masterVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={s.masterVolume}
            onChange={(e) => s.set('masterVolume', parseFloat(e.target.value))}
          />
        </div>

        {/* Camera sensitivity */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsCameraSens', lang)}</label>
            <span className="value-display">{s.cameraSensitivity.toFixed(2)}×</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.05}
            value={s.cameraSensitivity}
            onChange={(e) => s.set('cameraSensitivity', parseFloat(e.target.value))}
          />
        </div>

        {/* Graphics quality */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsGraphics', lang)}</label>
          </div>
          <div className="seg-control">
            <button className={s.graphicsQuality === 'low' ? 'active' : ''} onClick={() => s.set('graphicsQuality', 'low')}>{t('low', lang)}</button>
            <button className={s.graphicsQuality === 'medium' ? 'active' : ''} onClick={() => s.set('graphicsQuality', 'medium')}>{t('medium', lang)}</button>
            <button className={s.graphicsQuality === 'high' ? 'active' : ''} onClick={() => s.set('graphicsQuality', 'high')}>{t('high', lang)}</button>
          </div>
        </div>

        {/* Toggles */}
        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsPointerLock', lang)}</label>
            <div className={`toggle ${s.pointerLock ? 'on' : ''}`} onClick={() => s.set('pointerLock', !s.pointerLock)} />
          </div>
        </div>

        <div className="setting-row">
          <div className="row-header">
            <label>{t('settingsShowFps', lang)}</label>
            <div className={`toggle ${s.showFps ? 'on' : ''}`} onClick={() => s.set('showFps', !s.showFps)} />
          </div>
        </div>

        <div className="actions mt-2">
          <button className="danger" onClick={() => s.reset()}>{t('reset', lang)}</button>
          <button className="primary" onClick={onClose}>{t('back', lang)}</button>
        </div>
        <p className="footer-note">{t('applySettings', lang)}</p>
      </div>
    </div>
  );
}
