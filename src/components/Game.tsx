import { useEffect, useRef, useState, useCallback } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import { createGameEngine, type EngineHudState } from '../game/engine';
import type { NetClient } from '../networking/types';
import { SocketNetClient } from '../networking/socket';
import Hud from './Hud';
import MobileControls from './MobileControls';
import PauseModal from './PauseModal';
import EndGameModal from './EndGameModal';

interface Props {
  mode: 'single' | 'lan' | 'server';
  serverUrl?: string;
  gameId?: string;
  /** For server mode: true if the user clicked "Create Game" (host), false if
   *  "Join Game" (guest). For LAN mode, this is determined by the net client.
   *  For single-player, it's always true. */
  isHost?: boolean;
  startTimer: number;
  onExit: () => void;
  onError: (m: string) => void;
}

export default function Game({ mode, serverUrl, gameId, isHost: isHostProp, startTimer, onExit, onError }: Props) {
  const settings = useSettings();
  const lang = settings.language;
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ReturnType<typeof createGameEngine> | null>(null);
  const netClientRef = useRef<NetClient | null>(null);
  const [hud, setHud] = useState<EngineHudState>({
    score: 0,
    health: 100,
    powerUps: [],
    aliveCount: 1,
    totalPlayers: 1,
    isHost: mode === 'single' || mode === 'lan' || !!isHostProp,
  });
  const [countdown, setCountdown] = useState<number | null>(null);
  const [spectating, setSpectating] = useState(false);
  const [paused, setPaused] = useState(false);
  const [endGame, setEndGame] = useState<{ rankings: { id: string; rank: number | null }[]; winner: string | null } | null>(null);
  const [fps, setFps] = useState(60);
  const [localPlayerId, setLocalPlayerId] = useState<string>('local');
  // In Game.tsx, outside useEffect (stable ref across renders)
  const mobileTouchState = useRef({
    joyId: null as number | null,
    joyStart: { x: 0, y: 0 },
    lookId: null as number | null,
    lastLookX: 0,
  }).current;

  const [mobileStick, setMobileStick] = useState({
    vis: false, x: 0, y: 0, baseX: 0, baseY: 0
  });

  const jumpBtnRef = useRef<HTMLButtonElement | null>(null);

  // Centralized exit: closes the net client (if any) and notifies parent.
  // Defined before the main useEffect so the engine's onConnectionLost
  // callback can close over it.
  const exitGame = useCallback(() => {
    const client = netClientRef.current;
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      netClientRef.current = null;
    }
    onExit();
  }, [onExit]);

  // NOTE: We intentionally do NOT auto-close the net client on unmount here.
  // React StrictMode in dev double-invokes effects (mount → cleanup → mount),
  // and any "close on unmount" logic would close the client during the first
  // cleanup, breaking the second mount. Instead, the net client is closed
  // explicitly when the user exits the game (via onExit / PauseModal exit),
  // and on real page unload via the beforeunload listener below.
  useEffect(() => {
    const onUnload = () => {
      const client = netClientRef.current;
      if (client) {
        try { client.close(); } catch { /* ignore */ }
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  // Build the engine once on mount
  useEffect(() => {
    let cancelled = false;
    let netClient: NetClient | null = null;
    let isHost = mode === 'single';
    let engineDisposed = false;

    async function init() {
      // Determine host status and create the network client if needed
      if (mode === 'lan') {
        // Take ownership of the net client created by the LanModal. Both
        // BroadcastChannel (quick local) and WebRTC (cross-device) clients
        // are stashed in the same global slot.
        // NOTE: React StrictMode double-invokes effects in dev. We stash the
        // client on the ref so the second mount can reuse it instead of
        // finding the global empty and erroring out.
        let pending = (window as any).__bounceroyale_pendingNet as NetClient | undefined;
        if (netClientRef.current) {
          pending = netClientRef.current;
        } else if (pending) {
          netClientRef.current = pending;
          (window as any).__bounceroyale_pendingNet = null;
        }
        if (pending) {
          netClient = pending;
          isHost = pending.isHost;
        } else if (!netClientRef.current) {
          onError('LAN: no connection found. Please retry from the LAN menu.');
          onExit();
          return;
        } else {
          netClient = netClientRef.current;
          isHost = netClient.isHost;
        }
      } else if (mode === 'server') {
        // Server mode: the user is the host if they clicked "Create Game"
        // (isHostProp === true), or a guest if they clicked "Join Game"
        // (isHostProp === false). The previous code hardcoded `isHost: false`
        // which meant the host never sent `create-game` to the server and the
        // game never started. Fixed by passing isHostProp through from App.
        const serverIsHost = !!isHostProp;
        if (!netClientRef.current) {
          const id = `pending-${Math.random().toString(36).slice(2, 8)}`;
          // Normalize the URL: if the user entered just "host:port" without a
          // protocol, prepend ws:// or wss:// based on the current page's
          // protocol. Socket.io accepts both http(s):// and ws(s):// URLs.
          const url = serverUrl?.startsWith('http') || serverUrl?.startsWith('ws')
            ? serverUrl
            : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${serverUrl}`;
          if (!url) {
            onError('Server URL is missing. Please go back and enter the server URL.');
            onExit();
            return;
          }
          const client = new SocketNetClient(url, {
            isHost: serverIsHost,
            gameId: gameId ?? null,
            startTimer,
            playerId: id,
          });
          client.onMessage((ev) => {
            if (ev.type === 'init') {
              (client as any).setGameId(ev.data.gameId);
            }
          });
          netClientRef.current = client;
        }
        netClient = netClientRef.current;
        isHost = serverIsHost;
      }

      if (cancelled) {
        // If the component unmounted before we finished, clean up the client.
        return;
      }

      const engine = createGameEngine({
        mode,
        netClient,
        isHost,
        settings: useSettings.getState(),
        startTimer,
        callbacks: {
          onState: (s) => setHud(s),
          onCountdown: (c) => setCountdown(c),
          onSpectatingChange: (sp) => setSpectating(sp),
          onEndGame: (rankings, winner) => setEndGame({ rankings, winner }),
          onError: (m) => onError(m),
          onConnectionLost: () => {
            onError(t('lostConnection', lang));
            setTimeout(() => exitGame(), 1200);
          },
        },
      });
      engineRef.current = engine;
      setLocalPlayerId(engine.getLocalPlayerId());
      engine.start();

      
      // Attach canvas
      const canvas = engine.getCanvas();
      if (canvasWrapRef.current) {
        canvasWrapRef.current.appendChild(canvas);
      }

      const onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        const w = window.innerWidth;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          const target = touch.target as HTMLElement | null;
          if (target?.closest('.jump-btn') || target?.closest('.pause-btn') || target?.closest('.spectate-switch-btn')) continue;

          if (touch.clientX < w * 0.45) {
            mobileTouchState.joyId = touch.identifier;
            mobileTouchState.joyStart = { x: touch.clientX, y: touch.clientY };
            setMobileStick({ vis: true, x: 0, y: 0, baseX: touch.clientX, baseY: touch.clientY });
          } else {
            mobileTouchState.lookId = touch.identifier;
            mobileTouchState.lastLookX = touch.clientX;
          }
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === mobileTouchState.joyId || touch.clientX < window.innerWidth * 0.45) {
            // Re-claim if Android reassigned the identifier
            if (touch.clientX < window.innerWidth * 0.45) mobileTouchState.joyId = touch.identifier;
            const dx = (touch.clientX - mobileTouchState.joyStart.x) / 50;
            const dy = (touch.clientY - mobileTouchState.joyStart.y) / 50;
            const cx = Math.max(-1, Math.min(1, dx));
            const cy = Math.max(-1, Math.min(1, dy));
            engine.setJoystick(cx, cy);
            setMobileStick(prev => ({ ...prev, x: cx * 30, y: cy * 30 }));
          } else if (touch.identifier === mobileTouchState.lookId) {
            const dx = touch.clientX - mobileTouchState.lastLookX;
            mobileTouchState.lastLookX = touch.clientX;
            engine.addLookDelta(dx * 0.006);
          }
        }
      };

      const onTouchEnd = (e: TouchEvent) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === mobileTouchState.joyId) {
            mobileTouchState.joyId = null;
            engine.setJoystick(0, 0);
            setMobileStick({ vis: false, x: 0, y: 0, baseX: 0, baseY: 0 });
          } else if (touch.identifier === mobileTouchState.lookId) {
            mobileTouchState.lookId = null;
          }
        }
      };

      const touchOpts = { passive: false } as AddEventListenerOptions;
      canvas.addEventListener('touchstart', onTouchStart, touchOpts);
      canvas.addEventListener('touchmove', onTouchMove, touchOpts);
      canvas.addEventListener('touchend', onTouchEnd, touchOpts);
      canvas.addEventListener('touchcancel', onTouchEnd, touchOpts);
      const jumpBtn = jumpBtnRef.current;
      const onJumpTouch = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        engine.jump();
        engine.ensureAudio();
      };
      if (jumpBtn) {
        jumpBtn.addEventListener('touchstart', onJumpTouch, { passive: false, capture: true });
      }

      // FPS ticker
      const fpsInterval = window.setInterval(() => {
        setFps(engine.getFps());
      }, 500);

      // Input handlers
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (!paused) setPaused(true);
          return;
        }
        if (e.key === 'Tab' && spectating) {
          e.preventDefault();
          engine.switchSpectator();
          return;
        }
        engine.ensureAudio();
        const k = e.key.toLowerCase();
        if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
          engine.setInput(k as 'w' | 'a' | 's' | 'd', true);
        } else if (e.key === ' ') {
          engine.setInput('space', true);
        }
        if (settings.pointerLock && !paused) {
          const canvas2 = engine.getCanvas();
          if (canvas2.requestPointerLock) canvas2.requestPointerLock();
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        const k = e.key.toLowerCase();
        if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
          engine.setInput(k as 'w' | 'a' | 's' | 'd', false);
        } else if (e.key === ' ') {
          engine.setInput('space', false);
        }
      };
      const onMouseMove = (e: MouseEvent) => {
        if (paused) return;
        const dx = (e as any).movementX || 0;
        engine.addLookDelta(dx * 0.002);
      };
      const onResize = () => engine.resize();
      const onContext = (e: Event) => e.preventDefault();

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('resize', onResize);
      const canvas3 = engine.getCanvas();
      canvas3.addEventListener('contextmenu', onContext);

      // Cleanup — this runs on every StrictMode remount in dev, but the
      // netClient is preserved on netClientRef so we can re-create the engine.
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('resize', onResize);
        canvas3.removeEventListener('contextmenu', onContext);
        window.clearInterval(fpsInterval);
        try { document.exitPointerLock(); } catch { /* ignore */ }
        if (!engineDisposed) {
          engineDisposed = true;
          engine.dispose();
        }
        if (jumpBtn) {
          jumpBtn.removeEventListener('touchstart', onJumpTouch, { passive: false, capture: true } as AddEventListenerOptions);
        }
        engineRef.current = null;
      };
    }

    const cleanupPromise = init();
    return () => {
      cancelled = true;
      cleanupPromise.then((cleanup) => {
        if (cleanup) cleanup();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync settings changes to the engine
  useEffect(() => {
    if (engineRef.current) engineRef.current.updateSettings(useSettings.getState());
  }, [settings.masterVolume, settings.gameSpeed, settings.graphicsQuality, settings.cameraSensitivity, settings.pointerLock, settings.showFps]);

  // Pause handling
  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  const handlePause = useCallback(() => {
    setPaused(true);
  }, []);
  const handleSwitchSpectate = useCallback(() => {
    engineRef.current?.switchSpectator();
  }, []);

  return (
    <div className="game-container">
      <div className="game-canvas-wrap" ref={canvasWrapRef} />
      <Hud
        hud={hud}
        fps={fps}
        showFps={settings.showFps}
        localPlayerId={localPlayerId}
        mode={mode}
        onPause={handlePause}
        onSwitchSpectate={handleSwitchSpectate}
        spectating={spectating}
      />
      <button
        ref={jumpBtnRef}
        className="jump-btn"
        style={{ position: 'absolute', bottom: 30, right: 30, zIndex: 20, pointerEvents: 'auto' }}
      >
        {t('jump', lang)}
      </button>
      {mobileStick.vis && (
        <div className="joystick floating" style={{
          position: 'absolute',
          left: mobileStick.baseX,
          top: mobileStick.baseY,
          transform: 'translate(-50%, -50%)',
          zIndex: 20,
          pointerEvents: 'none',
        }}>
          <div className="joystick-inner" style={{
            transform: `translate(calc(-50% + ${mobileStick.x}px), calc(-50% + ${mobileStick.y}px))`
          }} />
        </div>
      )}
      {/* <MobileControls onJoystick={handleJoystick} onJump={handleJump} onLook={handleLook} disabled={spectating || paused || !!endGame} /> */}
      {countdown !== null && <div className="countdown">{countdown}</div>}
      {spectating && !endGame && <div className="spectator-banner">👁 {t('spectating', lang)}</div>}
      <div className="controls-hint">{t('controlsHint', lang)}</div>
      {paused && !endGame && (
        <PauseModal
          onResume={() => setPaused(false)}
          onExit={() => {
            setPaused(false);
            exitGame();
          }}
        />
      )}
      {endGame && (
        <EndGameModal
          rankings={endGame.rankings}
          winner={endGame.winner}
          localPlayerId={localPlayerId}
          onExit={exitGame}
        />
      )}
    </div>
  );
}

