import { useEffect, useRef, useState } from 'react';

/** Goods carry a palette name, not a colour, so the UI owns the palette. */
const PALETTE = {
  slate: '#64748b',
  amber: '#c2851b',
  orange: '#c2601b',
  violet: '#6d4aa8',
  yellow: '#a8871b',
  blue: '#2c4a6e',
  indigo: '#45408f',
  rose: '#a8324a',
  green: '#2f6b44',
};
export const colorFor = (token) => PALETTE[token] ?? PALETTE.slate;

export const notes = (n) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US');

export const money = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A price that lights up briefly when it changes.
 *
 * Prices move every few seconds from drift, bots and events, and without
 * this the page is silently different every time you look back at it.
 * The flash is short - long enough to catch mid-scan, not long enough to
 * become decoration - and it is suppressed under prefers-reduced-motion
 * by the stylesheet.
 */
export function Price({ value, decimals = 2, className = '' }) {
  const previous = useRef(value);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (previous.current !== value && previous.current !== undefined) {
      setFlash(value > previous.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setFlash(''), 1_200);
      previous.current = value;
      return () => clearTimeout(t);
    }
    previous.current = value;
  }, [value]);

  if (value === null || value === undefined) return <span className="num faint">—</span>;

  return (
    <span className={`num ${flash} ${className}`}>
      {decimals === 0 ? notes(value) : money(value)}
    </span>
  );
}

/**
 * A price history in about forty pixels.
 *
 * Enough to answer "which way has this been going" without leaving the
 * table. Deliberately axis-less and label-less: it is a shape, and the
 * exact numbers are one click away on the good's own page.
 */
export function Sparkline({ points, color = 'currentColor', width = 72, height = 22 }) {
  if (!points || points.length < 2) {
    return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);

  // 1.5px of padding top and bottom so the extremes are not clipped by
  // the stroke width.
  const y = (v) => height - 1.5 - ((v - min) / span) * (height - 3);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${y(p).toFixed(1)}`)
    .join(' ');

  const rising = points[points.length - 1] >= points[0];

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={d}
        stroke={color === 'auto' ? (rising ? 'var(--up)' : 'var(--down)') : color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

/**
 * The arbitrage gap, drawn as well as stated.
 *
 * A column of percentages all reads the same at a glance; a column of
 * bars sorts itself. Scaled against a 100% gap, which is about the widest
 * the regional bias produces on a fresh market.
 */
export function GapBar({ pct, max = 100 }) {
  if (pct === null || pct === undefined) return <span className="num faint">—</span>;

  // Scaled against the widest gap currently on screen rather than a
  // fixed ceiling. With a fixed 100% scale every good above parity drew
  // a full bar, so the rows that were genuinely worth carrying looked
  // identical to the ones that were merely positive.
  const width = Math.max(3, Math.min(100, (pct / Math.max(max, 1)) * 100));

  return (
    <span className="gap-cell">
      <span className="gap-bar">
        <span style={{ width: `${width}%` }} />
      </span>
      <span className={`num ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'faint'}`}>
        {pct > 0 ? '+' : ''}
        {pct.toFixed(1)}%
      </span>
    </span>
  );
}

/** A labelled figure. The unit of every summary panel in the app. */
export function Figure({ label, value, sub, tone = '', size = '' }) {
  return (
    <div className="figure">
      <span className="label">{label}</span>
      <span className={`v ${size} ${tone}`}>{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** A capacity bar: the hold, the borrowing limit. */
export function Meter({ used, capacity }) {
  const pct = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  const tone = pct >= 99 ? 'full' : pct >= 80 ? 'warn' : '';
  return (
    <div className={`meter ${tone}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return <p className={`notice ${kind}`}>{children}</p>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** A short label for a region, for use inside a dense table cell. */
export const shortRegion = (name = '') => name.replace(/^The /, '').split(' ').pop();
