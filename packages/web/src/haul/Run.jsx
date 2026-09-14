import { useEffect, useState, useCallback } from 'react';
import * as haul from './api.js';
import { notes, money, Notice } from '../ui/index.jsx';
import { PriceBoard } from './Board.jsx';
import { RouteMap } from './RouteMap.jsx';

/**
 * A haul in progress.
 *
 * One screen, because a run is one continuous decision and there is
 * nowhere else to be. The day counter, the purse and the debt sit across
 * the top where they are unavoidable - the debt especially, since the
 * whole game is a race against it.
 */
export function RunScreen({ run, setRun, onFinished }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [event, setEvent] = useState(null);
  const [moving, setMoving] = useState(false);
  const [flash, setFlash] = useState(null);

  const act = useCallback(
    async (fn, { travelling = false } = {}) => {
      setBusy(true);
      setError(null);
      try {
        if (travelling) setMoving(true);
        const res = await fn();
        if (res.run) setRun(res.run);
        if (res.event) setEvent(res.event);
        return res;
      } catch (e) {
        setError(e.message);
        return null;
      } finally {
        setBusy(false);
        setTimeout(() => setMoving(false), 420);
      }
    },
    [setRun],
  );

  // Clear the road report once the player has had a moment with it.
  useEffect(() => {
    if (!event) return;
    const id = setTimeout(() => setEvent(null), 9_000);
    return () => clearTimeout(id);
  }, [event]);

  const lastDay = run.day >= run.totalDays;
  const netNow = run.cash - run.debt;

  async function doBuy(good, qty) {
    const res = await act(() => haul.buy(good, qty));
    if (res) setFlash({ kind: 'buy', good, qty });
  }
  async function doSell(good, qty) {
    const res = await act(() => haul.sell(good, qty));
    if (res) setFlash({ kind: 'sell', good, qty });
  }

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1_600);
    return () => clearTimeout(id);
  }, [flash]);

  return (
    <div className="run">
      <header className="run-bar">
        <div className="day">
          <span className="day-n num">{run.day}</span>
          <span className="day-of">of {run.totalDays}</span>
          {/* A bar rather than only a number: how much run is left is
              the thing every decision is weighed against. */}
          <span className="day-bar">
            <span style={{ width: `${(run.day / run.totalDays) * 100}%` }} />
          </span>
        </div>

        <div className="tally">
          <div className="tally-item">
            <span className="label">Notes</span>
            <span className="v num">{notes(run.cash)}</span>
          </div>
          <div className="tally-item">
            <span className="label">Owed</span>
            <span className="v num down">{notes(run.debt)}</span>
            <span className="sub faint num">+{notes(run.debtTomorrow - run.debt)} tomorrow</span>
          </div>
          <div className="tally-item">
            <span className="label">Cart</span>
            <span className="v num">
              {notes(run.carried)}
              <span className="faint">/{notes(run.capacity)}</span>
            </span>
            <span className="meter tiny">
              <span style={{ width: `${(run.carried / run.capacity) * 100}%` }} />
            </span>
          </div>
          <div className="tally-item">
            <span className="label">If it ended now</span>
            <span className={`v num ${netNow >= 0 ? 'up' : 'down'}`}>
              {notes(Math.max(0, netNow))}
            </span>
          </div>
        </div>
      </header>

      {error && <Notice kind="err">{error}</Notice>}

      {event && (
        <div className={`road-report ${event.cash < 0 || event.cargo ? 'bad' : 'good'}`}>
          <span className="road-mark">{event.cash < 0 || event.cargo ? '!' : '·'}</span>
          {event.text}
        </div>
      )}

      <div className="run-panes">
        <section>
          <div className="town-head">
            <div>
              <div className="label">Day {run.day} · you are in</div>
              <h2>{run.townName}</h2>
              <p className="faint small">{run.blurb}</p>
            </div>
            <div className="town-actions">
              {run.upgrade && (
                <button
                  className="ghost tiny"
                  disabled={busy || run.cash < run.upgrade.cost}
                  onClick={() => act(() => haul.upgrade())}
                >
                  +{run.upgrade.step} cart · {notes(run.upgrade.cost)}
                </button>
              )}
              <button
                className="ghost tiny"
                disabled={busy || run.debt < 1 || run.cash < 1}
                onClick={() => act(() => haul.repay(Math.min(run.cash, run.debt)))}
              >
                Repay {notes(Math.min(run.cash, run.debt))}
              </button>
            </div>
          </div>

          <PriceBoard run={run} onBuy={doBuy} onSell={doSell} busy={busy} />

          {flash && (
            <p className="small up" style={{ marginTop: 8 }}>
              {flash.kind === 'buy' ? 'Loaded' : 'Sold'} {notes(flash.qty)}.
            </p>
          )}
        </section>

        <aside>
          <RouteMap
            run={run}
            busy={busy}
            moving={moving}
            onTravel={(to) => act(() => haul.travel(to), { travelling: true })}
          />

          {lastDay ? (
            <div className="finish">
              <p className="small">
                Day {run.totalDays}. The cart is sold where you stand and the debt comes out of what
                is left.
              </p>
              <button
                className="buy"
                disabled={busy}
                onClick={async () => {
                  const res = await act(() => haul.end(false));
                  if (res) onFinished(res);
                }}
              >
                Settle up
              </button>
            </div>
          ) : (
            <p className="small faint travel-hint">
              Pick a town to travel. One leg a day — {run.totalDays - run.day} left.
            </p>
          )}

          <button
            className="ghost tiny give-up"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Abandon this haul? It will not be scored.')) return;
              const res = await act(() => haul.end(true));
              if (res) onFinished(res);
            }}
          >
            Abandon
          </button>
        </aside>
      </div>
    </div>
  );
}
