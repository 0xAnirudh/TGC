import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api.js';
import { useLivePrices } from '../useLivePrices.js';
import { colorFor, notes, money, Price, Figure, Notice, Meter } from '../ui/index.jsx';

const RANGES = ['1h', '24h', '7d', '30d'];

export default function GoodDetail({ auth }) {
  const { id } = useParams();
  const [good, setGood] = useState(null);
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState('1h');
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

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!good) return <p className="muted">Fetching the book…</p>;

  const update = live[id];
  const price = update?.price ?? good.price;
  const supply = update?.supply ?? good.supply;
  const tint = colorFor(good.colorToken);

  const here = good.across?.find((r) => r.region === good.region);
  const best = good.across?.reduce((a, b) => (b.price > (a?.price ?? -1) ? b : a), null);
  const worthMoving = best && here && best.region !== here.region;

  const series = history.map((p) => ({ ...p, t: new Date(p.at).getTime() }));
  const first = series[0]?.price;
  const changePct = first ? ((price - first) / first) * 100 : null;

  return (
    <>
      <div className="page-head">
        <div className="kicker">{good.issuerId ? 'Trader-issued good' : 'Good'}</div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="swatch" style={{ background: tint, height: 30, width: 10 }} />
          {good.name}
        </h2>
      </div>

      <div className="grid four" style={{ marginBottom: 16 }}>
        <div className="card">
          <Figure
            label={`Price · ${good.region}`}
            value={<Price value={price} />}
            size="lg"
            sub={
              changePct === null ? null : (
                <span className={changePct >= 0 ? 'up' : 'down'}>
                  {changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}% this {range}
                </span>
              )
            }
          />
        </div>
        <div className="card">
          <Figure label="In stock here" value={<span className="num">{notes(supply)}</span>} />
        </div>
        <div className="card">
          <Figure
            label="Curve"
            value={<span className="num">n={good.n}</span>}
            sub={`k = ${notes(good.k)} · ${good.n === 1 ? 'gentle' : good.n === 2 ? 'moderate' : 'steep'}`}
          />
        </div>
        <div className="card">
          <Figure
            label="Best market"
            value={<span className="num">{best ? money(best.price) : '—'}</span>}
            sub={best?.name}
            tone={worthMoving ? 'up' : ''}
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h3 style={{ margin: 0 }}>Price history</h3>
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r} aria-pressed={r === range} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {series.length < 2 ? (
          <p className="muted small">
            Not enough readings yet. The market is sampled every few seconds — give it a minute.
          </p>
        ) : (
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={tint} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={tint} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t) =>
                    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  }
                  stroke="var(--ink-faint)"
                  tick={{ fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--rule)' }}
                  minTickGap={40}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  stroke="var(--ink-faint)"
                  tick={{ fontSize: 11, fontFamily: 'JetBrains Mono' }}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--rule-strong)',
                    borderRadius: 3,
                    fontSize: 12,
                    fontFamily: 'JetBrains Mono',
                    color: 'var(--ink)',
                  }}
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                  formatter={(v) => [money(Number(v)), 'Price']}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={tint}
                  strokeWidth={2}
                  fill="url(#fade)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {good.across && good.across.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h3 style={{ margin: 0 }}>What it fetches in each market</h3>
            {worthMoving && (
              <span className="chip here">
                +{(((best.price - here.price) / here.price) * 100).toFixed(1)}% at {best.name}
              </span>
            )}
          </div>

          {/* Bars rather than a column of numbers: the point is which one
              is tallest, and that should not need reading. */}
          {good.across.map((r) => {
            const max = Math.max(...good.across.map((x) => x.price));
            const isHere = r.region === good.region;
            return (
              <div
                key={r.region}
                style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}
              >
                <span style={{ width: 150, fontSize: 13, fontWeight: isHere ? 600 : 400 }}>
                  {r.name}
                  {isHere && <span className="faint small"> · here</span>}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 20,
                    background: 'var(--surface-sunk)',
                    borderRadius: 2,
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${(r.price / max) * 100}%`,
                      background: isHere ? tint : 'var(--rule-strong)',
                      borderRadius: 2,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </span>
                <span className="num" style={{ width: 90, textAlign: 'right' }}>
                  {money(r.price)}
                </span>
                <span className="num faint small" style={{ width: 80, textAlign: 'right' }}>
                  {notes(r.supply)} held
                </span>
              </div>
            );
          })}
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            Carrying goods between markets is how the difference is collected — see{' '}
            <Link to="/travel">the road</Link>.
          </p>
        </div>
      )}

      <div className="grid two">
        <TradePanel good={good} auth={auth} onDone={load} />
        {auth.user && <ShortPanel good={good} auth={auth} onDone={load} />}
      </div>
    </>
  );
}

function TradePanel({ good, auth, onDone }) {
  const [side, setSide] = useState('buy');
  const [qty, setQty] = useState(100);
  const [slippage, setSlippage] = useState(100);
  const [quote, setQuote] = useState(null);
  const [cargo, setCargo] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadCargo = () =>
    api('/world/cargo')
      .then(setCargo)
      .catch(() => setCargo(null));

  useEffect(() => {
    if (auth.user) loadCargo();
  }, [auth.user]);

  // Re-quote on every change. The quote is non-binding: by the time you
  // act on it someone may have moved the price, which is exactly what
  // the slippage bound is for.
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
      <div className="card">
        <h3>Trade</h3>
        <p className="muted">
          <Link to="/login">Open an account</Link> to trade here.
        </p>
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
      loadCargo();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const overCargo = side === 'buy' && cargo && qty > cargo.free;

  return (
    <div className="card">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>Trade</h3>
        <div className="segmented">
          <button aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
            Buy
          </button>
          <button aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
            Sell
          </button>
        </div>
      </div>

      <form onSubmit={submit}>
        <div className="grid two">
          <div>
            <label>Quantity</label>
            <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <label>Slippage tolerance (bps)</label>
            <input
              type="number"
              min="0"
              max="5000"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </div>
        </div>

        {cargo && side === 'buy' && (
          <div style={{ marginTop: 12 }}>
            <div className="label">
              Hold · {notes(cargo.used)} of {notes(cargo.capacity)} used
            </div>
            <Meter
              used={cargo.used + (overCargo ? 0 : Number(qty) || 0)}
              capacity={cargo.capacity}
            />
          </div>
        )}

        {quote && (
          <div className="card tight" style={{ marginTop: 14, background: 'var(--surface-sunk)' }}>
            <div className="grid three">
              <Figure
                label={side === 'buy' ? 'You pay' : 'You receive'}
                value={<span className="num">{notes(quote.total)}</span>}
              />
              <Figure
                label="Per unit"
                value={<span className="num">{money(quote.avgPrice)}</span>}
                sub={`shown price ${money(quote.spotPrice)}`}
              />
              <Figure
                label="Price after"
                value={<span className="num">{money(quote.priceAfter)}</span>}
                sub={
                  side === 'sell'
                    ? `spread ${notes(quote.spread)}`
                    : `max ${notes(quote.maxQty)} per trade`
                }
              />
            </div>
            <p className="small faint" style={{ margin: '10px 0 0' }}>
              A large order walks the curve — you pay the average, not the shown price.
            </p>
          </div>
        )}

        {overCargo && (
          <Notice kind="err">
            Only {notes(cargo.free)} units of room left. <Link to="/bank">Expand the hold</Link> or
            buy fewer.
          </Notice>
        )}
        {error && <Notice kind="err">{error}</Notice>}
        {result && (
          <Notice kind="ok">
            Done. {result.trade.side === 'buy' ? 'Paid' : 'Received'}{' '}
            <span className="num">{notes(result.trade.notional)}</span> Notes.
          </Notice>
        )}

        <button
          className={side === 'buy' ? 'buy' : 'sell'}
          style={{ marginTop: 14, width: '100%' }}
          disabled={busy || !quote || overCargo}
        >
          {busy ? 'Executing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${notes(qty)} ${good.name}`}
        </button>
      </form>
    </div>
  );
}

/**
 * Shorting, on its own panel.
 *
 * Kept apart from buy/sell because it is a different kind of bet, and
 * the collateral and the forced-close price have to be said before
 * anyone commits rather than discovered afterwards.
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
      await load();
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!rules) return null;

  return (
    <div className="card">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>Bet against it</h3>
        <span className="chip">forced out at {rules.liquidationRatio}× entry</span>
      </div>

      <p className="muted small">
        Sell units you do not own and buy them back later. You profit if the price falls. Collateral
        is locked up front, and that collateral is the most you can lose.
      </p>

      {open.length > 0 && (
        <div className="scroller" style={{ margin: '12px 0' }}>
          <table className="ledger">
            <thead>
              <tr>
                <th className="r">Units</th>
                <th className="r">Entry</th>
                <th className="r">Now</th>
                <th className="r">Forced out</th>
                <th className="r">P/L</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <tr key={p.id}>
                  <td className="r num">{notes(p.quantity)}</td>
                  <td className="r num">{money(p.entryPrice)}</td>
                  <td className="r num">{money(p.currentPrice)}</td>
                  <td className="r num down">{money(p.liquidationPrice)}</td>
                  <td className={`r num ${p.unrealizedPL >= 0 ? 'up' : 'down'}`}>
                    {p.unrealizedPL >= 0 ? '+' : ''}
                    {notes(p.unrealizedPL)}
                  </td>
                  <td className="r">
                    <button
                      className="ghost tiny"
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
        </div>
      )}

      <label style={{ marginTop: 10 }}>Units to short</label>
      <input type="number" min="1" value={qty} onChange={(e) => setQty(Number(e.target.value))} />

      {error && <Notice kind="err">{error}</Notice>}

      <button
        className="ghost"
        style={{ marginTop: 12, width: '100%' }}
        disabled={busy || qty < 1}
        onClick={() =>
          act(() => api('/shorts', { method: 'POST', body: { goodId: good.id, qty } }))
        }
      >
        {busy ? 'Working…' : `Short ${notes(qty)} ${good.name}`}
      </button>
    </div>
  );
}
