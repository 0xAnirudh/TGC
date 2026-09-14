import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './useAuth.js';
import { notes } from './api.js';
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
  const navigate = useNavigate();

  if (auth.loading) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <header>
        <h1>General Company</h1>
        <nav>
          <Link to="/">Market</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/newspaper">Newspaper</Link>
          {auth.user && <Link to="/travel">Travel</Link>}
          {auth.user && <Link to="/portfolio">Portfolio</Link>}
          {auth.user && <Link to="/bank">Bank</Link>}
          {auth.user && <Link to="/issue">Issue</Link>}
        </nav>
        <span className="spacer" />
        {auth.user ? (
          <>
            <span className="muted">
              {auth.user.username} · <span className="num">{notes(auth.user.cash)}</span> Notes
              {auth.user.debt > 0 && (
                <>
                  {' · '}
                  <span className="down num">owes {notes(auth.user.debt)}</span>
                </>
              )}
              {auth.user.rank ? ` · rank ${auth.user.rank}` : ''}
            </span>
            <button
              className="plain"
              onClick={() => {
                auth.logout();
                navigate('/');
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Market />} />
          <Route path="/goods/:id" element={<GoodDetail auth={auth} />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/newspaper" element={<Newspaper />} />
          <Route path="/players/:username" element={<Profile />} />
          <Route path="/login" element={<Login auth={auth} />} />
          <Route
            path="/portfolio"
            element={auth.user ? <Portfolio auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/issue"
            element={auth.user ? <Issue auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/travel"
            element={auth.user ? <Travel auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/bank"
            element={auth.user ? <Bank auth={auth} /> : <Navigate to="/login" replace />}
          />
          <Route path="*" element={<p>Nothing here.</p>} />
        </Routes>
      </main>
    </>
  );
}
