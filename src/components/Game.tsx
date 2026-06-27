import { useEffect, useRef, useState, useCallback } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import { createGameEngine, type EngineHudState } from '../game/engine';
import type { NetClient } from '../networking/types';
import { SocketNetClient } from '../networking/socket';
import Hud from './Hud';
import PauseModal from './PauseModal';
import EndGameModal from './EndGameModal';

interface Props {
  mode: 'single' | 'lan' | 'server';
  serverUrl?: string;
  gameId?: string;
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
    weapon: 'ak47',
    ammo: 30,
    maxAmmo: 30,
    reserveAmmo: 60,
    isReloading: false,
    reloadProgress: 0,
  });
  const [countdown, setCountdown] = useState<number | null>(null);
  const [spectating, setSpectating] = useState(false);
  const [paused, setPaused] = useState(false);
  const [endGame, setEndGame] = useState<{ rankings: { id: string; rank: number | null }[]; winner: string | null } | null>(null);
  const endGameRef = useRef(endGame);
  endGameRef.current = endGame;
  const [fps, setFps] = useState(60);
  const [localPlayerId, setLocalPlayerId] = useState<string>('local');
  const mobileTouchState = useRef({
    joyId: null as number | null,
    joyStart: { x: 0, y: 0 },
    lookId: null as number | null,
    lastLookX: 0,
    lastLookY: 0,
  }).current;

  const [mobileStick, setMobileStick] = useState({
    vis: false, x: 0, y: 0, baseX: 0, baseY: 0
  });

  const jumpBtnRef = useRef<HTMLButtonElement | null>(null);
  const fireBtnRef = useRef<HTMLButtonElement | null>(null);

  const exitGame = useCallback(() => {
    const client = netClientRef.current;
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      netClientRef.current = null;
    }
    onExit();
  }, [onExit]);

  useEffect(() => {
    const onUnload = () => {
      const client = netClientRef.current;
      if (client) {
        try { client.close(); } catch { /* ignore */ }
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => { window.removeEventListener('beforeunload', onUnload); };
  }, []);

  // Build the engine once on mount
  useEffect(() => {
    let cancelled = false;
    let netClient: NetClient | null = null;
    let isHost = mode === 'single';
    let engineDisposed = false;

    async function init() {
      if (mode === 'lan') {
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
        const serverIsHost = !!isHostProp;
        if (!netClientRef.current) {
          const id = `pending-${Math.random().toString(36).slice(2, 8)}`;
          if (!serverUrl) {
            onError('Server URL is missing. Please go back and enter the server URL.');
            onExit();
            return;
          }
          const client = new SocketNetClient(serverUrl, {
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

      if (cancelled) return;

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
          onReset: () => {
            setEndGame(null);
            setSpectating(false);
            setPaused(false);
            setCountdown(null);
          },
        },
      });
      engineRef.current = engine;
      setLocalPlayerId(engine.getLocalPlayerId());
      engine.start();

      const canvas = engine.getCanvas();
      if (canvasWrapRef.current) {
        canvasWrapRef.current.appendChild(canvas);
      }

      const css2dEl = engine.getCss2dElement();
      if (canvasWrapRef.current && css2dEl) {
        canvasWrapRef.current.appendChild(css2dEl);
      }

      // ---- Touch handlers for mobile ----
      const onTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        const w = window.innerWidth;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          const target = touch.target as HTMLElement | null;
          // Skip button touches — they handle their own events
          if (target?.closest('.jump-btn') || target?.closest('.fire-btn') || target?.closest('.pause-btn') || target?.closest('.spectate-switch-btn') || target?.closest('.weapon-switch-btn') || target?.closest('.reload-btn')) continue;

          if (touch.clientX < w * 0.4) {
            // Left zone = movement joystick
            mobileTouchState.joyId = touch.identifier;
            mobileTouchState.joyStart = { x: touch.clientX, y: touch.clientY };
            setMobileStick({ vis: true, x: 0, y: 0, baseX: touch.clientX, baseY: touch.clientY });
          } else {
            // Right zone = look control (NO auto-fire here anymore)
            mobileTouchState.lookId = touch.identifier;
            mobileTouchState.lastLookX = touch.clientX;
            mobileTouchState.lastLookY = touch.clientY;
          }
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const touch = e.changedTouches[i];
          if (touch.identifier === mobileTouchState.joyId || touch.clientX < window.innerWidth * 0.4) {
            if (touch.clientX < window.innerWidth * 0.4) mobileTouchState.joyId = touch.identifier;
            const dx = (touch.clientX - mobileTouchState.joyStart.x) / 50;
            const dy = (touch.clientY - mobileTouchState.joyStart.y) / 50;
            const cx = Math.max(-1, Math.min(1, dx));
            const cy = Math.max(-1, Math.min(1, dy));
            engine.setJoystick(cx, cy);
            setMobileStick(prev => ({ ...prev, x: cx * 30, y: cy * 30 }));
          } else if (touch.identifier === mobileTouchState.lookId) {
            const dx = touch.clientX - mobileTouchState.lastLookX;
            const dy = touch.clientY - mobileTouchState.lastLookY;
            mobileTouchState.lastLookX = touch.clientX;
            mobileTouchState.lastLookY = touch.clientY;
            // Horizontal: swipe right = look right (positive dx = positive azimuth)
            // Vertical: swipe DOWN = look DOWN (negative pitch), so NEGATE dy
            engine.addLookDelta(dx * 0.005);
            engine.addLookDeltaY(-dy * 0.005);
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

      // Jump button touch handler
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

      // Fire button touch handler
      const fireBtn = fireBtnRef.current;
      const onFireTouchStart = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        engine.setFiring(true);
        engine.ensureAudio();
      };
      const onFireTouchEnd = (e: TouchEvent) => {
        e.preventDefault();
        e.stopPropagation();
        engine.setFiring(false);
      };
      if (fireBtn) {
        fireBtn.addEventListener('touchstart', onFireTouchStart, { passive: false, capture: true });
        fireBtn.addEventListener('touchend', onFireTouchEnd, { passive: false, capture: true });
        fireBtn.addEventListener('touchcancel', onFireTouchEnd, { passive: false, capture: true });
      }

      // FPS ticker
      const fpsInterval = window.setInterval(() => {
        setFps(engine.getFps());
      }, 500);

      // ---- Keyboard handlers ----
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (!paused) setPaused(true);
          return;
        }
        if ((e.key === 'v' || e.key === 'V') && spectating) {
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
        } else if (k === '1') {
          engine.switchWeapon('ak47');
        } else if (k === '2') {
          engine.switchWeapon('desert_eagle');
        } else if (k === 'r') {
          engine.startReload();
        }
        if (settings.pointerLock && !paused && !endGameRef.current) {
          // Delay pointer lock request to avoid SecurityError:
          // "Pointer lock cannot be acquired immediately after the user
          // has exited the lock." Browsers enforce a short grace period
          // after pointer lock is released (e.g. by clicking a modal).
          setTimeout(() => {
            if (document.pointerLockElement || endGameRef.current) return;
            const canvas2 = engine.getCanvas();
            if (canvas2.requestPointerLock) {
              canvas2.requestPointerLock().catch(() => { /* ignore SecurityError */ });
            }
          }, 200);
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

      // ---- Mouse handlers ----
      const onMouseMove = (e: MouseEvent) => {
        if (paused) return;
        const dx = (e as any).movementX || 0;
        const dy = (e as any).movementY || 0;
        // Horizontal: move right = look right (positive movementX = positive azimuth)
        // Vertical: move mouse UP = look UP (negative movementY = positive pitch), so NEGATE dy
        engine.addLookDelta(dx * 0.002);
        engine.addLookDeltaY(-dy * 0.002);
      };
      const onMouseDown = (e: MouseEvent) => {
        if (paused || spectating) return;
        if (e.button === 0) {
          engine.setFiring(true);
          engine.ensureAudio();
        }
        if (settings.pointerLock && !endGameRef.current) {
          setTimeout(() => {
            if (document.pointerLockElement || endGameRef.current) return;
            const canvas2 = engine.getCanvas();
            if (canvas2.requestPointerLock) {
              canvas2.requestPointerLock().catch(() => { /* ignore SecurityError */ });
            }
          }, 200);
        }
      };
      const onMouseUp = (e: MouseEvent) => {
        if (e.button === 0) {
          engine.setFiring(false);
        }
      };
      const onWheel = (e: WheelEvent) => {
        if (paused || spectating) return;
        const current = engine.getCurrentWeapon();
        engine.switchWeapon(current === 'ak47' ? 'desert_eagle' : 'ak47');
      };
      const onResize = () => engine.resize();
      const onContext = (e: Event) => e.preventDefault();

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('wheel', onWheel);
      window.addEventListener('resize', onResize);
      const canvas3 = engine.getCanvas();
      canvas3.addEventListener('contextmenu', onContext);

      // Cleanup
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('wheel', onWheel);
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
        if (fireBtn) {
          fireBtn.removeEventListener('touchstart', onFireTouchStart, { passive: false, capture: true } as AddEventListenerOptions);
          fireBtn.removeEventListener('touchend', onFireTouchEnd, { passive: false, capture: true } as AddEventListenerOptions);
          fireBtn.removeEventListener('touchcancel', onFireTouchEnd, { passive: false, capture: true } as AddEventListenerOptions);
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

  useEffect(() => {
    if (engineRef.current) engineRef.current.updateSettings(useSettings.getState());
  }, [settings.masterVolume, settings.gameSpeed, settings.graphicsQuality, settings.cameraSensitivity, settings.pointerLock, settings.showFps]);

  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);

  const handlePause = useCallback(() => { setPaused(true); }, []);
  const handleSwitchSpectate = useCallback(() => { engineRef.current?.switchSpectator(); }, []);

  const canRestart = mode === 'single' || (mode === 'lan' && hud.isHost);
  const handleRestart = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (mode === 'server') { onError(t('restartOnlyHost', lang)); return; }
    if (mode === 'lan' && !hud.isHost) { onError(t('restartOnlyHost', lang)); return; }
    const ok = engine.restart();
    if (!ok) onError(t('restartOnlyHost', lang));
  }, [mode, hud.isHost, lang, onError]);

  const handleWeaponSwitch = useCallback(() => {
    engineRef.current?.switchWeapon(hud.weapon === 'ak47' ? 'desert_eagle' : 'ak47');
  }, [hud.weapon]);

  const handleReload = useCallback(() => {
    engineRef.current?.startReload();
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

      {/* Mobile controls - right side */}
      <div className="mobile-controls-panel">
        <button
          ref={fireBtnRef}
          className="fire-btn"
          aria-label="Fire"
        >
          🔥
        </button>
        <button
          ref={jumpBtnRef}
          className="jump-btn"
          aria-label="Jump"
        >
          {t('jump', lang)}
        </button>
        <button
          className="weapon-switch-btn"
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); handleWeaponSwitch(); }}
          aria-label="Switch weapon"
        >
          ⇄
        </button>
        <button
          className="reload-btn"
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); handleReload(); }}
          aria-label="Reload"
        >
          ↻
        </button>
      </div>

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
      {countdown !== null && <div className="countdown">{countdown}</div>}
      {spectating && !endGame && <div className="spectator-banner">👁 {t('spectating', lang)}</div>}
      <div className="controls-hint">{t('controlsHint', lang)}</div>
      {/* Crosshair */}
      {!spectating && !paused && !endGame && (
        <div className="crosshair">
          <div className="crosshair-dot" />
          <div className="crosshair-line crosshair-top" />
          <div className="crosshair-line crosshair-bottom" />
          <div className="crosshair-line crosshair-left" />
          <div className="crosshair-line crosshair-right" />
        </div>
      )}
      {paused && !endGame && (
        <PauseModal
          onResume={() => setPaused(false)}
          onExit={() => { setPaused(false); exitGame(); }}
          onRestart={handleRestart}
          canRestart={canRestart}
        />
      )}
      {endGame && (
        <EndGameModal
          rankings={endGame.rankings}
          winner={endGame.winner}
          localPlayerId={localPlayerId}
          onExit={exitGame}
          onRestart={handleRestart}
          canRestart={canRestart}
        />
      )}
    </div>
  );
}
