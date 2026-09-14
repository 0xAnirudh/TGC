import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, notes } from '../api.js';
import { useLivePrices } from '../useLivePrices.js';

export default function Market() {
  const [goods, setGoods] = useState(null);
  const [region, setRegion] = useState(null);
  const [regions, setRegions] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const live = useLivePrices();

  useEffect(() => {
    Promise.all([api('/goods'), api('/world/regions'), api('/events?limit=4')])
      .then(([g, r, e]) => {
        setGoods(g.goods);
        setRegion(g.region);
        setRegions(r.regions);
        setEvents(e.events);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="err">{error}</p>;
  if (!goods) return <p className="muted">Loading…</p>;

  const here = regions.find((r) => r.id === region);

  return (
    <>
      <h2>{here ? here.name : 'Market'}</h2>
      <p className="muted">
        {here?.blurb} Prices come from a curve, not from other players — buying pushes a price up,
        selling pushes it down. The same good costs differently in each of the four markets, and
        that gap is the game. <Link to="/travel">See the map.</Link>
      </p>

      {events.length > 0 && (
        <div className="panel">
          <strong style={{ fontSize: 13 }}>Word from the road</strong>
          {events.map((e) => (
            <p key={e._id} className="muted" style={{ margin: '5px 0' }}>
              {e.headline}{' '}
              <span className={e.priceAfter > e.priceBefore ? 'up' : 'down'}>
                {e.priceBefore} → {e.priceAfter}
              </span>
            </p>
          ))}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Good</th>
            <th className="r">Price here</th>
            <th className="r">Supply</th>
            <th className="r">Best elsewhere</th>
            <th className="r">Gap</th>
          </tr>
        </thead>
        <tbody>
          {goods.map((g) => {
            // A live update, when one has arrived, is newer than the
            // value this page loaded with.
            const update = live[g.id];
            const price = update?.price ?? g.price;
            const supply = update?.supply ?? g.supply;

            const best = g.bestElsewhere;
            const regionName = regions.find((r) => r.id === best?.region)?.name ?? '';

            return (
              <tr key={g.id}>
                <td>
                  <span className="tag" style={{ background: colorFor(g.colorToken) }} />
                  <Link to={`/goods/${g.id}`}>{g.name}</Link>
                  {g.issuerId && <span className="muted"> · player-issued</span>}
                </td>
                <td className="r num">{price === null ? '—' : price.toFixed(2)}</td>
                <td className="r num">{notes(supply)}</td>
                <td className="r num muted">
                  {best ? `${best.price.toFixed(2)}` : '—'}
                  {best && <span className="muted"> · {regionName.split(' ').pop()}</span>}
                </td>
                <td className={`r num ${g.spreadPct > 0 ? 'up' : ''}`}>
                  {g.spreadPct === null ? '—' : `${g.spreadPct > 0 ? '+' : ''}${g.spreadPct}%`}
                </td>
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
