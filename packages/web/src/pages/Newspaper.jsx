import { useEffect, useState } from 'react';
import { api, notes } from '../api.js';

export default function Newspaper() {
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/newspaper')
      .then((d) => setPaper(d.newspaper))
      .catch((e) => setError(e.code === 'no_newspaper' ? null : e.message));
  }, []);

  if (error) return <p className="err">{error}</p>;

  if (!paper) {
    return (
      <>
        <h2>The Daily Ledger</h2>
        <p className="muted">
          No edition yet. The paper is written once an hour by the job runner — start it with
          <code> npm run dev --workspace=@tgc/jobs</code>.
        </p>
      </>
    );
  }

  return (
    <>
      <h2>The Daily Ledger</h2>
      <p className="muted">
        {paper.date} · {notes(paper.tradeCount)} trades · {notes(paper.volume)} Notes traded
      </p>

      <div className="panel">
        {paper.headlines.map((h, i) => (
          <p key={i} style={{ margin: '8px 0' }}>
            {h.text}
          </p>
        ))}
      </div>

      <p className="muted">
        Written from templates, not generated. Each headline stores the facts it was built from, so
        it stays a record rather than prose.
      </p>
    </>
  );
}
