import { useSettings } from '../store/settings';
import { t } from '../i18n/translations';

interface Props {
  rankings: { id: string; rank: number | null }[];
  winner: string | null;
  localPlayerId: string;
  onExit: () => void;
}

export default function EndGameModal({ rankings, winner, localPlayerId, onExit }: Props) {
  const { language } = useSettings();
  const lang = language;

  const sorted = [...rankings].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const rowClass = (rank: number | null) => (rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '');

  return (
    <div className="modal-overlay">
      <div className="modal wide">
        <h2>{winner === localPlayerId ? `🏆 ${t('win', lang)}!` : t('gameOver', lang)}</h2>
        {winner && winner !== localPlayerId && (
          <p className="text-dim" style={{ marginBottom: '1rem' }}>
            {t('player', lang)} "{winner.slice(0, 8)}…" {t('win', lang)}
          </p>
        )}
        <div className="rankings">
          {sorted.length === 0 && <p className="text-dim">{t('noRankings', lang)}</p>}
          {sorted.map((r, i) => {
            const rank = r.rank ?? sorted.length;
            return (
              <div key={r.id + i} className={`ranking-row ${rowClass(rank)}`}>
                <div className="position">{rank}</div>
                <div className="grow">
                  <div style={{ fontWeight: 700 }}>
                    {r.id === localPlayerId ? t('you', lang) : `${t('player', lang)} ${r.id.slice(0, 8)}`}
                  </div>
                  <div className="text-dim" style={{ fontSize: '0.75rem' }}>
                    {t('rank', lang)} #{rank}
                  </div>
                </div>
                {rank === 1 && <span style={{ fontSize: '1.4rem' }}>👑</span>}
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button className="primary" onClick={onExit}>🚪 {t('exitToMenu', lang)}</button>
        </div>
      </div>
    </div>
  );
}
