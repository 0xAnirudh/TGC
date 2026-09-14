import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, notes } from '../api.js';

export default function Leaderboard() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/leaderboard')
      .then((d) => setEntries(d.entries))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="err">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>Leaderboard</h2>
      <p className="muted">
        Net worth is cash plus what every holding would fetch if sold now. Recomputed on a schedule,
        never when you load this page.
      </p>

      {entries.length === 0 ? (
        <p className="muted">
          The board has not been built yet. Start the job runner with
          <code> npm run dev --workspace=@tgc/jobs</code>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Player</th>
              <th className="r">Net worth</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.username}>
                <td className="r num">{e.rank}</td>
                <td>
                  <Link to={`/players/${e.username}`}>{e.username}</Link>
                </td>
                <td className="r num">{notes(e.netWorth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
