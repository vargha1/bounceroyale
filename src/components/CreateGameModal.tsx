import { useState } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onCancel: () => void;
  onStart: (startTimer: number) => void;
}

export default function CreateGameModal({ onCancel, onStart }: Props) {
  const { language } = useSettings();
  const lang = language;
  const [timer, setTimer] = useState(30);

  const clamp = (v: number) => Math.max(5, Math.min(60, isNaN(v) ? 30 : v));

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🌐 {t('createGame', lang)}</h2>
        <div className="setting-row">
          <label>{t('startTimer', lang)}</label>
          <input
            type="number"
            min={5}
            max={60}
            value={timer}
            onChange={(e) => setTimer(clamp(parseInt(e.target.value) || 30))}
          />
          <input
            type="range"
            min={5}
            max={60}
            step={1}
            value={timer}
            onChange={(e) => setTimer(parseInt(e.target.value))}
            style={{ marginTop: '0.5rem' }}
          />
        </div>
        <div className="actions">
          <button className="ghost" onClick={onCancel}>{t('cancel', lang)}</button>
          <button className="primary" onClick={() => onStart(timer)}>🌐 {t('startGameConfirm', lang)}</button>
        </div>
        <p className="footer-note">{t('serverGame', lang)}</p>
      </div>
    </div>
  );
}
