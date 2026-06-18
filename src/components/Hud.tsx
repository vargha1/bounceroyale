import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';
import type { EngineHudState } from '../game/engine';

interface Props {
  hud: EngineHudState;
  fps: number;
  showFps: boolean;
  localPlayerId: string;
  mode: 'single' | 'lan' | 'server';
  onPause?: () => void;
  onSwitchSpectate?: () => void;
  spectating?: boolean;
}

const POWERUP_LABELS: Record<string, string> = {
  speed_boost: '⚡ Speed',
  high_jump: '⬆️ Jump',
  invincibility: '🛡️ Invincible',
  health_regen: '❤️ Regen',
};

export default function Hud({ hud, fps, showFps, localPlayerId, mode, onPause, onSwitchSpectate, spectating }: Props) {
  const { language } = useSettings();
  const lang = language;

  return (
    <div className="hud">
      <div className="hud-top-left">
        <div className="hud-card">
          <div className="label">{t('score', lang)}</div>
          <div className="value">{hud.score}</div>
        </div>
        <div className="hud-card health">
          <div className="label">{t('health', lang)}</div>
          <div className="value">{hud.health}%</div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${hud.health}%` }} />
          </div>
        </div>
        {hud.powerUps.length > 0 && (
          <div className="hud-card">
            <div className="label">Power-ups</div>
            <div className="flex-col" style={{ gap: '0.3rem', marginTop: '0.3rem' }}>
              {hud.powerUps.map((p, i) => (
                <span key={i} className={`powerup-chip ${p.type}`}>
                  {POWERUP_LABELS[p.type] ?? p.type} · {(p.remaining / 1000).toFixed(1)}s
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="hud-top-right">
        {/* Pause button — always visible, critical for mobile (no Escape key) */}
        {onPause && (
          <button
            className="pause-btn"
            onClick={onPause}
            onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onPause(); }}
            aria-label="Pause"
          >
            ⏸
          </button>
        )}
        <div className="hud-card center">
          <div className="label">{t('players', lang)}</div>
          <div className="value">{hud.aliveCount}/{hud.totalPlayers}</div>
        </div>
        <div className="hud-card center">
          <div className="label">{t('fps', lang)}</div>
          <div className="value" style={{ color: fps >= 50 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171' }}>
            {showFps ? fps : '—'}
          </div>
        </div>
        <div className="hud-card center" style={{ fontSize: '0.7rem', opacity: 0.6 }}>
          {mode === 'single' ? '🎮 Solo' : mode === 'lan' ? (hud.isHost ? '📡 LAN Host' : '🔗 LAN Guest') : '🌐 Server'}
          <div style={{ fontSize: '0.6rem', opacity: 0.6, marginTop: '2px' }}>
            {localPlayerId.slice(0, 10)}
          </div>
        </div>
      </div>

      {/* Spectate switch button — for mobile (no Tab key) */}
      {spectating && onSwitchSpectate && (
        <button
          className="spectate-switch-btn"
          onClick={onSwitchSpectate}
          onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); onSwitchSpectate(); }}
        >
          👁 ⇄
        </button>
      )}
    </div>
  );
}
