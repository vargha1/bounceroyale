import { lazy, Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { useSettings } from './store/settings';
import { t, applyHtmlLang, type TranslationKey } from './i18n/translations';

import MainMenu from './components/MainMenu';
import GameModeModal from './components/GameModeModal';
import SettingsModal from './components/SettingsModal';
import AboutModal from './components/AboutModal';
import Toast from './components/Toast';

// Heavy screens are code-split so the menu paints after parsing only a small
// entry bundle (three.js + Rapier + networking libs are the bulk of the app).
// They are warmed in the background once the menu is up — see below — which
// also lets the service worker cache them for fully-offline play.
const loadGame = () => import('./components/Game');
const loadCreateGame = () => import('./components/CreateGameModal');
const loadJoinServer = () => import('./components/JoinServerModal');
const loadLan = () => import('./components/LanModal');
const loadLanCode = () => import('./components/LanCodeModal');
const Game = lazy(loadGame);
const CreateGameModal = lazy(loadCreateGame);
const JoinServerModal = lazy(loadJoinServer);
const LanModal = lazy(loadLan);
const LanCodeModal = lazy(loadLanCode);

type Screen =
  | { kind: 'menu' }
  | { kind: 'mode' }
  | { kind: 'settings' }
  | { kind: 'about' }
  | { kind: 'create-server' }
  | { kind: 'join-server' }
  | { kind: 'lan' }
  | { kind: 'lan-manual' }
  | { kind: 'game'; mode: 'single' | 'lan' | 'server'; serverUrl?: string; gameId?: string; isHost?: boolean; startTimer: number };

export default function App() {
  const { language } = useSettings();
  const lang = language;
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const tr = useCallback((k: TranslationKey) => t(k, lang), [lang]);
  void tr;

  useEffect(() => {
    applyHtmlLang(lang);
  }, [lang]);

  // Once the menu is on screen and the browser is idle, fetch the lazy
  // chunks so entering a game / LAN lobby is instant and works offline.
  useEffect(() => {
    const warm = () => {
      void loadGame();
      void loadLanCode();
      void loadLan();
      void loadJoinServer();
      void loadCreateGame();
      void import('./networking/socket');
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(warm, { timeout: 5000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const h = window.setTimeout(warm, 3000);
    return () => window.clearTimeout(h);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className={screen.kind === 'game' ? 'app in-game' : 'app'}>
      <Suspense fallback={null}>
      {screen.kind === 'menu' && (
        <MainMenu
          onStart={() => setScreen({ kind: 'mode' })}
          onSettings={() => setScreen({ kind: 'settings' })}
          onAbout={() => setScreen({ kind: 'about' })}
        />
      )}

      {screen.kind === 'mode' && (
        <GameModeModal
          onClose={() => setScreen({ kind: 'menu' })}
          onSingle={() => setScreen({ kind: 'game', mode: 'single', startTimer: 5 })}
          onServerCreate={() => setScreen({ kind: 'create-server' })}
          onServerJoin={() => setScreen({ kind: 'join-server' })}
          onLan={() => setScreen({ kind: 'lan' })}
        />
      )}

      {screen.kind === 'settings' && <SettingsModal onClose={() => setScreen({ kind: 'menu' })} />}
      {screen.kind === 'about' && <AboutModal onClose={() => setScreen({ kind: 'menu' })} />}

      {screen.kind === 'create-server' && (
        <CreateGameModal
          onCancel={() => setScreen({ kind: 'mode' })}
          onStart={(url, timer) => setScreen({ kind: 'game', mode: 'server', serverUrl: url, isHost: true, startTimer: timer })}
        />
      )}

      {screen.kind === 'join-server' && (
        <JoinServerModal
          onCancel={() => setScreen({ kind: 'mode' })}
          onConnect={(url, gameId) => setScreen({ kind: 'game', mode: 'server', serverUrl: url, gameId, isHost: false, startTimer: 30 })}
        />
      )}

      {screen.kind === 'lan' && (
        <LanCodeModal
          onCancel={() => setScreen({ kind: 'mode' })}
          onStart={(_client, timer) => setScreen({ kind: 'game', mode: 'lan', startTimer: timer })}
          onOffline={() => setScreen({ kind: 'lan-manual' })}
        />
      )}

      {screen.kind === 'lan-manual' && (
        <LanModal
          onCancel={() => setScreen({ kind: 'lan' })}
          onStart={(_client, timer) => setScreen({ kind: 'game', mode: 'lan', startTimer: timer })}
        />
      )}

      {screen.kind === 'game' && (
        <Game
          mode={screen.mode}
          serverUrl={screen.serverUrl}
          gameId={screen.gameId}
          isHost={screen.isHost}
          startTimer={screen.startTimer}
          onExit={() => setScreen({ kind: 'menu' })}
          onError={(m) => showToast(m)}
        />
      )}

      </Suspense>

      {toast && <Toast message={toast} />}
    </div>
  );
}
