import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import {
  PeerNetHost,
  PeerNetGuest,
  PeerSetupError,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
} from '../networking/peerjs';
import type { NetClient, NetEvent } from '../networking/types';

type Tab = 'menu' | 'host' | 'join';
type Peer = { id: string; isHost: boolean };

interface Props {
  onCancel: () => void;
  /** Same contract as LanModal: called when the match should begin. */
  onStart: (client: NetClient, startTimer: number) => void;
  /** Switch to the manual offer/answer flow (no internet needed). */
  onOffline: () => void;
}

/**
 * Short-code LAN modal.
 *
 *   HOST: tap "Host Game" → a 5-char room code appears immediately → guests
 *         show up in the roster → "Start Game".
 *   GUEST: tap "Join Game" → type the code → lobby → host starts the match.
 *
 * Transport lives in networking/peerjs.ts. Handoff to Game is identical to
 * LanModal: the connected client is parked on window.__bounceroyale_pendingNet
 * and onStart switches to the game screen.
 */
export default function LanCodeModal({ onCancel, onStart, onOffline }: Props) {
  const { language } = useSettings();
  const lang = language;

  const [tab, setTab] = useState<Tab>('menu');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [timer, setTimer] = useState(30);
  const [peerList, setPeerList] = useState<Peer[]>([]);

  const [roomCode, setRoomCode] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [inLobby, setInLobby] = useState(false);

  const hostRef = useRef<PeerNetHost | null>(null);
  const guestRef = useRef<PeerNetGuest | null>(null);
  const startedRef = useRef(false);

  const describeError = (e: unknown): string => {
    if (e instanceof PeerSetupError) {
      if (e.kind === 'not-found') return t('lanRoomNotFound', lang);
      if (e.kind === 'host-unreachable') return t('lanHostUnreachable', lang);
      if (e.kind === 'broker' || e.kind === 'timeout') return t('lanBrokerError', lang);
      return e.message;
    }
    return (e as any)?.message ?? 'Connection error';
  };

  const teardown = () => {
    hostRef.current?.close();
    hostRef.current = null;
    guestRef.current?.close();
    guestRef.current = null;
    if ((window as any).__bounceroyale_pendingNet) (window as any).__bounceroyale_pendingNet = null;
  };

  // Close any half-open session if the modal unmounts without starting a match.
  useEffect(() => {
    return () => {
      if (!startedRef.current) {
        hostRef.current?.close();
        guestRef.current?.close();
      }
    };
  }, []);

  const backToMenu = () => {
    teardown();
    startedRef.current = false;
    setTab('menu');
    setRoomCode('');
    setJoinInput('');
    setInLobby(false);
    setPeerList([]);
    setError(null);
    setBusy(false);
  };

  const handleCancel = () => {
    teardown();
    onCancel();
  };

  // ---- Host ----

  const startHost = async () => {
    setTab('host');
    setError(null);
    setBusy(true);
    const host = new PeerNetHost();
    hostRef.current = host;
    host.onMessage((ev: NetEvent) => {
      if (ev.type === 'peer-list') setPeerList(ev.data.players);
    });
    try {
      const code = await host.open();
      if (hostRef.current !== host) return; // cancelled while connecting
      setRoomCode(code);
      setPeerList([{ id: host.id, isHost: true }]);
    } catch (e) {
      host.close();
      if (hostRef.current === host) hostRef.current = null;
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const startGame = () => {
    const host = hostRef.current;
    if (!host || startedRef.current) return;
    if (peerList.filter((p) => !p.isHost).length < 1) {
      setError(t('lobbyNeedPlayers', lang));
      return;
    }
    startedRef.current = true;
    host.lock();
    host.broadcastStartCountdown(timer);
    (window as any).__bounceroyale_pendingNet = host;
    onStart(host, timer);
  };

  // ---- Guest ----

  const joinRoom = async () => {
    const code = normalizeRoomCode(joinInput);
    if (!isValidRoomCode(code)) {
      setError(t('lanBadCode', lang));
      return;
    }
    setError(null);
    setBusy(true);
    const guest = new PeerNetGuest();
    guestRef.current = guest;
    guest.onMessage((ev: NetEvent) => {
      if (guestRef.current !== guest) return; // stale (cancelled / failed attempt)
      if (ev.type === 'open') {
        setInLobby(true);
        (window as any).__bounceroyale_pendingNet = guest;
      } else if (ev.type === 'peer-list') {
        setPeerList(ev.data.players);
      } else if (ev.type === 'start-countdown' && !startedRef.current) {
        startedRef.current = true;
        onStart(guest, ev.data.startTimer);
      } else if (ev.type === 'close' && !startedRef.current) {
        setInLobby(false);
        setPeerList([]);
        setError(t('lostConnection', lang));
      }
    });
    try {
      await guest.join(code);
    } catch (e) {
      guestRef.current = null;
      guest.close();
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(roomCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const guestCount = peerList.filter((p) => !p.isHost).length;

  const Roster = () => (
    <div
      style={{
        padding: '0.75rem',
        marginBottom: '0.75rem',
        borderRadius: '8px',
        background: 'rgba(34, 197, 94, 0.08)',
        border: '1px solid rgba(34, 197, 94, 0.3)',
      }}
    >
      <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', fontWeight: 600 }}>
        👥 {t('lobbyPlayers', lang)} ({peerList.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {peerList.length === 0 && (
          <div className="text-dim" style={{ fontSize: '0.8rem' }}>{t('lobbyConnecting', lang)}</div>
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
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: p.isHost ? '#ffd700' : '#4ade80',
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', flex: 1 }}>{p.id.slice(0, 12)}</span>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '0.1rem 0.4rem',
                borderRadius: '4px',
                background: p.isHost ? 'rgba(255, 215, 0, 0.15)' : 'rgba(74, 222, 128, 0.15)',
                color: p.isHost ? '#ffd700' : '#4ade80',
              }}
            >
              {p.isHost ? t('lobbyHost', lang) : t('lobbyGuest', lang)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>📡 {t('hostLan', lang)}</h2>

        {tab === 'menu' && (
          <div className="flex-col" style={{ gap: '0.6rem' }}>
            <button className="primary" onClick={startHost}>
              📡 {t('lanHostNetwork', lang)}
            </button>
            <button className="primary" onClick={() => { setError(null); setTab('join'); }}>
              🔗 {t('lanJoinNetwork', lang)}
            </button>
            <button
              className="ghost"
              style={{ fontSize: '0.85rem' }}
              onClick={() => { teardown(); onOffline(); }}
            >
              {t('lanOfflineMode', lang)}
            </button>
            <div className="actions mt-2">
              <button className="ghost" onClick={handleCancel}>{t('cancel', lang)}</button>
            </div>
          </div>
        )}

        {tab === 'host' && (
          <>
            {!roomCode && busy && (
              <div className="connection-status connecting mt-2">
                <span className="dot"></span>
                {t('lanCreatingRoom', lang)}
              </div>
            )}

            {roomCode && (
              <>
                <h3>{t('lanRoomCode', lang)}</h3>
                <div
                  className="code-box"
                  style={{
                    textAlign: 'center',
                    fontFamily: 'monospace',
                    fontSize: '2.6rem',
                    fontWeight: 800,
                    letterSpacing: '0.4em',
                    paddingLeft: '0.4em',
                    userSelect: 'all',
                    maxHeight: 'none',
                  }}
                >
                  {roomCode}
                </div>
                <button className="ghost" style={{ width: '100%', marginTop: '0.4rem' }} onClick={copyCode}>
                  📋 {copied ? t('copied', lang) : t('copyCode', lang)}
                </button>
                <p className="text-dim" style={{ fontSize: '0.85rem', margin: '0.6rem 0' }}>
                  {t('lanShareCode', lang)}
                </p>

                <Roster />

                <div className="setting-row">
                  <label>{t('startTimer', lang)}</label>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    value={timer}
                    onChange={(e) => setTimer(parseInt(e.target.value))}
                  />
                  <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>5s</span>
                    <span className="value-display">{timer}s</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>60s</span>
                  </div>
                </div>

                <button
                  className="primary"
                  style={{ width: '100%', marginTop: '0.75rem', fontSize: '1rem', fontWeight: 700 }}
                  onClick={startGame}
                  disabled={guestCount < 1}
                  title={t('lobbyStartHint', lang)}
                >
                  ▶ {t('lobbyStartGame', lang)}
                </button>
                {guestCount < 1 && (
                  <div className="text-dim" style={{ fontSize: '0.75rem', marginTop: '0.4rem', textAlign: 'center' }}>
                    {t('lobbyNeedPlayers', lang)}
                  </div>
                )}
              </>
            )}

            <div className="actions mt-2">
              <button className="ghost" onClick={backToMenu}>{t('back', lang)}</button>
            </div>
          </>
        )}

        {tab === 'join' && (
          <>
            {!inLobby && (
              <>
                <h3>{t('lanEnterCode', lang)}</h3>
                <input
                  type="text"
                  value={joinInput}
                  onChange={(e) => setJoinInput(normalizeRoomCode(e.target.value).slice(0, ROOM_CODE_LENGTH))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !busy) joinRoom(); }}
                  placeholder="K7QXM"
                  maxLength={ROOM_CODE_LENGTH + 2}
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  style={{
                    textAlign: 'center',
                    fontFamily: 'monospace',
                    fontSize: '2rem',
                    letterSpacing: '0.3em',
                    textTransform: 'uppercase',
                  }}
                />
                <button
                  className="primary mt-1"
                  style={{ width: '100%' }}
                  onClick={joinRoom}
                  disabled={busy || joinInput.length !== ROOM_CODE_LENGTH}
                >
                  {busy ? t('lanJoining', lang) : `➜ ${t('lanJoinRoom', lang)}`}
                </button>
              </>
            )}

            {inLobby && (
              <>
                <h3>{t('lobbyTitle', lang)}</h3>
                <Roster />
                <div className="connection-status connected mt-2">
                  <span className="dot"></span>
                  {t('lobbyWaitingHost', lang)}
                </div>
              </>
            )}

            <div className="actions mt-2">
              <button className="ghost" onClick={backToMenu}>{t('back', lang)}</button>
            </div>
          </>
        )}

        {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{error}</p>}
      </div>
    </div>
  );
}
