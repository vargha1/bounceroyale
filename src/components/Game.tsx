import { useEffect, useRef, useState, useCallback } from 'react';
import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import { createGameEngine, type EngineHudState } from '../game/engine';
import type { NetClient } from '../networking/types';
import { SocketNetClient } from '../networking/socket';
import Hud from './Hud';
import PauseModal from './PauseModal';
import EndGameModal from './EndGameModal';
import MobileControls from './MobileControls';

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

  // ---- Refs to mirror state for stale-closure-free event handlers ----
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const spectatingRef = useRef(spectating);
  spectatingRef.current = spectating;
  const countdownRef = useRef(countdown);
  countdownRef.current = countdown;
  const hudWeaponRef = useRef(hud.weapon);
  hudWeaponRef.current = hud.weapon;

  // ---- Pointer lock refs (must be declared at top level, not inside effects) ----
  const hasPointerLockRef = useRef(false);

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

  // ---- Pointer lock helpers ----
  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator as any).maxTouchPoints > 0);
  const pointerLockEnabled = settings.pointerLock && !isTouchDevice;

  const requestPointerLock = useCallback(() => {
    if (!pointerLockEnabled) return;
    if (document.pointerLockElement) return;
    if (pausedRef.current || spectatingRef.current || endGameRef.current || countdownRef.current !== null) return;
    const canvas = engineRef.current?.getCanvas();
    if (canvas?.requestPointerLock) {
      canvas.requestPointerLock().catch(() => { /* ignore SecurityError */ });
    }
  }, [pointerLockEnabled]);

  const releasePointerLock = useCallback(() => {
    try {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    } catch { /* ignore */ }
  }, []);

  // Track pointer lock state changes
  useEffect(() => {
    const onPointerLockChange = () => {
      hasPointerLockRef.current = !!document.pointerLockElement;
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    return () => document.removeEventListener('pointerlockchange', onPointerLockChange);
  }, []);

  // Release pointer lock when game state changes to a "menu" state. We
  // intentionally do NOT auto-request pointer lock here — that should only
  // happen in direct response to a user click on the canvas (handled in
  // onMouseDown below), so we don't grab the cursor unexpectedly and trap
  // the user out of clicking on mobile buttons / HUD elements.
  useEffect(() => {
    if (paused || spectating || countdown !== null || endGame) {
      releasePointerLock();
    }
  }, [paused, spectating, countdown, endGame, releasePointerLock]);

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
          onDamageTaken: (_damage) => {
            const indicator = document.getElementById('damage-indicator');
            if (indicator) {
              indicator.classList.add('active');
              setTimeout(() => indicator.classList.remove('active'), 150);
            }
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
          if (target?.closest('[data-mobile-btn]') || target?.closest('.pause-btn') || target?.closest('.spectate-switch-btn')) continue;

          if (touch.clientX < w * 0.4) {
            mobileTouchState.joyId = touch.identifier;
            mobileTouchState.joyStart = { x: touch.clientX, y: touch.clientY };
            setMobileStick({ vis: true, x: 0, y: 0, baseX: touch.clientX, baseY: touch.clientY });
          } else {
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

      // FPS ticker — single declaration
      const fpsInterval = window.setInterval(() => {
        setFps(engine.getFps());
      }, 500);

      // Store mobile controls action handler on window for access
      (window as any).__handleMobileAction = (action: string) => {
        switch (action) {
          case 'fire':
            engine.setFiring(true);
            setTimeout(() => engine.setFiring(false), 100);
            engine.ensureAudio();
            break;
          case 'jump':
            engine.jump();
            engine.ensureAudio();
            break;
          case 'reload':
            engine.startReload();
            break;
          case 'switch':
            engine.switchWeapon(hudWeaponRef.current === 'ak47' ? 'desert_eagle' : 'ak47');
            break;
          case 'pause':
            setPaused(true);
            break;
        }
      };

      // ---- Keyboard handlers ----
      // Use refs so handlers always see current paused/spectating/countdown without re-registering
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (!pausedRef.current) setPaused(true);
          return;
        }
        if ((e.key === 'v' || e.key === 'V') && spectatingRef.current) {
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
        if (pausedRef.current || spectatingRef.current || endGameRef.current) return;
        const dx = (e as any).movementX || 0;
        const dy = (e as any).movementY || 0;
        engine.addLookDelta(dx * 0.002);
        engine.addLookDeltaY(-dy * 0.002);
      };

      const onMouseDown = (e: MouseEvent) => {
        if (pausedRef.current || spectatingRef.current || endGameRef.current) return;
        // Skip clicks on UI (HUD, modal, mobile controls) — never start firing
        // or grab pointer lock when the user is interacting with the UI.
        const target = e.target as HTMLElement | null;
        const isCanvasClick = target === engine.getCanvas();
        if (target && !isCanvasClick && target.closest('.modal-overlay, .hud, [data-mobile-btn], button')) return;
        if (e.button === 0) {
          engine.setFiring(true);
          engine.ensureAudio();
        }
        // Only grab pointer lock on a direct canvas click (and only on
        // non-touch desktop). This prevents the cursor from being trapped
        // and blocking UI clicks.
        if (isCanvasClick && settings.pointerLock && !isTouchDevice && !pausedRef.current && !spectatingRef.current && countdownRef.current === null && !endGameRef.current) {
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
        if (pausedRef.current || spectatingRef.current) return;
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
        delete (window as any).__handleMobileAction;
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
    if (!ok) { onError(t('restartOnlyHost', lang)); return; }
    // Defensive: also clear UI state here in case the engine's onReset
    // callback hasn't fired yet (the engine fires it synchronously inside
    // restart(), but clearing again is harmless and guarantees the modal
    // closes even if a future engine change re-orders things).
    setEndGame(null);
    setSpectating(false);
    setPaused(false);
  }, [mode, hud.isHost, lang, onError]);

  const handleWeaponSwitch = useCallback(() => {
    engineRef.current?.switchWeapon(hud.weapon === 'ak47' ? 'desert_eagle' : 'ak47');
  }, [hud.weapon]);

  const handleReload = useCallback(() => {
    engineRef.current?.startReload();
  }, []);

  // Stable handler — uses a ref so the function identity never changes
  // and the callback always reads the latest engineRef.current.
  const handleMobileButtonActionRef = useRef((action: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    switch (action) {
      case 'fire':
        engine.setFiring(true);
        setTimeout(() => engine.setFiring(false), 100);
        engine.ensureAudio();
        break;
      case 'jump':
        engine.jump();
        engine.ensureAudio();
        break;
      case 'reload':
        engine.startReload();
        break;
      case 'switch("weapon")':
        engine.switchWeapon(hud.weapon === 'ak47' ? 'desert_eagle' : 'ak47');
        break;
      case 'crouch':
        break;
      case 'sprint':
        break;
      case 'pause':
        setPaused(true);
        break;
    }
  });

  const handleMobileButtonAction = handleMobileButtonActionRef.current;

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

      <MobileControls
        onButtonAction={handleMobileButtonAction}
      />

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