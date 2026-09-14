import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, Link, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { notes, Notice } from '../ui/index.jsx';
import { Trader } from './Character.jsx';
import { GameMap } from './Map.jsx';
import { Ledger } from './Ledger.jsx';

import Market from '../pages/Market.jsx';
import GoodDetail from '../pages/GoodDetail.jsx';
import Portfolio from '../pages/Portfolio.jsx';
import Leaderboard from '../pages/Leaderboard.jsx';
import Profile from '../pages/Profile.jsx';
import Issue from '../pages/Issue.jsx';
import Bank from '../pages/Bank.jsx';

/**
 * The board.
 *
 * Three panes that stay put: the numbers on the left, the map top right,
 * the ledger beneath it. Only the left pane routes.
 *
 * That split is the whole design. In a page-per-screen layout, deciding
 * whether to carry Silk to the frontier meant holding a price in your
 * head while you navigated to the map and then to the news. Here the
 * price, the road and the reason the price moved are all on screen at
 * once, which is the difference between a form and a game.
 */
export function Shell({ auth, theme, onToggleTheme }) {
  const [regions, setRegions] = useState([]);
  const [cargo, setCargo] = useState(null);
  const [travel, setTravel] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const user = auth.user;

  const loadWorld = useCallback(async () => {
    if (!user) return;
    try {
      const [r, c] = await Promise.all([api('/world/regions'), api('/world/cargo')]);
      setRegions(r.regions);
      setCargo(c);
    } catch (e) {
      setError(e.message);
    }
  }, [user]);

  useEffect(() => {
    loadWorld();
  }, [loadWorld]);

  // Pick the arrival up when it happens, so the map, the prices and the
  // hold all agree without the player refreshing anything.
  useEffect(() => {
    if (!travel) return;
    const remaining = travel.startedAt + travel.seconds * 1000 - Date.now();
    const id = setTimeout(
      () => {
        setTravel(null);
        loadWorld();
        auth.refresh();
        // The left pane is showing prices for where you were.
        navigate('/', { replace: true });
      },
      Math.max(0, remaining + 400),
    );
    return () => clearTimeout(id);
  }, [travel, loadWorld, auth, navigate]);

  async function go(to) {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/world/travel', { method: 'POST', body: { to } });
      setTravel({ from: res.from, to: res.to, seconds: res.seconds, startedAt: Date.now() });
      setSelected(null);
      await auth.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const here = regions.find((r) => r.here);
  const target = regions.find((r) => r.id === selected);
  const carrying = (cargo?.used ?? 0) > 0;

  return (
    <div className="board">
      <header className="hud">
        <Link to="/" className="wordmark">
          General&nbsp;Company
        </Link>

        <nav className="primary">
          <NavLink to="/" end>
            Market
          </NavLink>
          {user && <NavLink to="/portfolio">Hold</NavLink>}
          {user && <NavLink to="/bank">Counting House</NavLink>}
          <NavLink to="/leaderboard">Standings</NavLink>
          {user && <NavLink to="/issue">Issue</NavLink>}
        </nav>

        {user ? (
          <div className="purse">
            <div className="avatar">
              <Trader size={26} />
            </div>
            <div className="purse-item">
              <span className="label">{user.username}</span>
              <span className="v muted">{user.rank ? `rank ${user.rank}` : '—'}</span>
            </div>
            <div className="purse-item">
              <span className="label">Notes</span>
              <span className="v num">{notes(user.cash)}</span>
            </div>
            {cargo && (
              <div className="purse-item">
                <span className="label">Hold</span>
                <span className="v num">
                  {notes(cargo.used)}
                  <span className="faint">/{notes(cargo.capacity)}</span>
                </span>
              </div>
            )}
            {user.debt > 0 && (
              <div className="purse-item">
                <span className="label">Owed</span>
                <span className="v num down">{notes(user.debt)}</span>
              </div>
            )}
            <button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <button
              className="ghost tiny"
              onClick={() => {
                auth.logout();
                navigate('/');
              }}
            >
              Leave
            </button>
          </div>
        ) : (
          <div className="purse">
            <button className="theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <Link to="/login">
              <button>Sign in</button>
            </Link>
          </div>
        )}
      </header>

      <div className="panes">
        <section className="pane-left">
          <Routes>
            <Route path="/" element={<Market auth={auth} travelling={!!travel} />} />
            <Route path="/goods/:id" element={<GoodDetail auth={auth} onTraded={loadWorld} />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/players/:username" element={<Profile />} />
            <Route
              path="/portfolio"
              element={user ? <Portfolio auth={auth} /> : <Navigate to="/login" replace />}
            />
            <Route
              path="/bank"
              element={
                user ? <Bank auth={auth} onChanged={loadWorld} /> : <Navigate to="/login" replace />
              }
            />
            <Route
              path="/issue"
              element={user ? <Issue auth={auth} /> : <Navigate to="/login" replace />}
            />
            <Route path="*" element={<p className="muted">Nothing at that address.</p>} />
          </Routes>
        </section>

        <aside className="pane-right">
          <section className="map-panel">
            <header className="map-head">
              <div>
                <div className="label">{travel ? 'On the road' : 'Standing at'}</div>
                <div className="map-where">
                  {travel
                    ? `${regions.find((r) => r.id === travel.from)?.name} → ${regions.find((r) => r.id === travel.to)?.name}`
                    : (here?.name ?? '—')}
                </div>
              </div>
              {carrying && <span className="chip">carrying {notes(cargo.used)}</span>}
            </header>

            <GameMap
              regions={regions}
              location={here?.id ?? travel?.from ?? 'harbour'}
              travel={travel}
              selected={selected}
              onSelect={(id) => !travel && setSelected(id === selected ? null : id)}
              loaded={carrying}
            />

            {error && <Notice kind="err">{error}</Notice>}

            {target && !travel && (
              <div className="depart">
                <div>
                  <div className="depart-name">{target.name}</div>
                  <div className="faint small">{target.blurb}</div>
                </div>
                <div className="depart-facts">
                  <span className="num">{notes(target.travelCost)}</span>
                  <span className="faint small">fare · {target.travelSeconds}s</span>
                </div>
                <button
                  disabled={busy || (user?.cash ?? 0) < target.travelCost}
                  onClick={() => go(target.id)}
                >
                  {busy ? 'Setting off…' : 'Set off'}
                </button>
              </div>
            )}
          </section>

          <Ledger />
        </aside>
      </div>
    </div>
  );
}
