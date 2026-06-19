import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import {
  WebRTCNetHost,
  WebRTCNetGuest,
  detectLocalIps,
  getNetworkStatus,
  COMMON_HOTSPOT_HOST_IPS,
} from '../networking/webrtc';
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
  /** Transient status text shown during long operations (e.g. ICE gathering). */
  const [statusText, setStatusText] = useState<string | null>(null);

  // ---- Host state ----
  // Phase: 'idle' (before clicking Start) → 'waiting' (showing invite, awaiting answer) → 'connected'
  const [hostPhase, setHostPhase] = useState<'idle' | 'waiting'>('idle');
  const [hostCode, setHostCode] = useState('');
  const [hostQrUrl, setHostQrUrl] = useState('');
  const [guestAnswerInput, setGuestAnswerInput] = useState('');
  // Manual LAN IP override. When set, the host injects IP-based ICE candidates
  // into its SDP so the guest can reach it on networks where mDNS is blocked
  // (mobile hotspots, restrictive routers). Empty = rely on mDNS + STUN only.
  const [manualHostIp, setManualHostIp] = useState('');
  const webrtcHostRef = useRef<WebRTCNetHost | null>(null);
  const startedRef = useRef(false);

  // ---- Guest state ----
  // Phase: 'idle' (paste host code) → 'answer' (showing answer, waiting for host to apply) → 'connected'
  const [guestPhase, setGuestPhase] = useState<'idle' | 'answer'>('idle');
  const [hostCodeInput, setHostCodeInput] = useState('');
  const [guestCode, setGuestCode] = useState('');
  const [guestQrUrl, setGuestQrUrl] = useState('');
  // Manual guest LAN IP — symmetric to the host's manualHostIp. When set, we
  // inject IP-based ICE candidates into the answer SDP so the host can reach
  // us on networks where mDNS is blocked (mobile hotspots, restrictive
  // routers). Empty = rely on mDNS + STUN only.
  const [manualGuestIp, setManualGuestIp] = useState('');
  const webrtcGuestRef = useRef<WebRTCNetGuest | null>(null);

  // ---- Network status & IP detection (shared) ----
  // "Force offline" lets the user tell us "I'm on a hotspot without internet,
  // skip STUN entirely" — even if mobile data is on and navigator.onLine is
  // true. This is the key toggle for "phone-as-hotspot" play where the
  // hotspot device has no upstream internet.
  const [forceOffline, setForceOffline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' && !navigator.onLine
  );
  // Auto-detected local IPs from the WebRTC ICE candidate trick. Empty array
  // = Chrome mDNS obfuscation blocked detection (the user must enter their IP
  // manually using the quick-pick buttons or instructions).
  const [detectedIps, setDetectedIps] = useState<string[]>([]);
  const [detectingIps, setDetectingIps] = useState(false);
  // Toggle for showing the troubleshooting panel. Closed by default to keep
  // the UI clean; opens automatically when the user clicks "Regenerate" or
  // when a connection attempt fails.
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);

  // Online/offline status badge — reflects the effective status (offline if
  // navigator.onLine is false OR the user toggled forceOffline).
  const effectiveStatus = getNetworkStatus(forceOffline);

  // Run IP detection. We auto-run once on mount so the user immediately sees
  // suggestions, and re-run when the user clicks "Detect my IP".
  const runDetectIps = async () => {
    setDetectingIps(true);
    try {
      const ips = await detectLocalIps();
      setDetectedIps(ips);
      if (ips.length > 0) {
        console.log('[LAN] Detected local IPs:', ips);
      } else {
        console.log('[LAN] No raw IPs detected (Chrome mDNS obfuscation likely active). User must enter IP manually.');
      }
    } catch (e) {
      console.warn('[LAN] IP detection failed:', e);
    } finally {
      setDetectingIps(false);
    }
  };

  useEffect(() => {
    runDetectIps();
  }, []);

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
    setStatusText(forceOffline
      ? 'Gathering ICE candidates (offline mode — should be fast)...'
      : 'Gathering ICE candidates (up to 10s for STUN)...');
    try {
      const id = `host-${Math.random().toString(36).slice(2, 8)}`;
      const host = new WebRTCNetHost(id, { forceOffline });
      webrtcHostRef.current = host;
      host.onPeerChange((peers) => {
        if (peers.length > 0 && !startedRef.current) {
          startedRef.current = true;
          setStatus('connected');
          (window as any).__bounceroyale_pendingNet = host;
          onStart(host, timer);
        }
      });
      // Pass the manual IP (if any) so the host injects IP-based ICE candidates
      // into the offer SDP. This is what makes the connection work on mobile
      // hotspots where mDNS is blocked. Empty string = mDNS + STUN only.
      const ip = manualHostIp.trim();
      const code = await host.createOffer(ip || undefined);
      setHostCode(code);
      setHostPhase('waiting');
      setStatus('connecting');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to start hosting');
      webrtcHostRef.current?.close();
      webrtcHostRef.current = null;
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  };

  const applyGuestAnswer = async () => {
    if (!webrtcHostRef.current || !guestAnswerInput.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await webrtcHostRef.current.acceptAnswer(guestAnswerInput.trim());
      // Status will switch to 'connected' via onPeerChange when the data channel opens.
      // If ICE fails (e.g. on a hotspot with the wrong manual IP), the host's
      // PC will eventually hit `failed` and the data channel won't open. The
      // user will see "waiting for guest..." forever. We surface a hint after
      // a few seconds so they know to regenerate.
      window.setTimeout(() => {
        if (status !== 'connected' && !startedRef.current) {
          setError(prev => prev ?? 'Connection is taking longer than expected. If it doesn\'t connect within a few more seconds, click "Regenerate invite code" and have the guest re-join with the new code.');
          setShowTroubleshooting(true);
        }
      }, 8000);
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to apply guest answer. Make sure you pasted the full code.';
      setError(msg);
      setShowTroubleshooting(true);
      // If the error indicates the PC is in a wrong state or was already torn
      // down, surface a "regenerate" hint — the user needs a fresh invite code.
      if (msg.includes('wrong state') || msg.includes('No pending') || msg.includes('Cannot apply')) {
        setError(prev => prev + ' Click "Regenerate invite code" below to start fresh.');
      }
    } finally {
      setBusy(false);
    }
  };

  /** Regenerate the host's invite code after a failed attempt. Tears down any
   *  stale PC and creates a fresh one with a new peerId. The user must give
   *  the new code to the guest and have them re-join. */
  const regenerateInvite = async () => {
    if (!webrtcHostRef.current) return;
    setError(null);
    setBusy(true);
    setStatusText(forceOffline
      ? 'Gathering ICE candidates (offline mode — should be fast)...'
      : 'Gathering ICE candidates (up to 10s for STUN)...');
    try {
      const code = await webrtcHostRef.current.regenerateOffer();
      setHostCode(code);
      setGuestAnswerInput('');
      setStatus('connecting');
      console.log('[HOST] Regenerated invite code');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to regenerate invite code');
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  };

  // ===========================================================================
  // Guest actions
  // ===========================================================================

  const generateAnswer = async () => {
    if (!hostCodeInput.trim()) return;
    setError(null);
    setBusy(true);
    setStatusText(forceOffline
      ? 'Gathering ICE candidates (offline mode — should be fast)...'
      : 'Gathering ICE candidates (up to 10s for STUN)...');
    try {
      const id = `g-${Math.random().toString(36).slice(2, 9)}`;
      const guest = new WebRTCNetGuest(id, { forceOffline });
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
      const answer = await guest.acceptOffer(hostCodeInput.trim(), manualGuestIp.trim() || undefined);
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
      setStatusText(null);
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

        {/* ============ Network status banner (always visible) ============ */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          padding: '0.5rem 0.75rem',
          marginBottom: '0.6rem',
          borderRadius: '8px',
          background: effectiveStatus === 'offline'
            ? 'rgba(245, 158, 11, 0.12)'
            : 'rgba(34, 197, 94, 0.12)',
          border: `1px solid ${effectiveStatus === 'offline' ? 'rgba(245, 158, 11, 0.35)' : 'rgba(34, 197, 94, 0.35)'}`,
          fontSize: '0.85rem',
          flexWrap: 'wrap',
        }}>
          <span className="dot" style={{
            background: effectiveStatus === 'offline' ? '#f59e0b' : '#22c55e',
            width: 8, height: 8, borderRadius: '50%',
            display: 'inline-block',
            animation: 'pulse 2s infinite',
          }} />
          <strong style={{ marginRight: '0.25rem' }}>
            {effectiveStatus === 'offline' ? '📱 Offline / Hotspot mode' : '🌐 Online mode'}
          </strong>
          <span style={{ color: 'var(--text-dim)', flex: 1, minWidth: '180px' }}>
            {effectiveStatus === 'offline'
              ? 'STUN skipped — mDNS + manual IP only (fast on hotspot).'
              : 'STUN enabled — works on normal Wi-Fi.'}
          </span>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            cursor: 'pointer', fontSize: '0.8rem', userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={forceOffline}
              onChange={(e) => setForceOffline(e.target.checked)}
              style={{ width: 'auto', padding: 0 }}
            />
            Force offline
          </label>
        </div>

        {/* ============ Detected IPs panel (always visible) ============ */}
        <div style={{
          padding: '0.5rem 0.75rem',
          marginBottom: '0.6rem',
          borderRadius: '8px',
          background: 'rgba(56, 189, 248, 0.08)',
          border: '1px solid rgba(56, 189, 248, 0.25)',
          fontSize: '0.85rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
            <strong>🔍 Detected IPs:</strong>
            <button
              className="ghost"
              style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', minHeight: 'auto', marginLeft: 'auto' }}
              onClick={runDetectIps}
              disabled={detectingIps}
            >
              {detectingIps ? '…' : '↻ Re-detect'}
            </button>
          </div>
          {detectedIps.length > 0 ? (
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {detectedIps.map((ip) => (
                <button
                  key={ip}
                  className="ghost"
                  style={{ padding: '0.25rem 0.7rem', fontSize: '0.8rem', minHeight: 'auto' }}
                  onClick={() => {
                    // Click a detected IP to fill whichever field is relevant
                    // for the current tab. On the host tab → fills host IP.
                    // On the join tab → fills guest IP. On the menu → no-op.
                    if (tab === 'host') setManualHostIp(ip);
                    else if (tab === 'join') setManualGuestIp(ip);
                  }}
                  title="Click to use this IP"
                >
                  {ip}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-dim" style={{ fontSize: '0.78rem' }}>
              No raw IPs detected (Chrome mDNS hides them). Use the quick-pick buttons below or enter your IP manually.
            </div>
          )}
        </div>

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

            {/* Hotspot quick guide — only show when in offline mode */}
            {effectiveStatus === 'offline' && (
              <div style={{
                padding: '0.6rem 0.75rem',
                borderRadius: '8px',
                background: 'rgba(192, 132, 252, 0.08)',
                border: '1px solid rgba(192, 132, 252, 0.3)',
                fontSize: '0.82rem',
                marginTop: '0.4rem',
              }}>
                <strong style={{ display: 'block', marginBottom: '0.35rem' }}>📱 Hotspot quick start</strong>
                <ol style={{ paddingLeft: '1.2rem', margin: 0, lineHeight: 1.5 }}>
                  <li><strong>Phone A</strong> (the hotspot host): enable mobile hotspot, open this game, click <em>Host Game</em>, enter <code>192.168.43.1</code> (Android) or <code>172.20.10.1</code> (iOS) as your LAN IP, click <em>Start Hosting</em>.</li>
                  <li><strong>Phone B</strong> (connected to Phone A's hotspot): open this game, click <em>Join Game</em>, paste the host's invite code, click <em>Generate Answer</em>. Your own IP is optional — ICE will discover it automatically.</li>
                  <li>Send the answer code back to Phone A. Phone A pastes it and clicks <em>Connect</em>. Done!</li>
                </ol>
              </div>
            )}

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
                {/* Manual host IP — needed when playing over a mobile hotspot
                    or any network where Chrome's mDNS anti-fingerprinting
                    blocks local-IP candidates. The host enters its OWN LAN IP
                    (NOT the gateway/router IP — those are different numbers).
                    On Windows, run `ipconfig` and look for the adapter you're
                    using (e.g. Wi-Fi); the line "IPv4 Address" is your IP.
                    On Android hotspot host: 192.168.43.1.
                    On iOS hotspot host: 172.20.10.1.
                    We inject that IP into the offer SDP as extra ICE
                    candidates so the guest can reach it directly. Leave
                    blank to rely on mDNS + STUN (works on normal Wi-Fi). */}
                <div className="setting-row">
                  <label>🌐 Host LAN IP (optional — for hotspot)</label>
                  <input
                    type="text"
                    value={manualHostIp}
                    onChange={(e) => setManualHostIp(e.target.value)}
                    placeholder="e.g. 192.168.43.1 (Android) or 172.20.10.1 (iOS)"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {/* Quick-pick buttons for common hotspot host IPs. The
                      hotspot host's IP is ALWAYS the same predictable value
                      (192.168.43.1 on Android, 172.20.10.1 on iOS, etc.) so
                      we can offer these as one-click shortcuts. */}
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                    {COMMON_HOTSPOT_HOST_IPS.map((entry) => (
                      <button
                        key={entry.ip}
                        className="ghost"
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', minHeight: 'auto' }}
                        onClick={() => setManualHostIp(entry.ip)}
                        title={entry.label}
                      >
                        {entry.ip}
                      </button>
                    ))}
                  </div>
                  <div className="text-dim" style={{ fontSize: '0.75rem', marginTop: '0.4rem' }}>
                    <strong>Enter your OWN device's IP — NOT the gateway/router IP.</strong>
                    <br />
                    On Windows: run <code>ipconfig</code> and look at the
                    "IPv4 Address" line of the adapter you're using (e.g.
                    Wi-Fi). If you see a "Default Gateway" line below it,
                    that's a DIFFERENT IP — don't enter it here.
                    <br />
                    On the host of an Android hotspot: <code>192.168.43.1</code>.
                    On the host of an iOS hotspot: <code>172.20.10.1</code>.
                    On Windows Mobile Hotspot: <code>192.168.137.1</code>.
                    <br />
                    Leave blank on normal Wi-Fi.
                  </div>
                </div>
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

                {/* Regenerate button — shown whenever we're waiting for a
                    connection. Clicking it tears down the current PC (which
                    may have failed ICE, may be in a wrong state, or may just
                    be stuck) and creates a fresh offer with a new peerId.
                    The user must then re-share the new invite code with the
                    guest and have them re-join. */}
                <button
                  className="ghost mt-1"
                  style={{ width: '100%' }}
                  onClick={regenerateInvite}
                  disabled={busy}
                  title="Tear down the current connection attempt and create a fresh invite code. Use this if Connect isn't doing anything, if you got a 'wrong state' error, or if ICE failed."
                >
                  {busy ? '…' : '🔄 Regenerate invite code'}
                </button>
                <div className="text-dim" style={{ fontSize: '0.75rem', marginTop: '0.4rem', textAlign: 'center' }}>
                  If Connect isn't working (e.g. wrong-state error, no pending offer,
                  or it just hangs), click this to start fresh. You'll get a new
                  invite code — give it to the guest and have them re-join.
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
                {/* Manual guest LAN IP — symmetric to the host's field. On a
                    mobile hotspot, the guest (often a phone) also needs to
                    provide a working IP candidate because Chrome's mDNS
                    anti-fingerprinting blocks local-IP candidates and STUN
                    can't reach the internet through the hotspot. Find this
                    device's IP in its Wi-Fi settings (e.g. on Android:
                    Settings → Wi-Fi → tap the network → Advanced → IP
                    address; on iOS: Settings → Wi-Fi → tap (i) next to the
                    network → IP Address). */}
                <div className="setting-row" style={{ marginTop: '0.75rem' }}>
                  <label>🌐 Your LAN IP (optional — usually not needed)</label>
                  <input
                    type="text"
                    value={manualGuestIp}
                    onChange={(e) => setManualGuestIp(e.target.value)}
                    placeholder="e.g. 10.181.207.148 (find in this device's Wi-Fi settings)"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {/* If we auto-detected IPs, offer them as quick-pick here too. */}
                  {detectedIps.length > 0 && (
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                      {detectedIps.map((ip) => (
                        <button
                          key={ip}
                          className="ghost"
                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.78rem', minHeight: 'auto' }}
                          onClick={() => setManualGuestIp(ip)}
                          title="Click to use this IP"
                        >
                          {ip}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="text-dim" style={{ fontSize: '0.75rem', marginTop: '0.4rem' }}>
                    Usually leave blank — ICE discovers your IP automatically
                    from the host's connectivity checks (peer-reflexive
                    candidates). Only set this if connection fails AND you're
                    on a restrictive hotspot.
                  </div>
                </div>
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

        {statusText && (
          <div style={{
            marginTop: '0.5rem',
            padding: '0.5rem 0.75rem',
            background: 'rgba(100, 150, 255, 0.1)',
            borderRadius: '6px',
            fontSize: '0.85rem',
            color: 'var(--text-dim)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}>
            <span className="dot" style={{ animation: 'pulse 1s infinite' }} />
            {statusText}
          </div>
        )}
        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}

        {/* ============ Troubleshooting panel (collapsible) ============ */}
        <div style={{ marginTop: '0.6rem' }}>
          <button
            className="ghost"
            style={{ width: '100%', fontSize: '0.85rem', padding: '0.5rem 0.75rem', minHeight: 'auto' }}
            onClick={() => setShowTroubleshooting((v) => !v)}
          >
            {showTroubleshooting ? '▼ Hide troubleshooting' : '▶ Connection not working? Show troubleshooting'}
          </button>
          {showTroubleshooting && (
            <div style={{
              marginTop: '0.4rem',
              padding: '0.75rem',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.06)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              fontSize: '0.82rem',
              lineHeight: 1.55,
            }}>
              <strong style={{ display: 'block', marginBottom: '0.4rem' }}>🛠 Common causes & fixes</strong>
              <ol style={{ paddingLeft: '1.2rem', margin: 0 }}>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Host's firewall is blocking inbound UDP.</strong> The
                  host (especially a Windows laptop) MUST allow Chrome through
                  the firewall for inbound UDP on private networks. On Windows:
                  <br />
                  → Control Panel → Windows Defender Firewall → Allow an app
                  → find "Google Chrome" → tick both <em>Private</em> AND
                  <em>Public</em> → OK. Then fully close Chrome and reopen.
                  <br />
                  <em>Or</em>: have the PHONE be the host (phones don't have
                  software firewalls) and the laptop be the guest.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Host didn't enter its manual LAN IP on a hotspot.</strong>
                  On a phone-hotspot network, mDNS hostnames don't resolve
                  cross-device. The host MUST enter its own LAN IP (use the
                  quick-pick buttons or run <code>ipconfig</code> on Windows).
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>"Force offline" not ticked on a hotspot.</strong>
                  If the hotspot has no internet, STUN servers can't be
                  reached and ICE gathering blocks for ~10 seconds. Tick
                  "Force offline" at the top of this modal to skip STUN and
                  get the invite code in &lt;1 second.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Wrong IP entered.</strong> The host's IP must be the
                  one on the hotspot network (e.g. <code>10.181.207.139</code>),
                  NOT the public IP, NOT the gateway IP. On Windows run
                  <code>ipconfig</code> in cmd and look at "IPv4 Address" of
                  the Wi-Fi adapter connected to the hotspot.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Guest connected to a different network.</strong> Both
                  devices must be on the SAME hotspot. Check the guest's IP is
                  in the same subnet as the host (e.g. both 10.181.207.x).
                </li>
                <li>
                  <strong>Browser is blocking mDNS.</strong> Chrome's
                  anti-fingerprinting hides local IPs as <code>*.local</code>
                  hostnames that don't resolve across devices. Use the manual
                  IP field. Firefox and Safari are more permissive.
                </li>
              </ol>
              <div style={{ marginTop: '0.6rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <strong>📋 Diagnostic checklist:</strong>
                <ul style={{ paddingLeft: '1.2rem', marginTop: '0.3rem' }}>
                  <li>Open the browser console (F12) on BOTH devices and look for
                    <code>[HOST]</code> / <code>[GUEST]</code> / <code>[WebRTC]</code> log lines.</li>
                  <li>Look for "Rewrote N mDNS candidate(s) in SDP to use manual IP" — confirms the manual IP was injected.</li>
                  <li>Look for "ICE State: checking → disconnected → failed" — means the candidate was tried but the packets didn't get through (usually a firewall or wrong-IP issue).</li>
                  <li>If you see "ICE State: connected" briefly then "disconnected", the connection was established but flapped — usually a NAT/firewall timeout, try keeping the game open.</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
