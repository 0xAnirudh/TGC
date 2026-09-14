import { useEffect, useState } from 'react';

const KEY = 'tgc.theme';

/**
 * Light and dark, remembered.
 *
 * Defaults to the system preference rather than forcing a choice, and
 * only stores a value once the reader has actually picked one - so
 * someone who never touches the toggle keeps following their system when
 * it changes.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      // Private browsing, or storage disabled. The system preference is
      // a perfectly good answer.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Nothing to do; the choice still applies for this session.
    }
  };

  return { theme, toggle };
}
