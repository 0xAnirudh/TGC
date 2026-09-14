import { useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';

/**
 * Who is logged in.
 *
 * Kept deliberately small: the token is the source of truth, and the
 * user object is just what /me last returned. On boot it verifies the
 * stored token by calling /me - a token can be expired or signed with a
 * rotated secret, and finding that out at boot beats discovering it on
 * the first trade.
 */
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const { user: me } = await api('/me');
      setUser(me);
      return me;
    } catch {
      clearToken();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (path, body) => {
    const res = await api(path, { method: 'POST', body });
    setToken(res.token);
    setUser(res.user);
    return res.user;
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return { user, loading, login, logout, refresh, setUser };
}
