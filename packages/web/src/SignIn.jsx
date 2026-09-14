import { useState } from 'react';
import { Notice } from './ui/index.jsx';

export function SignIn({ auth, theme, onToggleTheme }) {
  const [mode, setMode] = useState('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const registering = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.login(registering ? '/auth/register' : '/auth/login', { username, password });
    } catch (err) {
      setError(err.details?.map?.((d) => d.message).join(' ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <button className="theme-toggle corner" onClick={onToggleTheme} aria-label="Toggle theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      <div className="signin-card">
        <h1>The Haul</h1>
        <p className="lede">
          Thirty days, six towns, and a debt that grows while you sleep. Buy low somewhere, sell
          high somewhere else, and hope the road is kind.
        </p>

        <form onSubmit={submit}>
          <label>Trader name</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />

          <label style={{ marginTop: 12 }}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? 'new-password' : 'current-password'}
          />

          {error && <Notice kind="err">{error}</Notice>}

          <button
            style={{ width: '100%', marginTop: 16 }}
            disabled={busy || !username || !password}
          >
            {busy ? 'A moment…' : registering ? 'Start trading' : 'Sign in'}
          </button>
        </form>

        <p className="small faint" style={{ textAlign: 'center', marginTop: 14 }}>
          {registering ? 'Already have a name? ' : 'New here? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMode(registering ? 'login' : 'register');
              setError(null);
            }}
          >
            {registering ? 'Sign in' : 'Make one'}
          </a>
        </p>
      </div>
    </div>
  );
}
