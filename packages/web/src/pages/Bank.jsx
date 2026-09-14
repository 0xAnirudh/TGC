import { useEffect, useState } from 'react';
import { api, notes } from '../api.js';

/**
 * Loans and cargo.
 *
 * Both are ways of spending now to trade bigger later, which is why they
 * share a screen. The debt clock is shown rather than hidden - a cost
 * that accrues invisibly is a trap, not a decision.
 */
export default function Bank({ auth }) {
  const [loans, setLoans] = useState(null);
  const [cargo, setCargo] = useState(null);
  const [amount, setAmount] = useState(20000);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

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
    setError(null);
    setMsg(null);
    try {
      const res = await api(path, { method: 'POST', body });
      setMsg(label(res));
      await auth.refresh();
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!loans || !cargo) return <p className="muted">Loading…</p>;

  return (
    <>
      <h2>The Counting House</h2>
      {error && <p className="err">{error}</p>}
      {msg && <p className="ok">{msg}</p>}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Borrowing</h3>
        <span className="stat">
          <span className="label">Owed</span>
          <span className={`value num ${loans.debt > 0 ? 'down' : ''}`}>{notes(loans.debt)}</span>
        </span>
        <span className="stat">
          <span className="label">Can still borrow</span>
          <span className="value num">{notes(loans.canBorrow)}</span>
        </span>
        <span className="stat">
          <span className="label">Next interest charge</span>
          <span className="value num">{notes(loans.nextCharge)}</span>
        </span>

        <p className="muted">
          Interest is {(loans.interestPerTickBps / 100).toFixed(2)}% every{' '}
          {loans.interestTickSeconds}s, and it compounds whether or not you are playing. A loan is a
          bet that you can earn faster than it grows.
        </p>

        <label>Amount</label>
        <input
          type="number"
          min="1000"
          step="1000"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          style={{ maxWidth: 200 }}
        />
        <p style={{ marginTop: 10 }}>
          <button
            onClick={() =>
              act('/world/loans/borrow', { amount }, (r) => `Borrowed ${notes(r.borrowed)}.`)
            }
            disabled={amount > loans.canBorrow}
          >
            Borrow
          </button>{' '}
          <button
            className="plain"
            onClick={() =>
              act('/world/loans/repay', { amount }, (r) => `Repaid ${notes(r.repaid)}.`)
            }
            disabled={loans.debt <= 0}
          >
            Repay
          </button>
        </p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>The hold</h3>
        <span className="stat">
          <span className="label">Carrying</span>
          <span className="value num">
            {notes(cargo.used)} / {notes(cargo.capacity)}
          </span>
        </span>
        <span className="stat">
          <span className="label">Free</span>
          <span className="value num">{notes(cargo.free)}</span>
        </span>

        <p className="muted">
          You cannot carry everything, which is the whole game — every purchase is a bet about which
          good deserves the room.
        </p>

        {cargo.upgrade ? (
          <button
            className="plain"
            onClick={() =>
              act('/world/cargo/upgrade', {}, (r) => `Hold expanded to ${notes(r.capacity)}.`)
            }
          >
            Add {cargo.upgrade.step} units for {notes(cargo.upgrade.cost)} Notes
          </button>
        ) : (
          <p className="muted">Your hold is as large as it gets.</p>
        )}
      </div>
    </>
  );
}
