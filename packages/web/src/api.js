/**
 * Thin wrapper over fetch.
 *
 * Holds the JWT in localStorage. That is a deliberate simplification and
 * worth naming: a token in localStorage is readable by any script on the
 * page, so an XSS bug becomes an account takeover. The alternative -
 * an httpOnly cookie - needs CSRF protection and a session endpoint, and
 * v1 has no third-party scripts at all. Revisit if that changes.
 */
const TOKEN_KEY = 'tgc.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    // Surface the server's own message. The API returns a stable `error`
    // code plus a human message, and inventing a friendlier one here
    // would hide what actually happened.
    const err = new Error(data?.message || data?.error || `Request failed (${res.status})`);
    err.code = data?.error;
    err.details = data?.details;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const notes = (n) =>
  n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US');
