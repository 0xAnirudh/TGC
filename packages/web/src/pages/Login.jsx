import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Notice } from '../ui/index.jsx';

export default function Login({ auth }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.login(mode === 'login' ? '/auth/login' : '/auth/register', { username, password });
      navigate('/');
    } catch (err) {
      // Field-level messages when validation failed, so a rejected
      // password says why rather than just "invalid".
      setError(err.details?.map?.((d) => d.message).join(' ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === 'register';

  return (
    <div style={{ maxWidth: 380, margin: '40px auto' }}>
      <div className="page-head" style={{ textAlign: 'center' }}>
        <div className="kicker">General Company</div>
        <h2>{registering ? 'Open an account' : 'Sign in'}</h2>
        <p className="lede" style={{ margin: '0 auto' }}>
          {registering
            ? 'New traders are staked 100,000 Notes and begin at Saltmarket Harbour.'
            : 'Back to the ledger.'}
        </p>
      </div>

      <div className="card">
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
            {busy ? 'Just a moment…' : registering ? 'Open the account' : 'Sign in'}
          </button>
        </form>
      </div>

      <p className="muted small" style={{ textAlign: 'center', marginTop: 14 }}>
        {registering ? 'Already trading? ' : 'No account yet? '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setMode(registering ? 'login' : 'register');
            setError(null);
          }}
        >
          {registering ? 'Sign in' : 'Open one'}
        </a>
      </p>
    </div>
  );
}
