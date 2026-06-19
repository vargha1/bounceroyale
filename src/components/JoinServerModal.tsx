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

  // Detect mixed-content scenario: page is HTTPS but URL is HTTP. The browser
  // will block the WebSocket connection. Show a warning so the user knows to
  // use an HTTPS server URL instead.
  const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const urlIsHttp = ip.trim().startsWith('http://') || ip.trim().startsWith('ws://');
  const showMixedContentWarning = pageIsHttps && urlIsHttp;

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
          <button className="ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem', minHeight: 0 }} onClick={() => quickFill('https://game.safahanbattery.ir:8443')}>safahanbattery.ir</button>
        </div>

        {showMixedContentWarning && (
          <div style={{
            marginTop: '0.6rem',
            padding: '0.6rem 0.75rem',
            borderRadius: '8px',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            fontSize: '0.82rem',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: '#fbbf24', display: 'block', marginBottom: '0.3rem' }}>
              ⚠️ Mixed content detected
            </strong>
            This page is served over <strong>HTTPS</strong>, but you entered an <code>http://</code> URL.
            Browsers block insecure WebSocket connections from HTTPS pages — the connection will fail.
            <div style={{ marginTop: '0.4rem' }}>
              <strong>Use an HTTPS server URL instead.</strong> The URL will be auto-upgraded to{' '}
              <code>https://</code> when you connect, but the server must actually support HTTPS/WSS.
            </div>
          </div>
        )}

        <div className="actions mt-2">
          <button className="ghost" onClick={onCancel}>{t('cancel', lang)}</button>
          <button className="primary" disabled={!ip.trim()} onClick={() => onConnect(ip.trim())}>{t('connect', lang)}</button>
        </div>
        <p className="footer-note">{t('serverGame', lang)}</p>
      </div>
    </div>
  );
}
