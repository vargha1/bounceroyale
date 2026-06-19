import { useEffect, useState, useRef, useCallback } from 'react';
import { useSettings } from './store/settings';
import { t, applyHtmlLang, type TranslationKey } from './i18n/translations';

import MainMenu from './components/MainMenu';
import GameModeModal from './components/GameModeModal';
import SettingsModal from './components/SettingsModal';
import AboutModal from './components/AboutModal';
import CreateGameModal from './components/CreateGameModal';
import JoinServerModal from './components/JoinServerModal';
import LanModal from './components/LanModal';
import Game from './components/Game';
import Toast from './components/Toast';

type Screen =
  | { kind: 'menu' }
  | { kind: 'mode' }
  | { kind: 'settings' }
  | { kind: 'about' }
  | { kind: 'create-server' }
  | { kind: 'join-server' }
  | { kind: 'lan' }
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

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  return (
    <div className="app">
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
        <LanModal
          onCancel={() => setScreen({ kind: 'mode' })}
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

      {toast && <Toast message={toast} />}
    </div>
  );
}
