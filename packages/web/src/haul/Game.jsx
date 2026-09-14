import { useEffect, useState, useCallback } from 'react';
import * as haul from './api.js';
import { notes, Notice } from '../ui/index.jsx';
import { RunScreen } from './Run.jsx';

/**
 * The game.
 *
 * Four states and no routing between them: no run, a run, the result of
 * a run, and the board. A run is three minutes, so anything that makes
 * starting the next one slower than one click is friction in the wrong
 * place.
 */
export function Game({ auth, theme, onToggleTheme }) {
  const [run, setRun] = useState(null);
  const [result, setResult] = useState(null);
  const [rules, setRules] = useState(null);
  const [board, setBoard] = useState([]);
  const [best, setBest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refreshBoard = useCallback(() => {
    haul
      .board()
      .then((d) => setBoard(d.entries))
      .catch(() => {});
    haul
      .history()
      .then((d) =>
        setBest(
          d.runs
            .filter((r) => r.status === 'finished')
            .reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null),
        ),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([haul.rules(), haul.current()])
      .then(([r, c]) => {
        setRules(r);
        setRun(c.run);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    refreshBoard();
  }, [refreshBoard]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const res = await haul.start();
      setResult(null);
      setRun(res.run);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function finished(res) {
    setRun(null);
    setResult(res);
    refreshBoard();
  }

  if (loading) return <p className="muted">Harnessing the cart…</p>;

  return (
    <div className="game">
      <header className="game-bar">
        <span className="wordmark">The Haul</span>
        <span className="flex" />
        {auth.user && <span className="small faint">{auth.user.username}</span>}
        <button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="ghost tiny" onClick={auth.logout}>
          Leave
        </button>
      </header>

      {error && <Notice kind="err">{error}</Notice>}

      {run ? (
        <RunScreen run={run} setRun={setRun} onFinished={finished} />
      ) : result ? (
        <Result result={result} onAgain={begin} busy={busy} board={board} />
      ) : (
        <Start rules={rules} onBegin={begin} busy={busy} board={board} best={best} />
      )}
    </div>
  );
}

function Start({ rules, onBegin, busy, board, best }) {
  return (
    <div className="start">
      <div className="start-pitch">
        <h1>Thirty days to make your name.</h1>
        <p className="lede">
          You owe <span className="num">{notes(rules?.openingDebt)}</span> Notes and hold{' '}
          <span className="num">{notes(rules?.openingCash)}</span>. The debt grows{' '}
          <span className="num">{rules?.debtRatePct}%</span> a day whether you move or not.
        </p>
        <p className="lede">
          Six towns. Every price changes every day, and you only see the prices where you are
          standing. Travelling costs a day. The cart holds{' '}
          <span className="num">{notes(rules?.openingCapacity)}</span>.
        </p>
        <p className="lede">
          On the last day the cart is sold, the debt is settled, and whatever is left is your score.
        </p>

        <button className="big" onClick={onBegin} disabled={busy}>
          {busy ? 'Loading the cart…' : 'Set out'}
        </button>

        {best && (
          <p className="small faint">
            Your best haul: <span className="num">{notes(best.score)}</span>
          </p>
        )}
      </div>

      <BoardList board={board} />
    </div>
  );
}

function Result({ result, onAgain, busy, board }) {
  const ruined = result.ruined;
  return (
    <div className="start">
      <div className="start-pitch">
        <div className="kicker">{result.abandoned ? 'Abandoned' : `Day ${result.days}`}</div>
        <h1 className={ruined ? 'down' : ''}>{ruined ? 'Ruined.' : 'Settled up.'}</h1>

        <table className="ledger settle">
          <tbody>
            {result.liquidated.map((l) => (
              <tr key={l.good}>
                <td>
                  Sold {notes(l.qty)} {l.good}
                </td>
                <td className="r num up">+{notes(l.proceeds)}</td>
              </tr>
            ))}
            <tr>
              <td>Notes in hand</td>
              <td className="r num">{notes(result.cashAfter)}</td>
            </tr>
            <tr>
              <td>Owed</td>
              <td className="r num down">−{notes(result.debt)}</td>
            </tr>
            <tr className="total">
              <td>Score</td>
              <td className="r num">{notes(result.score)}</td>
            </tr>
          </tbody>
        </table>

        {ruined && (
          <p className="small down">
            The creditor took everything. A haul is only worth what is left after the debt.
          </p>
        )}

        <button className="big" onClick={onAgain} disabled={busy}>
          {busy ? 'Harnessing…' : 'Again'}
        </button>
      </div>

      <BoardList board={board} />
    </div>
  );
}

function BoardList({ board }) {
  return (
    <aside className="board-panel">
      <h3>Best hauls</h3>
      {board.length === 0 ? (
        <p className="small faint">Nobody has finished a haul yet.</p>
      ) : (
        <table className="ledger">
          <tbody>
            {board.map((e) => (
              <tr key={e.username}>
                <td className="r num faint" style={{ width: 34 }}>
                  {e.rank}
                </td>
                <td>{e.username}</td>
                <td className="r num">{notes(e.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small faint" style={{ marginTop: 10 }}>
        One entry per trader — their best run.
      </p>
    </aside>
  );
}
