import { useEffect, useState } from 'react';
import { api, notes } from '../api.js';

/**
 * The map.
 *
 * This is the screen the game is actually about. Each market shows what
 * it costs to get there and what the journey takes, so the decision -
 * is the price gap worth the fare - is made here rather than guessed at.
 */
export default function Travel({ auth }) {
  const [regions, setRegions] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [trip, setTrip] = useState(null);

  const load = () =>
    api('/world/regions')
      .then((d) => setRegions(d.regions))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function go(id) {
    setBusy(id);
    setError(null);
    try {
      const res = await api('/world/travel', { method: 'POST', body: { to: id } });
      setTrip(res);
      await auth.refresh();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (!regions) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>Where to?</h2>
      <p className="muted">
        The same goods cost different amounts in different places. Buy where something is cheap,
        carry it somewhere it is dear, and the gap is yours — minus the fare, and minus whatever the
        price does while you are on the road.
      </p>

      {error && <p className="err">{error}</p>}
      {trip && (
        <p className="ok">
          On the road to {trip.to}. Arriving in {trip.seconds}s. Fare {notes(trip.cost)} Notes.
        </p>
      )}

      <div className="row">
        {regions.map((r) => (
          <div className="col panel" key={r.id} style={{ minWidth: 230 }}>
            <strong>{r.name}</strong>
            {r.here && <span className="muted"> · you are here</span>}
            <p className="muted" style={{ margin: '6px 0 10px' }}>
              {r.blurb}
            </p>

            {r.here ? (
              <span className="muted">—</span>
            ) : (
              <>
                <p className="muted" style={{ margin: '0 0 8px' }}>
                  Fare <span className="num">{notes(r.travelCost)}</span> · {r.travelSeconds}s on
                  the road
                </p>
                <button disabled={busy === r.id} onClick={() => go(r.id)}>
                  {busy === r.id ? 'Setting off…' : 'Travel here'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
