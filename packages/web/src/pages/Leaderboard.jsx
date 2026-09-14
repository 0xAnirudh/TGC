import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { notes, Notice, Empty } from '../ui/index.jsx';

export default function Leaderboard() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/leaderboard')
      .then((d) => setEntries(d.entries))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice kind="err">{error}</Notice>;
  if (!entries) return <p className="muted">Tallying…</p>;

  const top = entries[0]?.netWorth ?? 1;

  return (
    <>
      <div className="page-head">
        <div className="kicker">Standings</div>
        <h2>Who is ahead</h2>
        <p className="lede">
          Net worth is cash plus what every holding would fetch if sold now, valued at the best
          market for it. Recomputed on a schedule — never when you open this page.
        </p>
      </div>

      {entries.length === 0 ? (
        <Empty>The books have not been tallied yet.</Empty>
      ) : (
        <div className="scroller">
          <table className="ledger">
            <thead>
              <tr>
                <th className="r" style={{ width: 60 }}>
                  #
                </th>
                <th>Trader</th>
                <th style={{ width: '40%' }} />
                <th className="r">Net worth</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.username}>
                  <td className="r num faint">{e.rank}</td>
                  <td>
                    <Link to={`/players/${e.username}`} className="good-name">
                      {e.username}
                    </Link>
                  </td>
                  <td>
                    {/* A bar makes the distance between first and tenth
                        legible, which a column of numbers does not. */}
                    <span
                      style={{
                        display: 'block',
                        height: 6,
                        background: 'var(--surface-sunk)',
                        borderRadius: 3,
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          height: '100%',
                          width: `${Math.max(2, (e.netWorth / top) * 100)}%`,
                          background: e.rank === 1 ? 'var(--gold)' : 'var(--accent)',
                          borderRadius: 3,
                        }}
                      />
                    </span>
                  </td>
                  <td className="r num">{notes(e.netWorth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
