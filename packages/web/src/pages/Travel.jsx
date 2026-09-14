import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { notes, Notice, Figure } from '../ui/index.jsx';

/**
 * The road.
 *
 * Drawn as a route rather than a list of cards, because the regions have
 * an order: the harbour is where everything lands and the frontier is
 * the far end. Seeing that shape makes the fares legible - the frontier
 * is expensive to reach because it is far, not because of an arbitrary
 * number on a card.
 */
export default function Travel({ auth }) {
  const [regions, setRegions] = useState(null);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [trip, setTrip] = useState(null);
  const [left, setLeft] = useState(0);

  const load = () =>
    api('/world/regions')
      .then((d) => setRegions(d.regions))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  // A live countdown while in transit. Watching the clock run is the
  // only thing that makes the journey feel like a cost rather than a
  // button press.
  useEffect(() => {
    if (!trip) return;
    setLeft(trip.seconds);
    const id = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          load();
          return 0;
        }
        return s - 1;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [trip]);

  async function go(id) {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/world/travel', { method: 'POST', body: { to: id } });
      setTrip(res);
      setTarget(null);
      await auth.refresh();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!regions) return <p className="muted">Consulting the map…</p>;

  const here = regions.find((r) => r.here);
  const selected = regions.find((r) => r.id === target);

  return (
    <>
      <div className="page-head">
        <div className="kicker">The road</div>
        <h2>Where to?</h2>
        <p className="lede">
          The same goods fetch different prices in different places. Buy where something is cheap,
          carry it somewhere it is dear, and the difference is yours — less the fare, and less
          whatever the price does while you are travelling.
        </p>
      </div>

      {error && <Notice kind="err">{error}</Notice>}

      {trip && left > 0 && (
        <Notice kind="info">
          On the road to {regions.find((r) => r.id === trip.to)?.name ?? trip.to}. Arriving in{' '}
          <span className="num">{left}s</span>. Fare paid:{' '}
          <span className="num">{notes(trip.cost)}</span> Notes. You cannot trade until you arrive.
        </Notice>
      )}

      <div className="card">
        <div className="route">
          <div className="stops">
            {regions.map((r) => (
              <div
                key={r.id}
                className={`stop ${r.here ? 'is-here' : ''} ${target === r.id ? 'is-target' : ''}`}
                style={{ opacity: r.here || !target || target === r.id ? 1 : 0.45 }}
              >
                <button
                  className="stop-btn"
                  onClick={() => !r.here && setTarget(r.id)}
                  disabled={r.here}
                >
                  <span className="pin" />
                  <span className="stop-name">{r.name}</span>
                  {r.here ? (
                    <span className="chip here">you are here</span>
                  ) : (
                    <span className="small muted num">
                      {notes(r.travelCost)} · {r.travelSeconds}s
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3 style={{ margin: 0 }}>
              {here?.name} → {selected.name}
            </h3>
          </div>
          <p className="muted">{selected.blurb}</p>
          <div className="grid three" style={{ marginBottom: 16 }}>
            <Figure
              label="Fare"
              value={<span className="num">{notes(selected.travelCost)}</span>}
            />
            <Figure
              label="On the road"
              value={<span className="num">{selected.travelSeconds}s</span>}
              sub="you cannot trade in transit"
            />
            <Figure
              label="After the fare"
              value={
                <span className="num">{notes((auth.user?.cash ?? 0) - selected.travelCost)}</span>
              }
              tone={(auth.user?.cash ?? 0) < selected.travelCost ? 'down' : ''}
            />
          </div>
          <button
            disabled={busy || (auth.user?.cash ?? 0) < selected.travelCost}
            onClick={() => go(selected.id)}
          >
            {busy ? 'Setting off…' : `Set off for ${selected.name}`}
          </button>{' '}
          <button className="ghost" onClick={() => setTarget(null)}>
            Not yet
          </button>
        </div>
      )}
    </>
  );
}
