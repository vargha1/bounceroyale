import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  onClose: () => void;
  onSingle: () => void;
  onServerCreate: () => void;
  onServerJoin: () => void;
  onLan: () => void;
}

export default function GameModeModal({ onClose, onSingle, onServerCreate, onServerJoin, onLan }: Props) {
  const { language } = useSettings();
  const lang = language;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('selectMode', lang)}</h2>

        <div className="flex-col" style={{ gap: '0.6rem' }}>
          <button className="primary" onClick={onSingle}>
            🎮 {t('singlePlayer', lang)}
            <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— vs AI</span>
          </button>

          <button onClick={onLan}>
            📡 {t('hostLan', lang)}
            <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>— {t('lanGame', lang)}</span>
          </button>

          <button onClick={onServerCreate}>
            🌐 {t('createGame', lang)} <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>({t('serverGame', lang)})</span>
          </button>
          <button onClick={onServerJoin}>
            🌐 {t('joinGame', lang)} <span className="text-dim" style={{ fontSize: '0.8rem', fontWeight: 400 }}>({t('serverGame', lang)})</span>
          </button>
        </div>

        <div className="actions mt-2">
          <button className="ghost" onClick={onClose}>{t('cancel', lang)}</button>
        </div>
      </div>
    </div>
  );
}
