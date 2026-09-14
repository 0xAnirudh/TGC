import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useLivePrices } from '../useLivePrices.js';
import { colorFor, notes, Price, Sparkline, GapBar, Notice, shortRegion } from '../ui/index.jsx';

/**
 * The market, as seen from wherever you are standing.
 *
 * The two columns that matter are the last two. A price on its own says
 * nothing about what to do with it; the gap against the best other
 * market is the entire decision, and burying it behind four page loads
 * would hide the only number worth looking at.
 */
export default function Market({ auth }) {
  const [goods, setGoods] = useState(null);
  const [region, setRegion] = useState(null);
  const [regions, setRegions] = useState([]);
  const [events, setEvents] = useState([]);
  const [history, setHistory] = useState({});
  const [error, setError] = useState(null);
  const live = useLivePrices();

  useEffect(() => {
    Promise.all([api('/goods'), api('/world/regions'), api('/events?limit=3')])
      .then(([g, r, e]) => {
        setGoods(g.goods);
        setRegion(g.region);
        setRegions(r.regions);
        setEvents(e.events);

        // Sparklines are fetched after the table is already on screen.
        // A shape in a cell is worth having, but not worth making the
        // prices wait for eight extra requests.
        g.goods.forEach((good) => {
          api(`/goods/${good.id}/history?range=1h`)
            .then((h) =>
              setHistory((prev) => ({ ...prev, [good.id]: h.points.map((p) => p.price) })),
            )
            .catch(() => {});
        });
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!goods) return <p className="muted">Reading the prices…</p>;

  const here = regions.find((r) => r.id === region);
  // Widest gap first: the table sorts itself by how interesting each row
  // is, rather than by an arbitrary seed order.
  const sorted = [...goods].sort((a, b) => (b.spreadPct ?? -Infinity) - (a.spreadPct ?? -Infinity));
  const widestGap = Math.max(...goods.map((g) => g.spreadPct ?? 0), 1);

  return (
    <>
      <div className="page-head">
        <div className="kicker">{here ? 'Market at' : 'Market'}</div>
        <h2>{here ? here.name : 'The market'}</h2>
        <p className="lede">
          {here?.blurb} Prices come from a curve, not from other traders — buying pushes one up,
          selling pushes it down. The same good is worth different amounts in each of the four
          markets, and that gap is the whole game. <Link to="/travel">See the road.</Link>
        </p>
      </div>

      {events.length > 0 && (
        <div className="card tight" style={{ marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 7 }}>
            Word from the road
          </div>
          {events.map((e) => {
            const rose = e.priceAfter > e.priceBefore;
            return (
              <div
                key={e._id}
                style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 3 }}
              >
                <span style={{ flex: 1 }}>{e.headline}</span>
                <span className={`num small ${rose ? 'up' : 'down'}`}>
                  {rose ? '▲' : '▼'} {Math.abs(Math.round((e.impactBps / 100) * 10) / 10)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="scroller">
        <table className="ledger">
          <thead>
            <tr>
              <th>Good</th>
              <th className="r">Price here</th>
              <th className="r">Last hour</th>
              <th className="r">In stock</th>
              <th className="r">Best price elsewhere</th>
              <th className="r">Worth carrying</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((g) => {
              // A live update is newer than whatever this page loaded with.
              const update = live[g.id];
              const price = update?.price ?? g.price;
              const supply = update?.supply ?? g.supply;
              const best = g.bestElsewhere;

              return (
                <tr key={g.id}>
                  <td>
                    <span className="good">
                      <span className="swatch" style={{ background: colorFor(g.colorToken) }} />
                      <span>
                        <Link to={`/goods/${g.id}`} className="good-name">
                          {g.name}
                        </Link>
                        {g.issuerId && (
                          <span
                            className="faint small"
                            style={{ display: 'block', lineHeight: 1.2 }}
                          >
                            issued by a trader
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="r">
                    <Price value={price} />
                  </td>
                  <td className="r">
                    <Sparkline points={history[g.id]} color="auto" />
                  </td>
                  <td className="r num muted">{notes(supply)}</td>
                  <td className="r">
                    {best ? (
                      <>
                        <span className="num">{best.price.toFixed(2)}</span>{' '}
                        <span className="chip">
                          {shortRegion(regions.find((r) => r.id === best.region)?.name ?? '')}
                        </span>
                      </>
                    ) : (
                      <span className="faint num">—</span>
                    )}
                  </td>
                  <td className="r">
                    <GapBar pct={g.spreadPct} max={widestGap} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!auth?.user && (
        <p className="muted small" style={{ marginTop: 14 }}>
          <Link to="/login">Open an account</Link> to trade. New traders start with 100,000 Notes.
        </p>
      )}
    </>
  );
}
