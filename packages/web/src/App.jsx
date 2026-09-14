import { Routes, Route, Link, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './useAuth.js';
import { useTheme } from './useTheme.js';
import { notes } from './ui/index.jsx';

import Market from './pages/Market.jsx';
import GoodDetail from './pages/GoodDetail.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Newspaper from './pages/Newspaper.jsx';
import Profile from './pages/Profile.jsx';
import Issue from './pages/Issue.jsx';
import Login from './pages/Login.jsx';
import Travel from './pages/Travel.jsx';
import Bank from './pages/Bank.jsx';

export default function App() {
  const auth = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  if (auth.loading) {
    return (
      <main>
        <p className="muted">Opening the ledger…</p>
      </main>
    );
  }

  const user = auth.user;

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <Link to="/" className="wordmark">
            General&nbsp;Company
          </Link>

          <nav className="primary">
            <NavLink to="/" end>
              Market
            </NavLink>
            {user && <NavLink to="/travel">Travel</NavLink>}
            {user && <NavLink to="/portfolio">Portfolio</NavLink>}
            {user && <NavLink to="/bank">Counting House</NavLink>}
            <NavLink to="/leaderboard">Standings</NavLink>
            <NavLink to="/newspaper">Ledger</NavLink>
            {user && <NavLink to="/issue">Issue</NavLink>}
          </nav>

          {user ? (
            <div className="purse">
              {/* Cash and debt sit in the masthead because every screen
                  is a decision about one or both of them. */}
              <div className="purse-item">
                <span className="label">Notes</span>
                <span className="v num">{notes(user.cash)}</span>
              </div>
              {user.debt > 0 && (
                <div className="purse-item">
                  <span className="label">Owed</span>
                  <span className="v num down">{notes(user.debt)}</span>
                </div>
              )}
              <div className="purse-item">
                <span className="label">{user.username}</span>
                <span className="v muted">{user.rank ? `rank ${user.rank}` : '—'}</span>
              </div>
              <button
                className="theme-toggle"
                onClick={toggle}
                title={theme === 'dark' ? 'Light' : 'Dark'}
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? '☀' : '☾'}
              </button>
              <button
                className="ghost tiny"
                onClick={() => {
                  auth.logout();
                  navigate('/');
                }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="purse">
              <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme">
                {theme === 'dark' ? '☀' : '☾'}
              </button>
              <Link to="/login">
                <button>Sign in</button>
              </Link>
            </div>
          )}
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Market auth={auth} />} />
          <Route path="/goods/:id" element={<GoodDetail auth={auth} />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/newspaper" element={<Newspaper />} />
          <Route path="/players/:username" element={<Profile />} />
          <Route path="/login" element={<Login auth={auth} />} />
          <Route
            path="/portfolio"
            element={user ? <Portfolio auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/issue"
            element={user ? <Issue auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/travel"
            element={user ? <Travel auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/bank"
            element={user ? <Bank auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route path="*" element={<p className="muted">Nothing at that address.</p>} />
        </Routes>
      </main>
    </>
  );
}
