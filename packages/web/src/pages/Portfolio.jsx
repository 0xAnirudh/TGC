import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, notes } from '../api.js';
import { colorFor } from './Market.jsx';

export default function Portfolio({ auth }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [bonus, setBonus] = useState(null);

  const load = () =>
    api('/portfolio')
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function claimBonus() {
    try {
      const res = await api('/me/bonus', { method: 'POST' });
      setBonus(`Claimed ${notes(res.amount)} Notes.`);
      await auth.refresh();
      load();
    } catch (err) {
      setBonus(err.message);
    }
  }

  if (error) return <p className="err">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>Portfolio</h2>

      <div className="panel">
        <span className="stat">
          <span className="label">Cash</span>
          <span className="value num">{notes(data.cash)}</span>
        </span>
        <span className="stat">
          <span className="label">Holdings</span>
          <span className="value num">{notes(data.holdingsValue)}</span>
        </span>
        <span className="stat">
          <span className="label">Net worth</span>
          <span className="value num">{notes(data.netWorth)}</span>
        </span>
        <span className="stat">
          <span className="label">Unrealised P/L</span>
          <span className={`value num ${data.unrealizedPL >= 0 ? 'up' : 'down'}`}>
            {data.unrealizedPL >= 0 ? '+' : ''}
            {notes(data.unrealizedPL)}
          </span>
        </span>
      </div>

      <p>
        <button className="plain" onClick={claimBonus}>
          Claim daily bonus
        </button>
        {bonus && (
          <span className="muted" style={{ marginLeft: 12 }}>
            {bonus}
          </span>
        )}
      </p>

      <p className="muted">
        Holdings are valued at what selling them right now would actually return — spread taken and
        the curve walked back down — not at the displayed price times quantity.
      </p>

      {data.holdings.length === 0 ? (
        <p className="muted">
          Nothing held yet. <Link to="/">Go to the market.</Link>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Good</th>
              <th className="r">Quantity</th>
              <th className="r">Avg cost</th>
              <th className="r">Price</th>
              <th className="r">Value</th>
              <th className="r">P/L</th>
            </tr>
          </thead>
          <tbody>
            {data.holdings.map((h) => (
              <tr key={h.goodId}>
                <td>
                  <span className="tag" style={{ background: colorFor(h.colorToken) }} />
                  <Link to={`/goods/${h.goodId}`}>{h.name}</Link>
                </td>
                <td className="r num">{notes(h.quantity)}</td>
                <td className="r num">{h.avgCost.toFixed(2)}</td>
                <td className="r num">{h.currentPrice.toFixed(2)}</td>
                <td className="r num">{notes(h.value)}</td>
                <td className={`r num ${h.unrealizedPL >= 0 ? 'up' : 'down'}`}>
                  {h.unrealizedPL >= 0 ? '+' : ''}
                  {notes(h.unrealizedPL)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
