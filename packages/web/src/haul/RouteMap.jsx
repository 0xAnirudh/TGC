import { useEffect, useRef, useState } from 'react';

/**
 * The map.
 *
 * Six towns with roads between them. Only the towns you can reach today
 * are live - travel is one leg a day, so the map is a menu of exactly
 * what this turn can do, and greying out the rest makes that obvious
 * without a word of explanation.
 */
export function RouteMap({ run, onTravel, busy, moving }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);

  const here = run.towns.find((t) => t.id === run.town);

  // The trader sits on the current town. Converted from the drawing's
  // coordinates to real pixels, because the SVG letterboxes and a
  // percentage would put the figure beside the town rather than on it.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !here) return;
    const rect = box.getBoundingClientRect();
    const scale = Math.min(rect.width / 360, rect.height / 440);
    const offX = (rect.width - 360 * scale) / 2;
    const offY = (rect.height - 440 * scale) / 2;
    setPos({ x: offX + here.x * scale, y: offY + here.y * scale });
  }, [here, run.town]);

  const roads = [
    ['saltmarket', 'blackreach'],
    ['saltmarket', 'thornwyck'],
    ['blackreach', 'ashford'],
    ['blackreach', 'thornwyck'],
    ['ashford', 'terraces'],
    ['ashford', 'thornwyck'],
    ['ashford', 'coldwater'],
    ['terraces', 'coldwater'],
  ];
  const at = (id) => run.towns.find((t) => t.id === id);

  return (
    <div className="routemap" ref={boxRef}>
      <svg viewBox="0 0 360 440" className="routemap-svg">
        <rect width="360" height="440" fill="var(--map-land)" />
        <path d="M0 440 L0 300 C 50 340 70 392 92 440 Z" fill="var(--map-sea)" opacity="0.55" />

        {roads.map(([a, b]) => {
          const p = at(a);
          const q = at(b);
          if (!p || !q) return null;
          const live = run.town === a || run.town === b;
          return (
            <line
              key={`${a}-${b}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              stroke={live ? 'var(--accent)' : 'var(--map-road)'}
              strokeWidth={live ? 2.2 : 1.3}
              strokeDasharray="4 6"
              opacity={live ? 0.9 : 0.35}
            />
          );
        })}

        {run.towns.map((t) => {
          const isHere = t.id === run.town;
          const reachable = run.roads.includes(t.id);
          return (
            <g
              key={t.id}
              className={`town ${isHere ? 'is-here' : ''} ${reachable ? 'is-open' : 'is-shut'}`}
              transform={`translate(${t.x} ${t.y})`}
              onClick={() => reachable && !busy && onTravel(t.id)}
              style={{ cursor: reachable && !busy ? 'pointer' : 'default' }}
            >
              <circle r="16" fill="transparent" />
              <circle r="6.5" className="town-dot" />
              <text className="town-label" y={-13} textAnchor="middle">
                {t.name}
              </text>
              {reachable && (
                <text className="town-go" y={20} textAnchor="middle">
                  1 day
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {pos && (
        <div className={`cart ${moving ? 'is-moving' : ''}`} style={{ left: pos.x, top: pos.y }}>
          <svg width="30" height="30" viewBox="0 0 40 40" aria-hidden="true">
            <path
              d="M20 9.5c4.2 0 6.6 3.1 7.2 7.4l1.5 10.6c.2 1.5-.8 2.3-2.1 2.3H13.4c-1.3 0-2.3-.8-2.1-2.3l1.5-10.6c.6-4.3 3-7.4 7.2-7.4Z"
              fill="currentColor"
            />
            <path
              d="M20 4c3.1 0 5.4 2.4 5.4 5.6 0 2.6-1.4 4.2-2.6 4.9-.9.5-1.9.7-2.8.7s-1.9-.2-2.8-.7c-1.2-.7-2.6-2.3-2.6-4.9C14.6 6.4 16.9 4 20 4Z"
              fill="currentColor"
            />
            <ellipse cx="20" cy="10.6" rx="2.4" ry="2.8" fill="var(--surface)" opacity="0.9" />
          </svg>
        </div>
      )}
    </div>
  );
}
