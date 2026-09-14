import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { notes } from '../ui/index.jsx';

/**
 * The ledger, bottom right.
 *
 * Always present rather than a page you navigate to, because the news is
 * what tells you why a price moved - and news you have to go and look for
 * is news you read after it stopped mattering.
 *
 * It opens with a fold: the paper unfolds from the crease, which is the
 * one flourish in the interface that is purely for pleasure. It is
 * suppressed under prefers-reduced-motion.
 */
export function Ledger() {
  const [tab, setTab] = useState('wire');
  const [paper, setPaper] = useState(null);
  const [events, setEvents] = useState([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);

  const load = () => {
    api('/events?limit=14')
      .then((d) => setEvents(d.events))
      .catch(() => {});
    api('/newspaper')
      .then((d) => setPaper(d.newspaper))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    // The wire is the only thing on screen that updates without a user
    // action, so it polls. Slowly - events fire about once a minute.
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, []);

  // Unread count, so a closed panel still says something happened.
  const unread = Math.max(0, events.length - seen);

  function openPaper() {
    setTab('paper');
    setOpen(false);
    // A tick's delay so the class change actually animates rather than
    // being applied in the same frame the element appears.
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  }

  return (
    <section className="ledger-panel">
      <header className="ledger-head">
        <div className="segmented small">
          <button
            aria-pressed={tab === 'wire'}
            onClick={() => {
              setTab('wire');
              setSeen(events.length);
            }}
          >
            Wire
            {unread > 0 && tab !== 'wire' && <span className="pip">{unread}</span>}
          </button>
          <button aria-pressed={tab === 'paper'} onClick={openPaper}>
            Ledger
          </button>
        </div>
        {paper && tab === 'paper' && (
          <span className="faint small num">{notes(paper.tradeCount)} trades</span>
        )}
      </header>

      {tab === 'wire' ? (
        <div className="wire">
          {events.length === 0 ? (
            <p className="faint small" style={{ padding: 12 }}>
              Nothing on the wire yet. Word travels about once a minute.
            </p>
          ) : (
            events.map((e) => {
              const rose = e.priceAfter > e.priceBefore;
              return (
                <article className="wire-item" key={e._id}>
                  <span className={`wire-mark ${rose ? 'up' : 'down'}`}>{rose ? '▲' : '▼'}</span>
                  <div>
                    <p className="wire-text">{e.headline}</p>
                    <p className="wire-sub num">
                      {e.priceBefore} → <span className={rose ? 'up' : 'down'}>{e.priceAfter}</span>
                    </p>
                  </div>
                </article>
              );
            })
          )}
        </div>
      ) : (
        <div className={`paper ${open ? 'is-open' : ''}`}>
          <div className="paper-inner">
            <div className="paper-masthead">
              <span className="paper-title">The Daily Ledger</span>
              <span className="paper-rule" />
              <span className="paper-dateline num">
                {paper?.date ?? '—'} · {paper ? notes(paper.volume) : '—'} Notes turned over
              </span>
            </div>

            {!paper ? (
              <p className="faint small">No edition has gone to press yet.</p>
            ) : (
              paper.headlines.map((h, i) => (
                <article className="paper-story" key={i}>
                  <h4>{h.text}</h4>
                </article>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
