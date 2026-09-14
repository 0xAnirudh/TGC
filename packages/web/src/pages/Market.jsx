import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, notes } from '../api.js';
import { useLivePrices } from '../useLivePrices.js';

export default function Market() {
  const [goods, setGoods] = useState(null);
  const [error, setError] = useState(null);
  const live = useLivePrices();

  useEffect(() => {
    api('/goods')
      .then((d) => setGoods(d.goods))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="err">{error}</p>;
  if (!goods) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>Market</h2>
      <p className="muted">
        Prices come from a curve, not from other players. Buying pushes a price up, selling pushes
        it down. Updates arrive live.
      </p>

      <table>
        <thead>
          <tr>
            <th>Good</th>
            <th className="r">Price</th>
            <th className="r">Supply</th>
            <th className="r">Steepness</th>
          </tr>
        </thead>
        <tbody>
          {goods.map((g) => {
            // A live update, when one has arrived, is newer than the
            // value this page loaded with.
            const update = live[g.id];
            const price = update?.price ?? g.price;
            const supply = update?.supply ?? g.supply;

            return (
              <tr key={g.id}>
                <td>
                  <span className="tag" style={{ background: colorFor(g.colorToken) }} />
                  <Link to={`/goods/${g.id}`}>{g.name}</Link>
                  {g.issuerId && <span className="muted"> · player-issued</span>}
                </td>
                <td className="r num">{price === null ? '—' : price.toFixed(2)}</td>
                <td className="r num">{notes(supply)}</td>
                <td className="r num">n={g.n}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function colorFor(token) {
  const map = {
    slate: '#64748b',
    amber: '#d97706',
    orange: '#ea580c',
    violet: '#7c3aed',
    yellow: '#ca8a04',
    blue: '#2563eb',
    indigo: '#4f46e5',
    rose: '#e11d48',
    green: '#059669',
  };
  return map[token] ?? '#64748b';
}
