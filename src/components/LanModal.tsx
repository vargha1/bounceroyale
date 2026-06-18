import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import { WebRTCNetHost, WebRTCNetGuest } from '../networking/webrtc';
import type { NetClient } from '../networking/types';

type Tab = 'menu' | 'host' | 'join';

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
 * LAN multiplayer modal — cross-device, pure WebRTC (no signaling server).
 *
 * Simplified 2-step flow:
 *
 *   HOST
 *   1. Click "Start Hosting" → host's invite code (QR + text) appears.
 *   2. Guest scans/copies it → returns their answer code.
 *   3. Host pastes the answer → connected.
 *
 *   GUEST
 *   1. Paste the host's invite code → answer code (QR + text) appears.
 *   2. Send the answer back to the host → connected once host applies it.
 *
 * Codes are deflate-compressed + base64url-encoded (see webrtc.ts) so they
 * fit comfortably inside a small QR code.
 */
export default function LanModal({ onCancel, onStart }: Props) {
  const { language } = useSettings();
  const lang = language;
  const [tab, setTab] = useState<Tab>('menu');
  const [timer, setTimer] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'host' | 'guest' | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [busy, setBusy] = useState(false);

  // ---- Host state ----
  // Phase: 'idle' (before clicking Start) → 'waiting' (showing invite, awaiting answer) → 'connected'
  const [hostPhase, setHostPhase] = useState<'idle' | 'waiting'>('idle');
  const [hostCode, setHostCode] = useState('');
  const [hostQrUrl, setHostQrUrl] = useState('');
  const [guestAnswerInput, setGuestAnswerInput] = useState('');
  const webrtcHostRef = useRef<WebRTCNetHost | null>(null);
  const startedRef = useRef(false);

  // ---- Guest state ----
  // Phase: 'idle' (paste host code) → 'answer' (showing answer, waiting for host to apply) → 'connected'
  const [guestPhase, setGuestPhase] = useState<'idle' | 'answer'>('idle');
  const [hostCodeInput, setHostCodeInput] = useState('');
  const [guestCode, setGuestCode] = useState('');
  const [guestQrUrl, setGuestQrUrl] = useState('');
  const webrtcGuestRef = useRef<WebRTCNetGuest | null>(null);

  // Generate QR codes (small + low error-correction for higher density / easier scan).
  useEffect(() => {
    if (hostCode) {
      QRCode.toDataURL(hostCode, {
        margin: 4,
        errorCorrectionLevel: 'L'
      })
        .then(setHostQrUrl)
        .catch(() => setHostQrUrl(''));
    } else {
      setHostQrUrl('');
    }
  }, [hostCode]);

  useEffect(() => {
    if (guestCode) {
      QRCode.toDataURL(guestCode, {
        margin: 4,
        errorCorrectionLevel: 'L'
      })
        .then(setGuestQrUrl)
        .catch(() => setGuestQrUrl(''));
    } else {
      setGuestQrUrl('');
    }
  }, [guestCode]);

  const copyToClipboard = (text: string, which: 'host' | 'guest') => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(which);
      setTimeout(() => setCopiedKey(null), 1500);
    });
  };

  // ===========================================================================
  // Host actions
  // ===========================================================================

  const startHost = async () => {
    setError(null);
    setBusy(true);
    try {
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
      const code = await host.createOffer();
      setHostCode(code);
      setHostPhase('waiting');
      setStatus('connecting');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to start hosting');
      webrtcHostRef.current?.close();
      webrtcHostRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const applyGuestAnswer = async () => {
    if (!webrtcHostRef.current || !guestAnswerInput.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await webrtcHostRef.current.acceptAnswer(guestAnswerInput.trim());
      // Status will switch to 'connected' via onPeerChange when the data channel opens.
    } catch (e: any) {
      setError(e?.message ?? 'Failed to apply guest answer. Make sure you pasted the full code.');
    } finally {
      setBusy(false);
    }
  };

  // ===========================================================================
  // Guest actions
  // ===========================================================================

  const generateAnswer = async () => {
    if (!hostCodeInput.trim()) return;
    setError(null);
    setBusy(true);
    try {
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
      const answer = await guest.acceptOffer(hostCodeInput.trim());
      setGuestCode(answer);
      setGuestPhase('answer');
      setStatus('connecting');
    } catch (e: any) {
      console.error("JOIN ERROR:", e);
      setError(
        e?.stack ||
        e?.message ||
        JSON.stringify(e)
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (webrtcHostRef.current) { webrtcHostRef.current.close(); webrtcHostRef.current = null; }
    if (webrtcGuestRef.current) { webrtcGuestRef.current.close(); webrtcGuestRef.current = null; }
    onCancel();
  };

  const backToMenu = () => {
    // Soft reset: tear down any in-progress connection and return to the tab menu.
    if (webrtcHostRef.current) { webrtcHostRef.current.close(); webrtcHostRef.current = null; }
    if (webrtcGuestRef.current) { webrtcGuestRef.current.close(); webrtcGuestRef.current = null; }
    setHostPhase('idle'); setHostCode(''); setGuestAnswerInput('');
    setGuestPhase('idle'); setHostCodeInput(''); setGuestCode('');
    setStatus('idle'); setError(null); startedRef.current = false;
    setTab('menu');
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

  // Shared code-display block: QR + copy button + collapsible text.
  const CodeBlock = ({ code, which }: { code: string; which: 'host' | 'guest' }) => {
    const qrUrl = which === 'host' ? hostQrUrl : guestQrUrl;
    return (
      <div
        className="code-block-grid"
        style={{ display: 'flex', width: '100%', height: '320px', gap: '0.75rem', alignItems: 'stretch' }}
      >
        {qrUrl && (
          <div
            className="qr-side"
            style={{
              flex: '0 0 50%',
              // background: 'white',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.35rem',
              overflow: 'hidden',
            }}
          >
            <img src={qrUrl} alt="QR code" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          </div>
        )}
        <div
          className="code-side"
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <div className="code-box" style={{ flex: 1, maxHeight: 'none', margin: 0 }}>
            {code}
          </div>
          <button
            className="ghost"
            style={{ width: '100%', marginTop: '0.4rem', flexShrink: 0 }}
            onClick={() => copyToClipboard(code, which)}
          >
            📋 {copiedKey === which ? t('copied', lang) : t('copyCode', lang)}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>📡 {t('hostLan', lang)}</h2>
        <p className="text-dim" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>{t('lanNoSignaling', lang)}</p>

        {/* ============ Main menu ============ */}
        {tab === 'menu' && (
          <div className="flex-col" style={{ gap: '0.6rem' }}>
            <button className="primary" onClick={() => setTab('host')}>
              📡 {t('lanHostNetwork', lang)}
              <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— {t('lanNetworkDesc', lang)}</span>
            </button>
            <button className="primary" onClick={() => setTab('join')}>
              🔗 {t('lanJoinNetwork', lang)}
              <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— {t('lanNetworkDesc', lang)}</span>
            </button>
            <div className="actions mt-2">
              <button className="ghost" onClick={handleCancel}>{t('cancel', lang)}</button>
            </div>
          </div>
        )}

        {/* ============ Host tab ============ */}
        {tab === 'host' && (
          <>
            <h3>📡 {t('lanHostNetwork', lang)}</h3>

            {hostPhase === 'idle' && (
              <>
                <ol className="lan-step-list">
                  <li>{t('lanHostStep1', lang)}</li>
                  <li>{t('lanHostStep2', lang)}</li>
                  <li>{t('lanHostStep3', lang)}</li>
                </ol>
                <TimerSlider />
                <div className="actions">
                  <button className="ghost" onClick={backToMenu}>{t('back', lang)}</button>
                  <button className="primary" onClick={startHost} disabled={busy}>
                    {busy ? '…' : `📡 ${t('startHost', lang)}`}
                  </button>
                </div>
              </>
            )}

            {hostPhase === 'waiting' && (
              <>
                <h3>1. {t('lanShareInvite', lang)}</h3>
                <CodeBlock code={hostCode} which="host" />

                <h3>2. {t('lanPasteAnswer', lang)}</h3>
                <textarea
                  value={guestAnswerInput}
                  onChange={(e) => setGuestAnswerInput(e.target.value)}
                  placeholder={t('lanAnswerPlaceholder', lang)}
                  style={{ minHeight: 60 }}
                />
                <button
                  className="primary mt-1"
                  style={{ width: '100%' }}
                  onClick={applyGuestAnswer}
                  disabled={!guestAnswerInput.trim() || busy}
                >
                  {busy ? '…' : `✓ ${t('connect', lang)}`}
                </button>

                <div className={`connection-status ${status === 'connected' ? 'connected' : 'connecting'} mt-2`}>
                  <span className="dot"></span>
                  {status === 'connected' ? t('connected', lang) : t('waitingForGuest', lang)}
                </div>
                <div className="actions mt-2">
                  <button className="ghost" onClick={backToMenu}>{t('cancel', lang)}</button>
                </div>
              </>
            )}
          </>
        )}

        {/* ============ Join tab ============ */}
        {tab === 'join' && (
          <>
            <h3>🔗 {t('lanJoinNetwork', lang)}</h3>

            {guestPhase === 'idle' && (
              <>
                <ol className="lan-step-list">
                  <li>{t('lanJoinStep1', lang)}</li>
                  <li>{t('lanJoinStep2', lang)}</li>
                  <li>{t('lanJoinStep3', lang)}</li>
                </ol>
                <h3>1. {t('lanPasteInvite', lang)}</h3>
                <textarea
                  value={hostCodeInput}
                  onChange={(e) => setHostCodeInput(e.target.value)}
                  placeholder={t('lanInvitePlaceholder', lang)}
                  style={{ minHeight: 60 }}
                />
                <button
                  className="primary mt-1"
                  style={{ width: '100%' }}
                  onClick={generateAnswer}
                  disabled={!hostCodeInput.trim() || busy}
                >
                  {busy ? '…' : `➜ ${t('generateAnswer', lang)}`}
                </button>
                <div className="actions mt-2">
                  <button className="ghost" onClick={backToMenu}>{t('back', lang)}</button>
                </div>
              </>
            )}

            {guestPhase === 'answer' && (
              <>
                <h3>2. {t('lanSendAnswer', lang)}</h3>
                <CodeBlock code={guestCode} which="guest" />

                <div className={`connection-status ${status === 'connected' ? 'connected' : 'connecting'} mt-2`}>
                  <span className="dot"></span>
                  {status === 'connected' ? t('connected', lang) : t('lanWaitingForHost', lang)}
                </div>
                <div className="actions mt-2">
                  <button className="ghost" onClick={backToMenu}>{t('cancel', lang)}</button>
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
