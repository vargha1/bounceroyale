import { useState } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onCancel: () => void;
  onConnect: (serverUrl: string, gameId?: string) => void;
}

export default function JoinServerModal({ onCancel, onConnect }: Props) {
  const { language } = useSettings();
  const lang = language;
  const [ip, setIp] = useState('');

  const quickFill = (host: string) => {
    setIp(host);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🌐 {t('joinGame', lang)}</h2>
        <h3>{t('manualConnect', lang)}</h3>
        <input
          type="text"
          value={ip}
          placeholder={t('enterIp', lang)}
          onChange={(e) => setIp(e.target.value)}
        />
        <div className="flex-row mt-1" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          <button className="ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem', minHeight: 0 }} onClick={() => quickFill(`${location.hostname}:8443`)}>localhost:8443</button>
          <button className="ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem', minHeight: 0 }} onClick={() => quickFill('game.safahanbattery.ir:8443')}>safahanbattery.ir</button>
        </div>
        <div className="actions mt-2">
          <button className="ghost" onClick={onCancel}>{t('cancel', lang)}</button>
          <button className="primary" disabled={!ip.trim()} onClick={() => onConnect(ip.trim())}>{t('connect', lang)}</button>
        </div>
        <p className="footer-note">{t('serverGame', lang)}</p>
      </div>
    </div>
  );
}
