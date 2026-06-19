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
import type { NetClient, NetEvent } from '../networking/types';
import QrScanner from './QrScanner';

type Tab = 'menu' | 'host' | 'join';

interface Props {
  onCancel: () => void;
  /**
   * Called when the player is ready to enter the game with a connected net
   * client. The Game component takes ownership of the client and will close
   * it on exit.
   *
   * For the host: called when the host clicks "Start Game" in the lobby (so
   * the lobby can collect as many guests as desired before the match begins).
   * For the guest: called when the guest receives a `start-countdown` message
   * from the host (i.e. the host clicked "Start Game").
   */
  onStart: (client: NetClient, startTimer: number) => void;
}

/**
 * LAN multiplayer modal — cross-device, pure WebRTC (no signaling server).
 *
 * Flow:
 *
 *   HOST
 *   1. Click "Start Hosting" → host's invite code (QR + text) appears.
 *   2. Guest scans/copies it → returns their answer code.
 *   3. Host pastes the answer → guest joins the LOBBY.
 *   4. (Optional) Host clicks "Invite another player" to generate a fresh
 *      invite code for guest 2, 3, … All connected guests stay connected.
 *   5. Host clicks "Start Game" → countdown begins for everyone.
 *
 *   GUEST
 *   1. Paste/scan the host's invite code → answer code (QR + text) appears.
 *   2. Send the answer back to the host → connected → enter LOBBY.
 *   3. Lobby shows the roster (host + all guests) and "waiting for host".
 *   4. When the host clicks "Start Game", the guest receives a
 *      `start-countdown` message → guest calls onStart → countdown begins.
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
  // Phase machine:
  //   'idle'     — before clicking Start Hosting
  //   'hosting'  — showing invite code, awaiting guest's answer
  //   'lobby'    — at least one guest connected; waiting for host to click "Start Game"
  const [hostPhase, setHostPhaseState] = useState<'idle' | 'hosting' | 'lobby'>('idle');
  // Ref mirror of hostPhase so async callbacks (the 8s timeout in
  // applyGuestAnswer, the onPeerChange callback) can read the CURRENT phase
  // instead of the stale closure value captured when they were created.
  const hostPhaseRef = useRef<'idle' | 'hosting' | 'lobby'>('idle');
  const setHostPhase = (p: 'idle' | 'hosting' | 'lobby' | ((prev: 'idle' | 'hosting' | 'lobby') => 'idle' | 'hosting' | 'lobby')) => {
    if (typeof p === 'function') {
      setHostPhaseState((prev) => {
        const next = p(prev);
        hostPhaseRef.current = next;
        return next;
      });
    } else {
      hostPhaseRef.current = p;
      setHostPhaseState(p);
    }
  };
  const [hostCode, setHostCode] = useState('');
  const [hostQrUrl, setHostQrUrl] = useState('');
  const [guestAnswerInput, setGuestAnswerInput] = useState('');
  // Manual LAN IP override. When set, the host injects IP-based ICE candidates
  // into its SDP so the guest can reach it on networks where mDNS is blocked
  // (mobile hotspots, restrictive routers). Empty = rely on mDNS + STUN only.
  const [manualHostIp, setManualHostIp] = useState('');
  const webrtcHostRef = useRef<WebRTCNetHost | null>(null);
  const startedRef = useRef(false);
  /** Tracks the most recent pending peerId the host invited, so we know which
   *  peer just connected when onPeerChange fires. Used for the "just joined"
   *  toast in the lobby UI. */
  const lastInvitePeerIdRef = useRef<string | null>(null);

  // ---- Guest state ----
  // Phase machine:
  //   'idle'   — paste host code
  //   'answer' — showing answer, waiting for host to apply it
  //   'lobby'  — connected; waiting for host to click "Start Game"
  const [guestPhase, setGuestPhase] = useState<'idle' | 'answer' | 'lobby'>('idle');
  const [hostCodeInput, setHostCodeInput] = useState('');
  const [guestCode, setGuestCode] = useState('');
  const [guestQrUrl, setGuestQrUrl] = useState('');
  // Manual guest LAN IP — symmetric to the host's manualHostIp. When set, we
  // inject IP-based ICE candidates into the answer SDP so the host can reach
  // us on networks where mDNS is blocked (mobile hotspots, restrictive
  // routers). Empty = rely on mDNS + STUN only.
  const [manualGuestIp, setManualGuestIp] = useState('');
  const webrtcGuestRef = useRef<WebRTCNetGuest | null>(null);

  // ---- Lobby roster (shared) ----
  // Host: built locally from dataChannels. Guest: received from host via
  // `peer-list` messages. Both render the same UI.
  const [peerList, setPeerList] = useState<{ id: string; isHost: boolean }[]>([]);

  // ---- QR scanner ----
  // When non-null, the QrScanner overlay is shown. The value indicates which
  // input field the decoded text should fill:
  //   'host-offer'  → guest scanning host's invite code → fills hostCodeInput
  //   'guest-answer' → host scanning guest's answer code → fills guestAnswerInput
  const [qrScannerTarget, setQrScannerTarget] = useState<'host-offer' | 'guest-answer' | null>(null);

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

  // Detect the user's OS so we can show targeted firewall instructions.
  // Windows is the most common case where the firewall blocks inbound UDP
  // and causes "ICE failed" errors on hotspot play.
  const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

  // Online/offline status badge — reflects the effective status (offline if
  // navigator.onLine is false OR the user toggled forceOffline).
  const effectiveStatus = getNetworkStatus(forceOffline);

  // "High-risk" scenario: the user is the HOST, on a desktop OS (Windows/Mac),
  // in offline/hotspot mode, AND has entered a manual IP. This is the scenario
  // where the firewall is most likely to block the connection. Show a prominent
  // warning banner AND auto-open the troubleshooting panel.
  const isHighRiskHost = tab === 'host' && manualHostIp.trim() && (isWindows || isMac);

  // Auto-open troubleshooting when the user is in the high-risk scenario,
  // so they see the firewall fix immediately without having to click.
  useEffect(() => {
    if (isHighRiskHost) setShowTroubleshooting(true);
  }, [isHighRiskHost]);

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

      // Register a message listener early so the host receives `peer-list`
      // broadcasts from itself (broadcastPeerList emits locally too) and
      // updates the lobby roster. This listener runs alongside the engine's
      // listener once the engine mounts.
      host.onMessage((ev: NetEvent) => {
        if (ev.type === 'peer-list') {
          setPeerList(ev.data.players);
        }
      });

      host.onPeerChange((peers) => {
        // Only count guests whose data channel is actually OPEN. During
        // regeneration or inviting another player, the new PC's data channel
        // is in "connecting" state — without this guard, the lobby would
        // spuriously add a "connecting" player to the roster.
        const openPeers = peers.filter((pid) => {
          const dc = (host as any).dataChannels?.get(pid);
          return dc && dc.readyState === 'open';
        });
        console.log('[HOST Lobby] onPeerChange:', peers.length, 'peers,', openPeers.length, 'open');
        // Update the local roster view. The host's own id is always first.
        setPeerList([
          { id: host.id, isHost: true },
          ...openPeers.map((pid) => ({ id: pid, isHost: false })),
        ]);
        // When at least one guest has an OPEN data channel, transition to the
        // LOBBY phase. We DO NOT call onStart here anymore — the host must
        // click "Start Game" in the lobby to begin the actual match. This
        // gives other guests time to join.
        //
        // Use a FUNCTIONAL state update so we don't capture a stale
        // `hostPhase` from this closure (which was created when startHost ran
        // and would always see `hostPhase = 'idle'`). The functional update
        // sees the latest state value at the time the callback fires, and
        // also keeps hostPhaseRef in sync.
        if (openPeers.length > 0) {
          setStatus('connected');
          setHostPhase((prev) => prev !== 'lobby' ? 'lobby' : prev);
        }
      });
      // Pass the manual IP (if any) so the host injects IP-based ICE candidates
      // into the offer SDP. This is what makes the connection work on mobile
      // hotspots where mDNS is blocked. Empty string = mDNS + STUN only.
      const ip = manualHostIp.trim();
      const code = await host.createOffer(ip || undefined);
      setHostCode(code);
      setHostPhase('hosting');
      setStatus('connecting');
      // Initialize the roster with just the host.
      setPeerList([{ id: host.id, isHost: true }]);
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
      // Once connected, the host transitions to the LOBBY phase (via onPeerChange),
      // where they can invite more players or click "Start Game".
      // If ICE fails (e.g. on a hotspot with the wrong manual IP), the host's
      // PC will eventually hit `failed` and the data channel won't open. We
      // surface a hint after a few seconds so they know to regenerate.
      window.setTimeout(() => {
        // Only show the error if we're still in 'hosting' phase (haven't
        // transitioned to lobby yet). If we're in lobby, the connection
        // succeeded. Use the ref so we see the CURRENT phase, not the stale
        // closure value.
        if (hostPhaseRef.current !== 'lobby' && !startedRef.current) {
          // Generate a targeted error message based on the user's setup.
          // The #1 cause is the host's firewall blocking inbound UDP.
          let msg = 'Connection failed — packets are not getting through.\n\n';
          if (isWindows || isMac) {
            msg += `⚠️ Most likely cause: your ${isWindows ? 'Windows' : 'macOS'} firewall is blocking inbound UDP.\n`;
            msg += `→ Fix A (easiest): Use a PHONE as the host instead of this laptop.\n`;
            msg += `→ Fix B: Allow your browser through the firewall (see troubleshooting panel below).\n\n`;
          }
          if (isIOS) {
            msg += `⚠️ iOS hotspots do NOT support device-to-device communication. Use an Android hotspot or a real router.\n\n`;
          }
          msg += 'Click "Regenerate invite code" to try again after fixing the issue.';
          setError(prev => prev ?? msg);
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

  /**
   * Generate a fresh invite code for an ADDITIONAL guest — without tearing
   * down any existing connections. This is the key action for 3+ device play:
   * the host already has guest 1 connected (and in the lobby), and now wants
   * to invite guest 2.
   *
   * After clicking, the host's UI switches back to the 'hosting' phase (showing
   * the new invite code + awaiting the new guest's answer). When guest 2
   * connects, the UI returns to the lobby, now showing both guests in the
   * roster.
   */
  const inviteAnotherPlayer = async () => {
    if (!webrtcHostRef.current) return;
    setError(null);
    setBusy(true);
    setStatusText(forceOffline
      ? 'Gathering ICE candidates (offline mode — should be fast)...'
      : 'Gathering ICE candidates (up to 10s for STUN)...');
    try {
      const code = await webrtcHostRef.current.createAnotherOffer();
      setHostCode(code);
      setGuestAnswerInput('');
      // Transition back to 'hosting' so the host sees the new invite code
      // and can paste the new guest's answer. The existing guests stay
      // connected and remain in the roster.
      setHostPhase('hosting');
      setStatus('connecting');
      console.log('[HOST] Generated invite code for an additional player.');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to generate a new invite code');
    } finally {
      setBusy(false);
      setStatusText(null);
    }
  };

  /**
   * Host clicked "Start Game" in the lobby. Broadcasts a `start-countdown`
   * message to all connected guests (so they transition from their lobby
   * view into the actual game), then calls onStart locally.
   *
   * The host's own engine is created when onStart is called — at that point
   * the engine's start() generates the island, sends `init` to all guests
   * (with serverStartTime), and the countdown begins on every peer.
   */
  const startGameFromLobby = () => {
    if (!webrtcHostRef.current || startedRef.current) return;
    // Need at least 2 players (host + 1 guest) to start a meaningful game.
    const connectedGuests = peerList.filter((p) => !p.isHost).length;
    if (connectedGuests < 1) {
      setError(t('lobbyNeedPlayers', lang));
      return;
    }
    startedRef.current = true;
    const host = webrtcHostRef.current;
    // Tell all guests to start their countdown. Guests' LanModal receives
    // this and calls their own onStart → engine mounts → guest receives init
    // from host's engine → countdown begins.
    host.broadcastStartCountdown(timer);
    // Stash the host on the global slot so the Game component can pick it up.
    (window as any).__bounceroyale_pendingNet = host;
    setStatus('connected');
    onStart(host, timer);
  };

  /** Regenerate the host's invite code after a failed attempt. Tears down any
   *  stale PC and creates a fresh one with a new peerId. The user must give
   *  the new code to the guest and have them re-join. */
  const regenerateInvite = async () => {
    if (!webrtcHostRef.current) return;
    setError(null);
    setBusy(true);
    // CRITICAL: Reset the startedRef so that when a new guest connects with
    // the regenerated code, onPeerChange can fire onStart again. Without this
    // reset, if the first attempt briefly opened a data channel (setting
    // startedRef=true) before failing, the regenerated connection would never
    // trigger onStart and the user would be stuck.
    startedRef.current = false;
    setStatus('idle');
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
      guest.onMessage((ev: NetEvent) => {
        if (ev.type === 'open') {
          // Data channel opened — we're connected to the host. Transition to
          // the LOBBY phase. We DO NOT call onStart yet — the host hasn't
          // clicked "Start Game" so there's no engine to mount. Wait for the
          // host's `start-countdown` message.
          console.log('[GUEST Lobby] Data channel OPEN — entering lobby phase.');
          setStatus('connected');
          setGuestPhase('lobby');
          // Stash the guest on the global slot so the Game component can pick
          // it up when onStart is called later.
          (window as any).__bounceroyale_pendingNet = guest;
          webrtcGuestRef.current = null;
        } else if (ev.type === 'peer-list') {
          // Host broadcast the lobby roster — update the local view.
          setPeerList(ev.data.players);
        } else if (ev.type === 'start-countdown' && !startedRef.current) {
          // Host clicked "Start Game" — transition into the actual game.
          // The host's engine will send us an `init` message shortly (with
          // the island seed + serverStartTime) which the engine processes to
          // generate the island and start the countdown.
          console.log('[GUEST Lobby] Received start-countdown from host. startTimer=', ev.data.startTimer);
          startedRef.current = true;
          onStart(guest, ev.data.startTimer);
        } else if (ev.type === 'close' && !startedRef.current) {
          // Host disconnected during the lobby (e.g. host closed their tab or
          // went back to menu). Surface a clear error and let the guest go
          // back to the menu to try again.
          console.log('[GUEST Lobby] Connection to host lost.');
          setError('Lost connection to the host. They may have left the lobby. Click Back to return to the menu.');
          setStatus('idle');
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
    setPeerList([]);
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

                {/* ===== Firewall warning for desktop hosts on hotspot =====
                    When the host is a Windows/Mac laptop on a phone hotspot
                    with a manual IP, the #1 cause of "ICE failed" is the
                    laptop's firewall blocking inbound UDP. We can't fix the
                    firewall from JS — the user MUST allow Chrome through.
                    This banner makes that crystal clear BEFORE they click
                    "Start Hosting" so they don't waste time on a connection
                    that's doomed to fail. */}
                {isHighRiskHost && (
                  <div style={{
                    marginTop: '0.6rem',
                    padding: '0.75rem',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    fontSize: '0.82rem',
                    lineHeight: 1.55,
                  }}>
                    <strong style={{ display: 'block', marginBottom: '0.35rem', color: '#fca5a5' }}>
                      ⚠️ {isWindows ? 'Windows Firewall' : 'macOS Firewall'} will likely block this connection!
                    </strong>
                    <p style={{ margin: '0 0 0.5rem 0' }}>
                      You're hosting from a <strong>{isWindows ? 'Windows' : 'Mac'}</strong> laptop on a
                      phone hotspot. The laptop's firewall blocks inbound UDP by default, which means the
                      guest's phone CANNOT send packets to your laptop — even with the correct IP.
                    </p>
                    <p style={{ margin: '0 0 0.5rem 0' }}>
                      <strong>You have two options:</strong>
                    </p>
                    <ol style={{ paddingLeft: '1.2rem', margin: '0 0 0.5rem 0' }}>
                      <li style={{ marginBottom: '0.3rem' }}>
                        <strong>Recommended: use a PHONE as the host instead.</strong> Phones don't have
                        software firewalls, so connections just work. Open the game on a phone connected to
                        the hotspot, click "Host Game" there, and use this laptop as the guest.
                      </li>
                      <li>
                        <strong>{isWindows ? 'Allow Chrome through Windows Firewall' : 'Allow Chrome through macOS Firewall'}:</strong>
                        {isWindows ? (
                          <>
                            <br />
                            → Control Panel → Windows Defender Firewall → "Allow an app through Windows Firewall"
                            <br />
                            → Find "Google Chrome" (or "Microsoft Edge") → tick <strong>Private</strong> AND <strong>Public</strong>
                            <br />
                            → Click OK → <strong>fully close and reopen</strong> your browser
                          </>
                        ) : (
                          <>
                            <br />
                            → System Settings → Network → Firewall → Options
                            <br />
                            → Add your browser to the "Allow incoming connections" list
                          </>
                        )}
                      </li>
                    </ol>
                    <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                      💡 Also verify: some phone hotspots have "AP Isolation" which blocks all inter-device
                      communication. iOS Personal Hotspot does NOT support device-to-device communication at
                      all — if your hotspot is an iPhone, hotspot LAN play is impossible. Use an Android
                      hotspot or a real router instead.
                    </p>
                  </div>
                )}

                <div className="actions">
                  <button className="ghost" onClick={backToMenu}>{t('back', lang)}</button>
                  <button className="primary" onClick={startHost} disabled={busy}>
                    {busy ? '…' : `📡 ${t('startHost', lang)}`}
                  </button>
                </div>
              </>
            )}

            {hostPhase === 'hosting' && (
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
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                  <button
                    className="primary"
                    style={{ flex: 1 }}
                    onClick={applyGuestAnswer}
                    disabled={!guestAnswerInput.trim() || busy}
                  >
                    {busy ? '…' : `✓ ${t('connect', lang)}`}
                  </button>
                  <button
                    className="ghost"
                    style={{ flex: '0 0 auto' }}
                    onClick={() => setQrScannerTarget('guest-answer')}
                    disabled={busy}
                    title={t('scanAnswer', lang)}
                  >
                    📷 {t('scanQr', lang)}
                  </button>
                </div>

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
                  {busy ? '…' : `🔄 ${t('regenerateInvite', lang)}`}
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

            {hostPhase === 'lobby' && (
              <>
                <h3>🎮 {t('lobbyTitle', lang)}</h3>
                <p className="text-dim" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
                  {t('lobbyWaitingGuests', lang)}
                </p>

                {/* Player roster */}
                <div style={{
                  padding: '0.75rem',
                  marginBottom: '0.75rem',
                  borderRadius: '8px',
                  background: 'rgba(34, 197, 94, 0.08)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                }}>
                  <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                    👥 {t('lobbyPlayers', lang)} ({peerList.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {peerList.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.4rem 0.6rem',
                          background: 'rgba(255,255,255,0.04)',
                          borderRadius: '6px',
                          fontSize: '0.85rem',
                        }}
                      >
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: p.isHost ? '#ffd700' : '#4ade80',
                          display: 'inline-block',
                          flexShrink: 0,
                        }} />
                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', flex: 1 }}>
                          {p.id.slice(0, 12)}
                        </span>
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.1rem 0.4rem',
                          borderRadius: '4px',
                          background: p.isHost ? 'rgba(255, 215, 0, 0.15)' : 'rgba(74, 222, 128, 0.15)',
                          color: p.isHost ? '#ffd700' : '#4ade80',
                        }}>
                          {p.isHost ? t('lobbyHost', lang) : t('lobbyGuest', lang)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Timer slider — host can still adjust the countdown length
                    before starting the game. */}
                <TimerSlider />

                {/* Action buttons: Invite more players + Start Game */}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                  <button
                    className="ghost"
                    style={{ flex: 1 }}
                    onClick={inviteAnotherPlayer}
                    disabled={busy}
                    title={t('lobbyInviteMore', lang)}
                  >
                    {busy ? '…' : `➕ ${t('lobbyInviteMoreShort', lang)}`}
                  </button>
                  <button
                    className="primary"
                    style={{ flex: 1.4, fontSize: '1rem', fontWeight: 700 }}
                    onClick={startGameFromLobby}
                    disabled={busy || peerList.filter((p) => !p.isHost).length < 1}
                    title={t('lobbyStartHint', lang)}
                  >
                    ▶ {t('lobbyStartGame', lang)}
                  </button>
                </div>
                {peerList.filter((p) => !p.isHost).length < 1 && (
                  <div className="text-dim" style={{ fontSize: '0.75rem', marginTop: '0.4rem', textAlign: 'center' }}>
                    {t('lobbyNeedPlayers', lang)}
                  </div>
                )}

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
                {/* QR scanner button — opens the camera so the guest can scan
                    the host's invite QR code directly, without needing an
                    external scanner app. The decoded text fills the textarea
                    above. */}
                <button
                  className="ghost mt-1"
                  style={{ width: '100%' }}
                  onClick={() => setQrScannerTarget('host-offer')}
                  disabled={busy}
                  title={t('scanInvite', lang)}
                >
                  📷 {t('scanQr', lang)}
                </button>
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

            {guestPhase === 'lobby' && (
              <>
                <h3>🎮 {t('lobbyTitle', lang)}</h3>
                <p className="text-dim" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
                  {t('lobbyWaitingHost', lang)}
                </p>

                {/* Player roster — same UI as the host's lobby, populated from
                    peer-list messages received from the host. */}
                <div style={{
                  padding: '0.75rem',
                  marginBottom: '0.75rem',
                  borderRadius: '8px',
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}>
                  <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                    👥 {t('lobbyPlayers', lang)} ({peerList.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {peerList.length === 0 && (
                      <div className="text-dim" style={{ fontSize: '0.8rem', padding: '0.3rem 0' }}>
                        {t('lobbyConnecting', lang)}
                      </div>
                    )}
                    {peerList.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.4rem 0.6rem',
                          background: 'rgba(255,255,255,0.04)',
                          borderRadius: '6px',
                          fontSize: '0.85rem',
                        }}
                      >
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: p.isHost ? '#ffd700' : '#4ade80',
                          display: 'inline-block',
                          flexShrink: 0,
                        }} />
                        <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', flex: 1 }}>
                          {p.id.slice(0, 12)}
                        </span>
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.1rem 0.4rem',
                          borderRadius: '4px',
                          background: p.isHost ? 'rgba(255, 215, 0, 0.15)' : 'rgba(74, 222, 128, 0.15)',
                          color: p.isHost ? '#ffd700' : '#4ade80',
                        }}>
                          {p.isHost ? t('lobbyHost', lang) : t('lobbyGuest', lang)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={`connection-status connected mt-2`}>
                  <span className="dot"></span>
                  {t('lobbyWaitingHost', lang)}
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
              <strong style={{ display: 'block', marginBottom: '0.4rem' }}>
                🛠 If ICE State goes "checking → disconnected → failed"
              </strong>
              <p style={{ margin: '0 0 0.5rem 0' }}>
                This means the two devices tried to connect but the network packets didn't get through.
                The cause is <strong>ALWAYS</strong> one of the following — check each one:
              </p>

              {/* Most common cause first */}
              <div style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '6px',
                padding: '0.5rem 0.6rem',
                marginBottom: '0.5rem',
              }}>
                <strong style={{ color: '#fca5a5' }}>
                  #1 cause (90% of failures): Host's firewall blocks inbound UDP
                </strong>
                <p style={{ margin: '0.3rem 0 0 0' }}>
                  You're hosting from a {isWindows ? 'Windows' : isMac ? 'Mac' : 'desktop'} {isWindows || isMac ? 'laptop' : 'device'}.
                  {isWindows ? ' Windows Defender Firewall' : isMac ? ' macOS Firewall' : ' The firewall'} blocks
                  inbound UDP by default. The guest's phone sends packets to your IP but they're silently
                  dropped. <strong>The browser CANNOT fix this — you must change a system setting.</strong>
                </p>
                <p style={{ margin: '0.4rem 0 0.2rem 0' }}><strong>Fix A (recommended): Use a PHONE as the host</strong></p>
                <ul style={{ paddingLeft: '1.2rem', margin: '0 0 0.4rem 0' }}>
                  <li>Phones don't have software firewalls — connections just work</li>
                  <li>Open the game on a phone connected to the hotspot, click "Host Game" there</li>
                  <li>Use this {isWindows ? 'laptop' : 'device'} as the guest instead</li>
                </ul>
                <p style={{ margin: '0.4rem 0 0.2rem 0' }}>
                  <strong>Fix B: Allow your browser through the firewall</strong>
                </p>
                {isWindows ? (
                  <ul style={{ paddingLeft: '1.2rem', margin: '0 0 0.4rem 0' }}>
                    <li>Win+R → type <code>control firewall.cpl</code> → Enter</li>
                    <li>Click "Allow an app or feature through Windows Defender Firewall"</li>
                    <li>Find "Google Chrome" (or your browser) → tick <strong>Private</strong> AND <strong>Public</strong></li>
                    <li>If Chrome isn't listed: "Allow another app" → browse to chrome.exe</li>
                    <li>Click OK → <strong>fully quit Chrome</strong> (right-click taskbar icon → Quit, or Ctrl+Shift+Q) → reopen</li>
                  </ul>
                ) : (
                  <ul style={{ paddingLeft: '1.2rem', margin: '0 0 0.4rem 0' }}>
                    <li>System Settings → Network → Firewall</li>
                    <li>Click the lock to make changes → enter admin password</li>
                    <li>Click "Firewall Options" → add your browser → set to "Allow incoming connections"</li>
                    <li>Click OK → <strong>fully quit and reopen</strong> your browser</li>
                  </ul>
                )}
              </div>

              <ol style={{ paddingLeft: '1.2rem', margin: 0 }}>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>iOS hotspot limitation.</strong> If the hotspot is an iPhone's "Personal Hotspot",
                  devices connected to it <strong>CANNOT communicate with each other</strong>. This is an Apple
                  limitation — iOS hotspots only provide internet access, not LAN connectivity. Use an Android
                  hotspot or a real Wi-Fi router instead.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>AP Isolation on the hotspot.</strong> Some Android hotspots (especially Samsung/Xiaomi)
                  enable "AP Isolation" which blocks inter-device communication. Check your hotspot settings for
                  an option like "Allow connected devices to share files" or "AP isolation" and disable it.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Wrong IP entered.</strong> The host's IP must be the one on the hotspot network (e.g.
                  <code>10.181.207.139</code>), NOT the public IP, NOT the gateway IP. On Windows run
                  <code>ipconfig</code> and look at "IPv4 Address" of the Wi-Fi adapter connected to the hotspot.
                  If you see multiple adapters, pick the one whose "Default Gateway" is the hotspot phone's IP.
                </li>
                <li style={{ marginBottom: '0.4rem' }}>
                  <strong>Guest on a different network.</strong> Both devices must be on the SAME hotspot. Check
                  the guest's IP is in the same subnet as the host (e.g. both 10.181.207.x).
                </li>
                <li>
                  <strong>Guest should also provide its IP (advanced).</strong> If the host's firewall is open
                  but the connection still fails, the guest can ALSO enter its own LAN IP (on the Join tab).
                  This gives ICE an extra candidate pair to try. The guest's IP is visible in its Wi-Fi settings
                  or via the "Detected IPs" panel at the top of this modal.
                </li>
              </ol>

              <div style={{ marginTop: '0.6rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <strong>📋 How to read the console logs (F12):</strong>
                <ul style={{ paddingLeft: '1.2rem', marginTop: '0.3rem' }}>
                  <li><code>"Rewrote N mDNS candidate(s) in SDP to use manual IP"</code> — confirms the manual IP was injected into the SDP ✓</li>
                  <li><code>"Guest answer candidates (N):"</code> — shows what candidates the host received from the guest. If all are <code>[✗] mDNS does NOT resolve cross-device</code>, the guest needs to provide its IP too.</li>
                  <li><code>"ICE State: checking → disconnected → failed"</code> — packets didn't get through. 90% chance it's the firewall (see #1 above).</li>
                  <li><code>"ICE State: connected"</code> then <code>"disconnected"</code> — connection flapped, usually a NAT timeout. Try keeping the game open longer.</li>
                  <li><code>"selected ICE pair:"</code> — if you see this, ICE succeeded! The connection is working.</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============ QR Scanner overlay ============ */}
      {/* Rendered on top of the modal when the user clicks "📷 Scan QR". The
          scanner decodes a QR code from the device's camera and fills the
          relevant input field, then closes. */}
      {qrScannerTarget && (
        <QrScanner
          title={qrScannerTarget === 'host-offer' ? t('scanInvite', lang) : t('scanAnswer', lang)}
          onDecode={(text) => {
            // Fill the appropriate input field based on which scan button
            // was clicked.
            if (qrScannerTarget === 'host-offer') {
              setHostCodeInput(text);
            } else {
              setGuestAnswerInput(text);
            }
            setQrScannerTarget(null);
          }}
          onClose={() => setQrScannerTarget(null)}
        />
      )}
    </div>
  );
}
