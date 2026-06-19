import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onResume: () => void;
  onExit: () => void;
  /** Called when the user clicks "Restart". The parent decides whether
   *  restart is actually possible (single player & LAN host only) — if not,
   *  pass `canRestart={false}` and the button is hidden. */
  onRestart?: () => void;
  /** Whether to show the "Restart" button. False for LAN guests and server
   *  mode (where restart isn't supported). */
  canRestart?: boolean;
}

export default function PauseModal({ onResume, onExit, onRestart, canRestart = false }: Props) {
  const { language } = useSettings();
  const lang = language;
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>⏸ {t('paused', lang)}</h2>
        <div className="actions">
          <button className="primary" onClick={onResume}>▶ {t('resume', lang)}</button>
          {canRestart && onRestart && (
            <button className="ghost" onClick={onRestart}>🔄 {t('restart', lang)}</button>
          )}
          <button className="danger" onClick={onExit}>🚪 {t('exitToMenu', lang)}</button>
        </div>
      </div>
    </div>
  );
}
