import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { notes, Notice, Empty } from '../ui/index.jsx';

/**
 * The broadsheet.
 *
 * Set like a real front page - masthead, rules, dateline, two columns -
 * because the paper is the one part of the game that is meant to be read
 * rather than scanned, and a table of headlines would read like a log
 * file.
 */
export default function Newspaper() {
  const [paper, setPaper] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    api('/newspaper')
      .then((d) => setPaper(d.newspaper))
      .catch((e) => (e.code === 'no_newspaper' ? setMissing(true) : setError(e.message)));
    api('/events?limit=8')
      .then((d) => setEvents(d.events))
      .catch(() => {});
  }, []);

  if (error) return <Notice kind="err">{error}</Notice>;

  return (
    <>
      <div className="broadsheet">
        <h1 className="title">The Daily Ledger</h1>
        <div className="rules" />
        <div className="dateline">
          <span>{paper?.date ?? new Date().toISOString().slice(0, 10)}</span>
          <span>Published by the General Company</span>
          <span>
            {paper ? (
              <>
                {notes(paper.tradeCount)} trades · {notes(paper.volume)} Notes turned over
              </>
            ) : (
              'No edition'
            )}
          </span>
        </div>

        {missing || !paper ? (
          <Empty>
            No edition has gone to press yet. The paper is set once an hour from the last day of
            trading.
          </Empty>
        ) : (
          <div className="columns">
            {paper.headlines.map((h, i) => (
              <div className="story" key={i}>
                <h4>{h.text}</h4>
                <p className="small faint">{h.template.replace(/_/g, ' ')}</p>
              </div>
            ))}

            {events.map((e) => (
              <div className="story" key={e._id}>
                <h4>{e.headline}</h4>
                <p>
                  Price moved from <span className="num">{e.priceBefore}</span> to{' '}
                  <span className={`num ${e.priceAfter > e.priceBefore ? 'up' : 'down'}`}>
                    {e.priceAfter}
                  </span>
                  .
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="small faint" style={{ marginTop: 14, textAlign: 'center' }}>
        Written from templates, not generated. Each story keeps the facts it was built from, so it
        stays a record rather than prose.
      </p>
    </>
  );
}
