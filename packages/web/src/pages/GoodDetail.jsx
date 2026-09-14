import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, notes } from '../api.js';
import { useLivePrices } from '../useLivePrices.js';
import { colorFor } from './Market.jsx';

export default function GoodDetail({ auth }) {
  const { id } = useParams();
  const [good, setGood] = useState(null);
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState('24h');
  const [error, setError] = useState(null);
  const live = useLivePrices(id);

  const load = useCallback(async () => {
    try {
      const [g, h] = await Promise.all([
        api(`/goods/${id}`),
        api(`/goods/${id}/history?range=${range}`),
      ]);
      setGood(g.good);
      setHistory(h.points);
    } catch (e) {
      setError(e.message);
    }
  }, [id, range]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="err">{error}</p>;
  if (!good) return <p className="muted">Loading…</p>;

  const update = live[id];
  const price = update?.price ?? good.price;
  const supply = update?.supply ?? good.supply;

  return (
    <>
      <h2>
        <span className="tag" style={{ background: colorFor(good.colorToken) }} />
        {good.name}
      </h2>

      <div className="panel">
        <span className="stat">
          <span className="label">Price here</span>
          <span className="value num">{price.toFixed(2)}</span>
        </span>
        <span className="stat">
          <span className="label">Supply</span>
          <span className="value num">{notes(supply)}</span>
        </span>
        <span className="stat">
          <span className="label">Curve</span>
          <span className="value num">
            k={notes(good.k)} n={good.n}
          </span>
        </span>
      </div>

      {good.across && good.across.length > 1 && (
        <div className="panel">
          <strong style={{ fontSize: 13 }}>What it costs in each market</strong>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {good.across.map((r) => {
                const diff = ((r.price - price) / price) * 100;
                return (
                  <tr key={r.region}>
                    <td>
                      {r.name}
                      {r.region === good.region && <span className="muted"> · here</span>}
                    </td>
                    <td className="r num">{r.price.toFixed(2)}</td>
                    <td className={`r num ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'muted'}`}>
                      {r.region === good.region ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`}
                    </td>
                    <td className="r num muted">{notes(r.supply)} in stock</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginBottom: 8 }}>
        {['1h', '24h', '7d', '30d'].map((r) => (
          <button
            key={r}
            className="plain"
            onClick={() => setRange(r)}
            style={{ marginRight: 6, fontWeight: r === range ? 600 : 400 }}
          >
            {r}
          </button>
        ))}
      </div>

      {history.length === 0 ? (
        <p className="muted">
          No price history yet. The drift job writes a reading every minute — start it with
          <code> npm run dev --workspace=@tgc/jobs</code>.
        </p>
      ) : (
        <div style={{ height: 220, marginBottom: 20 }}>
          <ResponsiveContainer>
            <LineChart data={history.map((p) => ({ ...p, t: new Date(p.at).getTime() }))}>
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) =>
                  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                }
                fontSize={12}
              />
              <YAxis domain={['auto', 'auto']} fontSize={12} width={60} />
              <Tooltip
                labelFormatter={(t) => new Date(t).toLocaleString()}
                formatter={(v) => [Number(v).toFixed(2), 'Price']}
              />
              <Line
                type="monotone"
                dataKey="price"
                stroke={colorFor(good.colorToken)}
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <TradePanel good={good} auth={auth} onDone={load} />
      {auth.user && <ShortPanel good={good} auth={auth} onDone={load} />}
    </>
  );
}

/**
 * Short selling.
 *
 * Kept on its own panel rather than folded into the trade form, because
 * it is a different kind of bet and the collateral rules need saying
 * before anyone commits to one.
 */
function ShortPanel({ good, auth, onDone }) {
  const [qty, setQty] = useState(100);
  const [rules, setRules] = useState(null);
  const [open, setOpen] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api('/shorts/rules'), api('/shorts')])
      .then(([r, p]) => {
        setRules(r);
        setOpen(p.positions.filter((x) => x.goodId === good.id));
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [good.id]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await auth.refresh();
      load();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!rules) return null;

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Bet against it</h3>
      <p className="muted">{rules.explanation}</p>

      {open.length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th className="r">Units</th>
              <th className="r">Entry</th>
              <th className="r">Now</th>
              <th className="r">Forced out at</th>
              <th className="r">P/L</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td className="r num">{notes(p.quantity)}</td>
                <td className="r num">{p.entryPrice}</td>
                <td className="r num">{p.currentPrice}</td>
                <td className="r num down">{p.liquidationPrice}</td>
                <td className={`r num ${p.unrealizedPL >= 0 ? 'up' : 'down'}`}>
                  {p.unrealizedPL >= 0 ? '+' : ''}
                  {notes(p.unrealizedPL)}
                </td>
                <td className="r">
                  <button
                    className="plain"
                    disabled={busy}
                    onClick={() => act(() => api(`/shorts/${p.id}/close`, { method: 'POST' }))}
                  >
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row">
        <div className="col" style={{ maxWidth: 200 }}>
          <label>Units to short</label>
          <input
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </div>
      </div>

      {error && <p className="err">{error}</p>}

      <p style={{ marginTop: 12 }}>
        <button
          disabled={busy || qty < 1}
          onClick={() =>
            act(() => api('/shorts', { method: 'POST', body: { goodId: good.id, qty } }))
          }
        >
          {busy ? 'Working…' : `Short ${qty}`}
        </button>
      </p>
    </div>
  );
}

function TradePanel({ good, auth, onDone }) {
  const [side, setSide] = useState('buy');
  const [qty, setQty] = useState(100);
  const [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Re-quote whenever the inputs change. The quote is non-binding - by
  // the time you act on it someone else may have moved the price, which
  // is exactly what the slippage bound is for.
  useEffect(() => {
    setQuote(null);
    setError(null);
    if (!qty || qty < 1) return;

    let cancelled = false;
    api(`/goods/${good.id}/quote?side=${side}&qty=${qty}`)
      .then((q) => !cancelled && setQuote(q))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [good.id, side, qty]);

  if (!auth.user) {
    return (
      <div className="panel">
        <p className="muted">Sign in to trade.</p>
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api('/trades', {
        method: 'POST',
        body: { goodId: good.id, side, qty: Number(qty), slippageBps: Number(slippage) },
      });
      setResult(res);
      await auth.refresh();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Trade</h3>
      <form onSubmit={submit}>
        <div className="row">
          <div className="col">
            <label>Side</label>
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          <div className="col">
            <label>Quantity</label>
            <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="col">
            <label>Max slippage (basis points)</label>
            <input
              type="number"
              min="0"
              max="5000"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </div>
        </div>

        {quote && (
          <p className="muted" style={{ marginTop: 12 }}>
            {side === 'buy' ? 'Costs' : 'Returns'} <span className="num">{notes(quote.total)}</span>{' '}
            Notes — average <span className="num">{quote.avgPrice.toFixed(2)}</span> per unit versus
            a displayed price of <span className="num">{quote.spotPrice.toFixed(2)}</span>.
            {side === 'sell' && (
              <>
                {' '}
                Spread taken: <span className="num">{notes(quote.spread)}</span>.
              </>
            )}{' '}
            Price afterwards: <span className="num">{quote.priceAfter.toFixed(2)}</span>. Most you
            may move in one trade: <span className="num">{notes(quote.maxQty)}</span>.
          </p>
        )}

        {error && <p className="err">{error}</p>}
        {result && (
          <p className="ok">
            Done. {result.trade.side === 'buy' ? 'Paid' : 'Received'}{' '}
            <span className="num">{notes(result.trade.notional)}</span> Notes. Cash now{' '}
            <span className="num">{notes(result.cash)}</span>.
          </p>
        )}

        <p style={{ marginTop: 12 }}>
          <button disabled={busy || !quote}>
            {busy ? 'Executing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${qty}`}
          </button>
        </p>
      </form>
    </div>
  );
}
