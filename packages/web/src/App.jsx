import { useAuth } from './useAuth.js';
import { useTheme } from './useTheme.js';
import { Game } from './haul/Game.jsx';
import { SignIn } from './SignIn.jsx';

export default function App() {
  const auth = useAuth();
  const { theme, toggle } = useTheme();

  if (auth.loading)
    return (
      <p className="muted" style={{ padding: 40 }}>
        Opening the ledger…
      </p>
    );
  if (!auth.user) return <SignIn auth={auth} theme={theme} onToggleTheme={toggle} />;

  return <Game auth={auth} theme={theme} onToggleTheme={toggle} />;
}
