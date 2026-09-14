import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { notes, Figure, Meter, Notice } from '../ui/index.jsx';

/**
 * Loans and cargo.
 *
 * Both are ways of spending now to trade bigger later, which is why they
 * share a page. The debt clock is shown rather than buried - a cost that
 * accrues invisibly is a trap, not a decision, and the whole point of a
 * loan is that you can see it growing and choose to race it.
 */
export default function Bank({ auth, onChanged }) {
  const [loans, setLoans] = useState(null);
  const [cargo, setCargo] = useState(null);
  const [amount, setAmount] = useState(20_000);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [l, c] = await Promise.all([api('/world/loans'), api('/world/cargo')]);
      setLoans(l);
      setCargo(c);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  async function act(path, body, label) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await api(path, { method: 'POST', body });
      setMsg(label(res));
      await auth.refresh();
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!loans || !cargo) return <p className="muted">Opening the books…</p>;

  const perMinute = (loans.interestPerTickBps / 100).toFixed(2);
  // What the debt becomes in an hour if nothing is repaid. The compound
  // figure is the one that actually changes behaviour.
  const inAnHour =
    loans.debt > 0
      ? Math.round(
          loans.debt *
            Math.pow(1 + loans.interestPerTickBps / 10_000, 3_600 / loans.interestTickSeconds),
        )
      : 0;

  return (
    <>
      <div className="page-head">
        <div className="kicker">Credit &amp; capacity</div>
        <h2>The Counting House</h2>
        <p className="lede">
          Two ways to trade bigger than your cash allows: borrow against what you are worth, or make
          room for more cargo. Both cost something, and the first one keeps costing.
        </p>
      </div>

      {error && <Notice kind="err">{error}</Notice>}
      {msg && <Notice kind="ok">{msg}</Notice>}

      <div className="grid two">
        <div className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>Borrowing</h3>
            <span className="chip">
              {perMinute}% every {loans.interestTickSeconds}s
            </span>
          </div>

          <div className="grid three" style={{ marginBottom: 14 }}>
            <Figure
              label="Owed"
              value={<span className="num">{notes(loans.debt)}</span>}
              tone={loans.debt > 0 ? 'down' : ''}
            />
            <Figure
              label="Still available"
              value={<span className="num">{notes(loans.canBorrow)}</span>}
            />
            <Figure
              label="Next charge"
              value={<span className="num">{notes(loans.nextCharge)}</span>}
              tone={loans.nextCharge > 0 ? 'down' : ''}
            />
          </div>

          {loans.debt > 0 && (
            <Notice kind="err">
              Left alone, this becomes <span className="num">{notes(inAnHour)}</span> Notes within
              the hour. Interest compounds whether or not you are playing.
            </Notice>
          )}

          <Meter used={loans.debt} capacity={Math.max(loans.limit, 1)} />
          <p className="small faint" style={{ marginTop: 6 }}>
            Borrowing limit <span className="num">{notes(loans.limit)}</span> — twice what you are
            worth.
          </p>

          <label style={{ marginTop: 14 }}>Amount</label>
          <input
            type="number"
            min="1000"
            step="1000"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              disabled={busy || amount > loans.canBorrow || amount < 1_000}
              onClick={() =>
                act(
                  '/world/loans/borrow',
                  { amount },
                  (r) => `Borrowed ${notes(r.borrowed)} Notes.`,
                )
              }
            >
              Borrow
            </button>
            <button
              className="ghost"
              disabled={busy || loans.debt <= 0}
              onClick={() =>
                act('/world/loans/repay', { amount }, (r) => `Repaid ${notes(r.repaid)} Notes.`)
              }
            >
              Repay
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 style={{ margin: 0 }}>The hold</h3>
            <span className="chip">
              {Math.round((cargo.used / Math.max(cargo.capacity, 1)) * 100)}% full
            </span>
          </div>

          <Figure
            label="Carrying"
            value={
              <>
                <span className="num">{notes(cargo.used)}</span>
                <span className="faint num" style={{ fontSize: 18 }}>
                  {' '}
                  / {notes(cargo.capacity)}
                </span>
              </>
            }
            size="lg"
          />
          <Meter used={cargo.used} capacity={cargo.capacity} />

          <p className="muted" style={{ marginTop: 14 }}>
            You cannot carry everything, and that is the game. Cargo space is the scarce resource —
            every purchase is a bet about which good deserves the room.
          </p>

          {cargo.upgrade ? (
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                act(
                  '/world/cargo/upgrade',
                  {},
                  (r) => `Hold expanded to ${notes(r.capacity)} units.`,
                )
              }
            >
              Add {cargo.upgrade.step} units — {notes(cargo.upgrade.cost)} Notes
            </button>
          ) : (
            <p className="faint small">Your hold is as large as it gets.</p>
          )}
        </div>
      </div>
    </>
  );
}
