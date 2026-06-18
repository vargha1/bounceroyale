import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import { WebRTCNetHost, WebRTCNetGuest } from '../networking/webrtc';
import type { NetClient } from '../networking/types';

type Tab = 'menu' | 'webrtc-host' | 'webrtc-join';

interface Props {
  onCancel: () => void;
  /**
   * Called when the player is ready to enter the game with a connected net
   * client. The Game component takes ownership of the client and will close
   * it on exit.
   */
  onStart: (client: NetClient, startTimer: number) => void;
}

/**
 * LAN multiplayer modal — cross-device only, using WebRTC.
 *
 * Two options:
 *   1. Host Game — creates a host, waits for a guest's SDP offer, generates
 *      an answer, and starts the game when the guest connects.
 *   2. Join Game — creates an SDP offer, sends it to the host, pastes the
 *      host's answer, and connects.
 *
 * No server required. Both peers exchange SDP codes via copy-paste or QR
 * scan, then all game traffic flows directly between the two browsers over
 * WebRTC data channels.
 */
export default function LanModal({ onCancel, onStart }: Props) {
  const { language } = useSettings();
  const lang = language;
  const [tab, setTab] = useState<Tab>('menu');
  const [timer, setTimer] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected'>('idle');

  // WebRTC host state
  const [offerInput, setOfferInput] = useState(''); // guest's offer pasted by host
  const [answerCode, setAnswerCode] = useState(''); // host's answer to copy back
  const [answerQrUrl, setAnswerQrUrl] = useState('');
  const webrtcHostRef = useRef<WebRTCNetHost | null>(null);
  const startedRef = useRef(false);

  // WebRTC guest state
  const [hostToken, setHostToken] = useState('');
  const [offerCode, setOfferCode] = useState(''); // guest's offer to copy out
  const [offerQrUrl, setOfferQrUrl] = useState('');
  const [answerInput, setAnswerInput] = useState(''); // host's answer pasted by guest
  const webrtcGuestRef = useRef<WebRTCNetGuest | null>(null);

  useEffect(() => {
    if (answerCode) {
      QRCode.toDataURL(answerCode, { width: 200, margin: 1 }).then(setAnswerQrUrl).catch(() => setAnswerQrUrl(''));
    } else {
      setAnswerQrUrl('');
    }
  }, [answerCode]);

  useEffect(() => {
    if (offerCode) {
      QRCode.toDataURL(offerCode, { width: 200, margin: 1 }).then(setOfferQrUrl).catch(() => setOfferQrUrl(''));
    } else {
      setOfferQrUrl('');
    }
  }, [offerCode]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // ---- WebRTC host: create PeerConnection, accept guest's offer, produce answer ----
  const startWebrtcHost = async () => {
    setError(null);
    const id = `host-${Math.random().toString(36).slice(2, 8)}`;
    const host = new WebRTCNetHost(id);
    webrtcHostRef.current = host;
    host.onPeerChange((peers) => {
      if (peers.length > 0 && !startedRef.current) {
        startedRef.current = true;
        setStatus('connected');
        (window as any).__bounceroyale_pendingNet = host;
        onStart(host, timer);
      }
    });
    await host.host();
    setStatus('connecting');
  };

  const generateAnswer = async () => {
    if (!offerInput.trim() || !webrtcHostRef.current) return;
    setError(null);
    try {
      const { answerSdp } = await webrtcHostRef.current.acceptGuest(offerInput.trim());
      setAnswerCode(answerSdp);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to process guest offer');
    }
  };

  // ---- WebRTC guest: create offer, accept host's answer ----
  const startWebrtcGuest = async () => {
    setError(null);
    if (hostToken.trim()) {
      try {
        const parsed = JSON.parse(hostToken.trim());
        if (parsed?.kind !== 'host-invite') throw new Error('bad token');
      } catch {
        setError('Invalid host token. Paste exactly what the host shared, or leave blank.');
        return;
      }
    }
    const id = `g-${Math.random().toString(36).slice(2, 9)}`;
    const guest = new WebRTCNetGuest(id);
    webrtcGuestRef.current = guest;
    guest.onMessage((ev) => {
      if (ev.type === 'open' && !startedRef.current) {
        startedRef.current = true;
        setStatus('connected');
        (window as any).__bounceroyale_pendingNet = guest;
        webrtcGuestRef.current = null;
        onStart(guest, 30);
      }
    });
    try {
      const offer = await guest.createOffer();
      setOfferCode(offer);
      setStatus('connecting');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create offer');
    }
  };

  const applyHostAnswer = async () => {
    if (!webrtcGuestRef.current || !answerInput.trim()) return;
    setError(null);
    try {
      await webrtcGuestRef.current.acceptAnswer(answerInput.trim());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to apply host answer');
    }
  };

  const handleCancel = () => {
    if (webrtcHostRef.current) { webrtcHostRef.current.close(); webrtcHostRef.current = null; }
    if (webrtcGuestRef.current) { webrtcGuestRef.current.close(); webrtcGuestRef.current = null; }
    onCancel();
  };

  const TimerSlider = () => (
    <div className="setting-row">
      <label>{t('startTimer', lang)}</label>
      <input type="range" min={5} max={60} value={timer} onChange={(e) => setTimer(parseInt(e.target.value))} />
      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>5s</span>
        <span className="value-display">{timer}s</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>60s</span>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>📡 {t('hostLan', lang)}</h2>
        <p className="text-dim" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>{t('lanNoSignaling', lang)}</p>

        {/* Main menu — two options */}
        {tab === 'menu' && (
          <div className="flex-col" style={{ gap: '0.6rem' }}>
            <button className="primary" onClick={() => setTab('webrtc-host')}>
              📡 {t('lanHostNetwork', lang)}
              <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— {t('lanNetworkDesc', lang)}</span>
            </button>
            <button className="primary" onClick={() => setTab('webrtc-join')}>
              🔗 {t('lanJoinNetwork', lang)}
              <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— {t('lanNetworkDesc', lang)}</span>
            </button>
            <div className="actions mt-2">
              <button className="ghost" onClick={handleCancel}>{t('cancel', lang)}</button>
            </div>
          </div>
        )}

        {/* WebRTC host */}
        {tab === 'webrtc-host' && (
          <>
            <h3>📡 {t('lanHostNetwork', lang)}</h3>
            <ol className="lan-step-list">
              <li>{t('lanHostStep1', lang)}</li>
              <li>{t('lanHostStep2', lang)}</li>
              <li>{t('lanHostStep3', lang)}</li>
            </ol>
            {!webrtcHostRef.current ? (
              <>
                <TimerSlider />
                <div className="actions">
                  <button className="ghost" onClick={() => setTab('menu')}>{t('back', lang)}</button>
                  <button className="primary" onClick={startWebrtcHost}>📡 {t('startHost', lang)}</button>
                </div>
              </>
            ) : (
              <>
                <h3>2. {t('pasteOffer', lang)}</h3>
                <textarea
                  value={offerInput}
                  onChange={(e) => setOfferInput(e.target.value)}
                  placeholder='{ "sdp": {...}, "guestId": "g-..." }'
                  style={{ minHeight: 60 }}
                />
                <button className="primary mt-1" style={{ width: '100%' }} onClick={generateAnswer} disabled={!offerInput.trim()}>
                  ➜ {t('generateAnswer', lang)}
                </button>
                {answerCode && (
                  <>
                    <h3>3. {t('pasteAnswer', lang)} →</h3>
                    <div className="flex-row" style={{ alignItems: 'flex-start', gap: '1rem' }}>
                      <div style={{ flex: 1 }}>
                        <div className="code-box">{answerCode}</div>
                        <button className="ghost" style={{ width: '100%' }} onClick={() => copyToClipboard(answerCode)}>
                          📋 {copied ? t('copied', lang) : t('copyCode', lang)}
                        </button>
                      </div>
                      {answerQrUrl && (
                        <div className="qr-wrap">
                          <img src={answerQrUrl} alt="QR" width={140} height={140} />
                        </div>
                      )}
                    </div>
                  </>
                )}
                <div className={`connection-status ${status === 'connected' ? 'connected' : 'connecting'} mt-2`}>
                  <span className="dot"></span>
                  {status === 'connected' ? t('connected', lang) : t('waitingForGuest', lang)}
                </div>
                <div className="actions mt-2">
                  <button className="ghost" onClick={handleCancel}>{t('cancel', lang)}</button>
                </div>
              </>
            )}
          </>
        )}

        {/* WebRTC guest */}
        {tab === 'webrtc-join' && (
          <>
            <h3>🔗 {t('lanJoinNetwork', lang)}</h3>
            <ol className="lan-step-list">
              <li>{t('lanJoinStep1', lang)}</li>
              <li>{t('lanJoinStep2', lang)}</li>
              <li>{t('lanJoinStep3', lang)}</li>
            </ol>
            {!offerCode ? (
              <>
                <h3>1. {t('hostInstructions', lang)}</h3>
                <textarea
                  value={hostToken}
                  onChange={(e) => setHostToken(e.target.value)}
                  placeholder='{ "kind": "host-invite", "hostId": "host-...", "ts": ... }'
                  style={{ minHeight: 50 }}
                />
                <button className="primary mt-1" style={{ width: '100%' }} onClick={startWebrtcGuest}>
                  ➜ {t('generateAnswer', lang)}
                </button>
                <div className="actions mt-2">
                  <button className="ghost" onClick={() => setTab('menu')}>{t('back', lang)}</button>
                </div>
              </>
            ) : (
              <>
                <h3>2. {t('hostInstructions', lang)} →</h3>
                <div className="flex-row" style={{ alignItems: 'flex-start', gap: '1rem' }}>
                  <div style={{ flex: 1 }}>
                    <div className="code-box">{offerCode}</div>
                    <button className="ghost" style={{ width: '100%' }} onClick={() => copyToClipboard(offerCode)}>
                      📋 {copied ? t('copied', lang) : t('copyCode', lang)}
                    </button>
                  </div>
                  {offerQrUrl && (
                    <div className="qr-wrap">
                      <img src={offerQrUrl} alt="QR" width={140} height={140} />
                    </div>
                  )}
                </div>
                <h3>3. {t('pasteAnswer', lang)}</h3>
                <textarea
                  value={answerInput}
                  onChange={(e) => setAnswerInput(e.target.value)}
                  placeholder='{ "sdp": {...}, "guestId": "g-...", "hostId": "host-..." }'
                  style={{ minHeight: 60 }}
                />
                <button className="primary mt-1" style={{ width: '100%' }} onClick={applyHostAnswer} disabled={!answerInput.trim()}>
                  ✓ {t('connect', lang)}
                </button>
                <div className={`connection-status ${status === 'connected' ? 'connected' : 'connecting'} mt-2`}>
                  <span className="dot"></span>
                  {status === 'connected' ? t('connected', lang) : t('connecting', lang)}
                </div>
                <div className="actions mt-2">
                  <button className="ghost" onClick={handleCancel}>{t('cancel', lang)}</button>
                </div>
              </>
            )}
          </>
        )}

        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
      </div>
    </div>
  );
}
