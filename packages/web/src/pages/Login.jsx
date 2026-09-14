import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
      // Show the field-level messages when validation failed, so a
      // rejected password says why rather than just "invalid".
      setError(err.details?.map?.((d) => d.message).join(' ') || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 340 }}>
      <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>

      <form onSubmit={submit}>
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />

        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />

        {error && <p className="err">{error}</p>}

        <p style={{ marginTop: 14 }}>
          <button disabled={busy || !username || !password}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </p>
      </form>

      <p className="muted">
        {mode === 'login' ? 'No account yet? ' : 'Already registered? '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Create one' : 'Sign in'}
        </a>
        {mode === 'register' && ' — new accounts start with 100,000 Notes.'}
      </p>
    </div>
  );
}
