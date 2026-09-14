/**
 * The trader.
 *
 * Drawn rather than imported, so it inherits currentColor and works at
 * every size the interface asks for - 22px beside a name in the HUD,
 * 34px walking the map. That constraint is what dictates the style:
 * bold silhouettes and almost no interior detail, because anything
 * finer turns to mud below about thirty pixels.
 *
 * `walking` swings the legs and the staff. It is driven by the travel
 * state rather than running always, so a stationary trader stands still
 * and motion means something.
 */
export function Trader({ size = 34, walking = false, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={`trader ${walking ? 'is-walking' : ''} ${className}`}
      aria-hidden="true"
    >
      {/* Pack, carried high on the shoulders. Drawn first so the cloak
          overlaps it and it reads as behind the figure. */}
      <g className="trader-pack">
        <rect x="22.5" y="12" width="9" height="11" rx="2" fill="currentColor" opacity="0.45" />
        <path d="M23 15.5h8.5" stroke="currentColor" strokeWidth="1.1" opacity="0.7" />
      </g>

      {/* Cloak. One shape - the whole silhouette of the figure. */}
      <path
        d="M20 9.5c4.2 0 6.6 3.1 7.2 7.4l1.5 10.6c.2 1.5-.8 2.3-2.1 2.3H13.4c-1.3 0-2.3-.8-2.1-2.3l1.5-10.6c.6-4.3 3-7.4 7.2-7.4Z"
        fill="currentColor"
      />

      {/* Hood and face. The face is a notch cut from the hood rather than
          features, which keeps it readable when it is 8px across. */}
      <path
        d="M20 4c3.1 0 5.4 2.4 5.4 5.6 0 2.6-1.4 4.2-2.6 4.9-.9.5-1.9.7-2.8.7s-1.9-.2-2.8-.7c-1.2-.7-2.6-2.3-2.6-4.9C14.6 6.4 16.9 4 20 4Z"
        fill="currentColor"
      />
      <ellipse cx="20" cy="10.6" rx="2.6" ry="3" fill="var(--surface)" opacity="0.92" />

      {/* Legs. Swung in opposite phase while walking. */}
      <g className="trader-legs" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <line className="leg-a" x1="17.5" y1="29.5" x2="17.5" y2="36" />
        <line className="leg-b" x1="22.5" y1="29.5" x2="22.5" y2="36" />
      </g>

      {/* Staff, planted a half-step ahead. */}
      <line
        className="trader-staff"
        x1="10.5"
        y1="13"
        x2="10.5"
        y2="37"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.75"
      />
    </svg>
  );
}

/**
 * The same figure with a handcart, used on the map while carrying.
 *
 * A loaded trader and an empty one should be distinguishable at a
 * glance, because the whole game is about what is in the hold.
 */
export function Caravan({ size = 40, walking = false, loaded = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 52 40"
      fill="none"
      className={`trader ${walking ? 'is-walking' : ''}`}
      aria-hidden="true"
    >
      {loaded && (
        <g className="cart">
          {/* Crates, stacked unevenly so the load looks packed by hand. */}
          <rect x="30" y="18" width="11" height="9" rx="1.5" fill="currentColor" opacity="0.55" />
          <rect x="33" y="12.5" width="8" height="6" rx="1.5" fill="currentColor" opacity="0.4" />
          <path d="M29 27h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle
            className="wheel"
            cx="33"
            cy="31.5"
            r="4"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <circle
            className="wheel"
            cx="41"
            cy="31.5"
            r="4"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          {/* The shaft, linking cart to trader. */}
          <path d="M29 25.5 24 22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}

      <g transform="translate(0,0)">
        <path
          d="M14 9.5c4.2 0 6.6 3.1 7.2 7.4l1.5 10.6c.2 1.5-.8 2.3-2.1 2.3H7.4c-1.3 0-2.3-.8-2.1-2.3l1.5-10.6C7.4 12.6 9.8 9.5 14 9.5Z"
          fill="currentColor"
        />
        <path
          d="M14 4c3.1 0 5.4 2.4 5.4 5.6 0 2.6-1.4 4.2-2.6 4.9-.9.5-1.9.7-2.8.7s-1.9-.2-2.8-.7c-1.2-.7-2.6-2.3-2.6-4.9C8.6 6.4 10.9 4 14 4Z"
          fill="currentColor"
        />
        <ellipse cx="14" cy="10.6" rx="2.6" ry="3" fill="var(--surface)" opacity="0.92" />
        <g className="trader-legs" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line className="leg-a" x1="11.5" y1="29.5" x2="11.5" y2="36" />
          <line className="leg-b" x1="16.5" y1="29.5" x2="16.5" y2="36" />
        </g>
      </g>
    </svg>
  );
}
