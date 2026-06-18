import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onResume: () => void;
  onExit: () => void;
}

export default function PauseModal({ onResume, onExit }: Props) {
  const { language } = useSettings();
  const lang = language;
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>⏸ {t('paused', lang)}</h2>
        <div className="actions">
          <button className="primary" onClick={onResume}>▶ {t('resume', lang)}</button>
          <button className="danger" onClick={onExit}>🚪 {t('exitToMenu', lang)}</button>
        </div>
      </div>
    </div>
  );
}
