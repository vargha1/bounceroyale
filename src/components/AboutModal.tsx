import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props { onClose: () => void; }

export default function AboutModal({ onClose }: Props) {
  const { language } = useSettings();
  const lang = language;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>❓ {t('about', lang)}</h2>
        <div className="about-body">
          <p>{t('aboutBody', lang)}</p>
        </div>
        <h2>📜 {t('credits', lang)}</h2>
        <div className="about-body">
          <p>{t('creditsBody', lang)}</p>
        </div>
        <div className="actions mt-2">
          <button className="primary" onClick={onClose}>{t('back', lang)}</button>
        </div>
      </div>
    </div>
  );
}
