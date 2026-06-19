import { useState } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onCancel: () => void;
  onStart: (serverUrl: string, startTimer: number) => void;
}

export default function CreateGameModal({ onCancel, onStart }: Props) {
  const { language } = useSettings();
  const lang = language;
  const [timer, setTimer] = useState(30);
  const [serverUrl, setServerUrl] = useState('');

  const clamp = (v: number) => Math.max(5, Math.min(60, isNaN(v) ? 30 : v));

  const quickFill = (host: string) => {
    setServerUrl(host);
  };

  // Detect mixed-content scenario: page is HTTPS but URL is HTTP. The browser
  // will block the WebSocket connection. We show a warning so the user knows
  // to use an HTTPS server URL instead.
  const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const urlIsHttp = serverUrl.trim().startsWith('http://') || serverUrl.trim().startsWith('ws://');
  const showMixedContentWarning = pageIsHttps && urlIsHttp;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🌐 {t('createGame', lang)}</h2>
        <p className="text-dim" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
          Enter the server URL where you want to host the game. This is the
          Node.js + Socket.io server you run with <code>npm run server</code>.
          Other players will join the same server.
        </p>
        <div className="setting-row">
          <label>Server URL</label>
          <input
            type="text"
            value={serverUrl}
            placeholder="e.g. https://game.safahanbattery.ir:8443"
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <div className="flex-row mt-1" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <button className="ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem', minHeight: 0 }} onClick={() => quickFill(`${location.protocol}//${location.hostname}:8443`)}>
              {location.hostname}:8443
            </button>
            <button className="ghost" style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem', minHeight: 0 }} onClick={() => quickFill('https://game.safahanbattery.ir:8443')}>
              safahanbattery.ir
            </button>
          </div>
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
              <strong>Use an HTTPS server URL instead.</strong> The game server must accept HTTPS/WSS
              connections (e.g. with SSL certificates, or behind Cloudflare/nginx/ngrok).
              The URL will be auto-upgraded to <code>https://</code> when you connect, but the server
              must actually support it.
            </div>
          </div>
        )}

        <div className="setting-row" style={{ marginTop: '0.6rem' }}>
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
          <button className="primary" disabled={!serverUrl.trim()} onClick={() => onStart(serverUrl.trim(), timer)}>🌐 {t('startGameConfirm', lang)}</button>
        </div>
        <p className="footer-note">{t('serverGame', lang)}</p>
      </div>
    </div>
  );
}
