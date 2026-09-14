import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, notes } from '../api.js';

export default function Profile() {
  const { username } = useParams();
  const [player, setPlayer] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/players/${username}`)
      .then((d) => setPlayer(d.player))
      .catch((e) => setError(e.message));
  }, [username]);

  if (error) return <p className="err">{error}</p>;
  if (!player) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>{player.username}</h2>

      <div className="panel">
        <span className="stat">
          <span className="label">Net worth</span>
          <span className="value num">{notes(player.netWorth)}</span>
        </span>
        <span className="stat">
          <span className="label">Rank</span>
          <span className="value num">{player.rank ?? '—'}</span>
        </span>
        <span className="stat">
          <span className="label">Trades</span>
          <span className="value num">{notes(player.tradeCount)}</span>
        </span>
        <span className="stat">
          <span className="label">Member since</span>
          <span className="value">{new Date(player.memberSince).toLocaleDateString()}</span>
        </span>
      </div>

      {player.holdings ? (
        player.holdings.length === 0 ? (
          <p className="muted">Holds nothing right now.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Good</th>
                <th className="r">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {player.holdings.map((h) => (
                <tr key={h.goodId}>
                  <td>
                    <Link to={`/goods/${h.goodId}`}>{h.name}</Link>
                  </td>
                  <td className="r num">{notes(h.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p className="muted">This player keeps their positions private.</p>
      )}
    </>
  );
}
