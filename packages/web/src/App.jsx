import { Routes, Route } from 'react-router-dom';
import { useAuth } from './useAuth.js';
import { useTheme } from './useTheme.js';
import { Shell } from './game/Shell.jsx';
import Login from './pages/Login.jsx';

export default function App() {
  const auth = useAuth();
  const { theme, toggle } = useTheme();

  if (auth.loading) {
    return (
      <main>
        <p className="muted">Opening the ledger…</p>
      </main>
    );
  }

  return (
    <Routes>
      {/* Sign-in is the only screen outside the board. The board is the
          game; a login form does not belong inside it. */}
      <Route path="/login" element={<Login auth={auth} />} />
      <Route path="*" element={<Shell auth={auth} theme={theme} onToggleTheme={toggle} />} />
    </Routes>
  );
}
