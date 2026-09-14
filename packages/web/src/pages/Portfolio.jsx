import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { colorFor, notes, money, Figure, Meter, Notice, Empty } from '../ui/index.jsx';

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

  async function claim() {
    try {
      const res = await api('/me/bonus', { method: 'POST' });
      setBonus({ kind: 'ok', text: `Claimed ${notes(res.amount)} Notes.` });
      await auth.refresh();
      load();
    } catch (err) {
      setBonus({ kind: 'err', text: err.message });
    }
  }

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!data) return <p className="muted">Counting the cargo…</p>;

  const net = data.netWorth;
  const pl = data.unrealizedPL;

  return (
    <>
      <div className="page-head">
        <div className="kicker">Standing at {data.region}</div>
        <h2>Your books</h2>
        <p className="lede">
          Everything below is valued at what it would fetch <em>here</em>. The same cargo is worth
          more somewhere else, which is the entire reason to move it.
        </p>
      </div>

      <div className="grid four" style={{ marginBottom: 16 }}>
        <div className="card">
          <Figure label="Net worth" value={<span className="num">{notes(net)}</span>} size="lg" />
        </div>
        <div className="card">
          <Figure label="Cash" value={<span className="num">{notes(data.cash)}</span>} />
        </div>
        <div className="card">
          <Figure
            label="Unrealised"
            value={
              <span className="num">
                {pl >= 0 ? '+' : ''}
                {notes(pl)}
              </span>
            }
            tone={pl >= 0 ? 'up' : 'down'}
          />
        </div>
        <div className="card">
          <Figure
            label="Hold"
            value={
              <span className="num">
                {notes(data.cargo.used)}
                <span className="faint"> / {notes(data.cargo.capacity)}</span>
              </span>
            }
          />
          <Meter used={data.cargo.used} capacity={data.cargo.capacity} />
        </div>
      </div>

      {data.debt > 0 && (
        <Notice kind="err">
          You owe <span className="num">{notes(data.debt)}</span> Notes, and it grows on a timer.{' '}
          <Link to="/bank">Settle it at the Counting House.</Link>
        </Notice>
      )}

      <div style={{ marginBottom: 18 }}>
        <button className="ghost" onClick={claim}>
          Claim the daily bonus
        </button>
        {bonus && (
          <span
            className={`small ${bonus.kind === 'ok' ? 'up' : 'down'}`}
            style={{ marginLeft: 12 }}
          >
            {bonus.text}
          </span>
        )}
      </div>

      {data.shorts?.length > 0 && (
        <>
          <h3>Open shorts</h3>
          <div className="scroller" style={{ marginBottom: 20 }}>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Good</th>
                  <th className="r">Units</th>
                  <th className="r">Entry</th>
                  <th className="r">Now</th>
                  <th className="r">Forced out</th>
                  <th className="r">P/L</th>
                </tr>
              </thead>
              <tbody>
                {data.shorts.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/goods/${s.goodId}`} className="good-name">
                        {s.name}
                      </Link>
                      <span className="chip" style={{ marginLeft: 8 }}>
                        {s.region}
                      </span>
                    </td>
                    <td className="r num">{notes(s.quantity)}</td>
                    <td className="r num">{money(s.entryPrice)}</td>
                    <td className="r num">{money(s.currentPrice)}</td>
                    <td className="r num down">{money(s.liquidationPrice)}</td>
                    <td className={`r num ${s.unrealizedPL >= 0 ? 'up' : 'down'}`}>
                      {s.unrealizedPL >= 0 ? '+' : ''}
                      {notes(s.unrealizedPL)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Cargo</h3>
      {data.holdings.length === 0 ? (
        <Empty>
          The hold is empty. <Link to="/">Find something worth carrying.</Link>
        </Empty>
      ) : (
        <div className="scroller">
          <table className="ledger">
            <thead>
              <tr>
                <th>Good</th>
                <th className="r">Units</th>
                <th className="r">Paid</th>
                <th className="r">Price here</th>
                <th className="r">Worth here</th>
                <th className="r">P/L</th>
              </tr>
            </thead>
            <tbody>
              {data.holdings.map((h) => (
                <tr key={h.goodId}>
                  <td>
                    <span className="good">
                      <span className="swatch" style={{ background: colorFor(h.colorToken) }} />
                      <Link to={`/goods/${h.goodId}`} className="good-name">
                        {h.name}
                      </Link>
                    </span>
                  </td>
                  <td className="r num">{notes(h.quantity)}</td>
                  <td className="r num muted">{money(h.avgCost)}</td>
                  <td className="r num">{money(h.currentPrice)}</td>
                  <td className="r num">{notes(h.value)}</td>
                  <td className={`r num ${h.unrealizedPL >= 0 ? 'up' : 'down'}`}>
                    {h.unrealizedPL >= 0 ? '+' : ''}
                    {notes(h.unrealizedPL)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="small faint" style={{ marginTop: 12 }}>
        Cargo is valued at what selling it right now would actually return — spread taken, curve
        walked back down — not at the shown price times quantity.
      </p>
    </>
  );
}
