import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { notes, Figure, Notice, Empty } from '../ui/index.jsx';

export default function Profile() {
  const { username } = useParams();
  const [player, setPlayer] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/players/${username}`)
      .then((d) => setPlayer(d.player))
      .catch((e) => setError(e.message));
  }, [username]);

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!player) return <p className="muted">Looking them up…</p>;

  return (
    <>
      <div className="page-head">
        <div className="kicker">Trader</div>
        <h2>{player.username}</h2>
      </div>

      <div className="grid four" style={{ marginBottom: 16 }}>
        <div className="card">
          <Figure
            label="Net worth"
            value={<span className="num">{notes(player.netWorth)}</span>}
            size="lg"
          />
        </div>
        <div className="card">
          <Figure
            label="Rank"
            value={<span className="num">{player.rank ?? '—'}</span>}
            tone={player.rank === 1 ? 'up' : ''}
          />
        </div>
        <div className="card">
          <Figure label="Trades" value={<span className="num">{notes(player.tradeCount)}</span>} />
        </div>
        <div className="card">
          <Figure
            label="Trading since"
            value={
              <span className="num" style={{ fontSize: 16 }}>
                {new Date(player.memberSince).toLocaleDateString()}
              </span>
            }
          />
        </div>
      </div>

      <h3>Cargo</h3>
      {!player.holdings ? (
        <Empty>This trader keeps their positions private.</Empty>
      ) : player.holdings.length === 0 ? (
        <Empty>Holding nothing at present.</Empty>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Good</th>
              <th className="r">Units</th>
            </tr>
          </thead>
          <tbody>
            {player.holdings.map((h) => (
              <tr key={h.goodId}>
                <td>
                  <Link to={`/goods/${h.goodId}`} className="good-name">
                    {h.name}
                  </Link>
                </td>
                <td className="r num">{notes(h.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
