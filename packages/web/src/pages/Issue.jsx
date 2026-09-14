import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, notes } from '../api.js';

export default function Issue({ auth }) {
  const [req, setReq] = useState(null);
  const [form, setForm] = useState({
    name: '',
    colorToken: 'violet',
    k: 10000,
    n: 2,
    basePrice: 100,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api('/issue/requirements')
      .then(setReq)
      .catch((e) => setError(e.message));
  }, []);

  if (error && !req) return <p className="err">{error}</p>;
  if (!req) return <p className="muted">Loading…</p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/issue', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          colorToken: form.colorToken,
          k: Number(form.k),
          n: Number(form.n),
          basePrice: Number(form.basePrice),
        },
      });
      await auth.refresh();
      navigate(`/goods/${res.good.id}`);
    } catch (err) {
      setError(err.details?.map?.((d) => d.message).join(' ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Issue a good</h2>
      <p className="muted">
        Costs <span className="num">{notes(req.fee)}</span> Notes, which are burned. You get no free
        allocation — the good starts at zero supply and you buy on the same curve as everyone else.
      </p>

      {!req.eligible && (
        <div className="panel">
          <strong>Not yet eligible.</strong>
          <ul>
            {req.failures.map((f) => (
              <li key={f.requirement} className="muted">
                {f.requirement}: need <span className="num">{notes(f.need)}</span>, have{' '}
                <span className="num">{notes(f.have)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={submit}>
        <div className="row">
          <div className="col">
            <label>Name</label>
            <input value={form.name} onChange={set('name')} placeholder="Quartz" />
          </div>
          <div className="col">
            <label>Colour</label>
            <select value={form.colorToken} onChange={set('colorToken')}>
              {req.colors.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <div className="col">
            <label>Starting price (Notes per unit at zero supply)</label>
            <input
              type="number"
              min="5"
              max="5000"
              value={form.basePrice}
              onChange={set('basePrice')}
            />
          </div>
          <div className="col">
            <label>
              Depth — k (bigger is slower to move, {notes(req.curve.k.min)}–{notes(req.curve.k.max)}
              )
            </label>
            <input
              type="number"
              min={req.curve.k.min}
              max={req.curve.k.max}
              value={form.k}
              onChange={set('k')}
            />
          </div>
          <div className="col">
            <label>
              Steepness — n ({req.curve.n.min}–{req.curve.n.max})
            </label>
            <input
              type="number"
              min={req.curve.n.min}
              max={req.curve.n.max}
              value={form.n}
              onChange={set('n')}
            />
          </div>
        </div>

        <p className="muted" style={{ marginTop: 10 }}>
          price = {form.basePrice || 0} × (1 + supply / {form.k || 1})<sup>{form.n || 1}</sup>. At a
          supply of {notes(Number(form.k) || 0)} the price is{' '}
          <span className="num">
            {notes((Number(form.basePrice) || 0) * Math.pow(2, Number(form.n) || 1))}
          </span>
          .
        </p>

        {error && <p className="err">{error}</p>}

        <p style={{ marginTop: 12 }}>
          <button disabled={busy || !req.eligible || !form.name.trim()}>
            {busy ? 'Issuing…' : `Issue for ${notes(req.fee)} Notes`}
          </button>
        </p>
      </form>
    </>
  );
}
