import { useEffect, useRef, useState } from 'react';
import { Caravan } from './Character.jsx';

/**
 * The map.
 *
 * Drawn as a place rather than a list, because the four markets have
 * geography and the fares only make sense against it: the harbour is on
 * the coast where everything lands, and the frontier is the long haul
 * inland. A row of dots on a line says none of that.
 *
 * Positions are in a 0-360 x 0-500 space and hand-placed. They are not
 * derived from anything in the data - the road order is the only thing
 * that matters mechanically, and the rest is drawing.
 */
const PLACES = {
  harbour: { x: 82, y: 398, label: 'Saltmarket\nHarbour', side: 'right' },
  foundry: { x: 176, y: 296, label: 'Blackreach\nFoundry', side: 'right' },
  // The two northern stops label to the LEFT. Placed on the right they
  // run past the edge of the map and the frontier loses half its name.
  terraces: { x: 262, y: 180, label: 'The Gilded\nTerraces', side: 'left' },
  frontier: { x: 312, y: 66, label: 'Coldwater\nFrontier', side: 'left' },
};

const ORDER = ['harbour', 'foundry', 'terraces', 'frontier'];

/** The road, as one path so a traveller can be positioned along it. */
const ROAD =
  'M 82 398 C 114 366 136 334 176 296 C 208 264 224 224 262 180 C 284 152 294 110 312 66';

export function GameMap({ regions = [], location, travel, onSelect, selected, loaded }) {
  const roadRef = useRef(null);
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [progress, setProgress] = useState(0);
  const [, setResizeTick] = useState(0);

  // The traveller is a DOM element over the SVG, so it has to be
  // repositioned whenever the SVG's scale changes.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setResizeTick((n) => n + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  /**
   * Walk the traveller along the road.
   *
   * Position comes from getPointAtLength on the real path, so the figure
   * follows the drawn curve exactly rather than a straight line that
   * happens to end in the same place. Progress is recomputed from the
   * wall clock on every frame rather than incremented, so a backgrounded
   * tab does not leave the trader stranded halfway.
   */
  useEffect(() => {
    const road = roadRef.current;
    const box = boxRef.current;
    if (!road || !box) return;

    const total = road.getTotalLength();
    const at = (place) => {
      const i = ORDER.indexOf(place);
      return (i / (ORDER.length - 1)) * total;
    };

    /**
     * SVG coordinates to pixels inside the container.
     *
     * The traveller is a DOM element layered over the SVG, and the SVG
     * letterboxes - its viewBox is portrait and the panel usually is not,
     * so the drawing is scaled and centred with empty margin either side.
     * Positioning by percentage of the container therefore puts the
     * figure beside the road rather than on it, by however much that
     * margin happens to be.
     *
     * getScreenCTM gives the actual transform the browser applied, so
     * this lands on the path exactly at any panel size.
     */
    const toPixels = (len) => {
      const p = road.getPointAtLength(len);
      const ctm = road.getScreenCTM();
      if (!ctm) return null;
      const screen = p.matrixTransform(ctm);
      const rect = box.getBoundingClientRect();
      return { x: screen.x - rect.left, y: screen.y - rect.top };
    };

    if (!travel) {
      setPos(toPixels(at(location)));
      setProgress(0);
      return;
    }

    const from = at(travel.from);
    const to = at(travel.to);
    const started = travel.startedAt;
    const duration = travel.seconds * 1000;

    let raf;
    const step = () => {
      // Progress is recomputed from the clock rather than incremented,
      // so a backgrounded tab does not leave the trader stranded.
      const t = Math.min(1, (Date.now() - started) / duration);
      setPos(toPixels(from + (to - from) * t));
      setProgress(t);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [location, travel, setResizeTick]);

  const travelling = travel && progress < 1;

  return (
    <div className="map" ref={boxRef}>
      <svg
        viewBox="0 0 380 480"
        className="map-svg"
        role="img"
        aria-label="Map of the four markets"
      >
        <defs>
          <linearGradient id="sea" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--map-sea)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--map-sea)" stopOpacity="0.35" />
          </linearGradient>
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.045" />
            </feComponentTransfer>
            <feComposite operator="over" in2="SourceGraphic" />
          </filter>
        </defs>

        <rect width="380" height="480" fill="var(--map-land)" />

        {/* The sea, lower-left. The harbour sits on it, which is the
            only reason the harbour is where everything arrives. */}
        <path d="M0 480 L0 348 C 60 378 80 424 100 480 Z" fill="url(#sea)" />
        {[0, 1, 2].map((i) => (
          <path
            key={i}
            d={`M${6 + i * 12} ${472 - i * 26} q 14 -8 28 0`}
            stroke="var(--map-sea-line)"
            strokeWidth="1"
            fill="none"
            opacity="0.5"
          />
        ))}

        {/* Terrain. Hills thicken toward the frontier, so the far end of
            the road looks like the hard end of the road. */}
        <g stroke="var(--map-ink)" strokeWidth="1.1" fill="none" opacity="0.3">
          {[
            'M196 392 l10 -11 l10 11',
            'M220 380 l11 -13 l11 13',
            'M292 268 l9 -10 l9 10',
            'M312 250 l10 -12 l10 12',
            'M60 224 l9 -10 l9 10',
            'M84 210 l10 -11 l10 11',
            'M150 122 l10 -12 l10 12',
            'M176 108 l11 -13 l11 13',
            'M206 118 l9 -11 l9 11',
          ].map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>

        {/* Woodland, as clusters of small marks. */}
        <g fill="var(--map-ink)" opacity="0.22">
          {[
            [40, 300],
            [52, 312],
            [30, 318],
            [62, 296],
            [250, 440],
            [264, 452],
            [238, 452],
            [276, 436],
            [120, 190],
            [134, 200],
            [108, 202],
          ].map(([x, y], i) => (
            <path key={i} d={`M${x} ${y} l4 -9 l4 9 z`} />
          ))}
        </g>

        {/* The road. Drawn twice: a soft under-stroke so it reads as a
            track on the land, and the dashed line over it. */}
        <path
          d={ROAD}
          stroke="var(--map-road-bed)"
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
        />
        <path
          ref={roadRef}
          d={ROAD}
          stroke="var(--map-road)"
          strokeWidth="1.8"
          strokeDasharray="5 7"
          fill="none"
          strokeLinecap="round"
        />

        {/* The stops. */}
        {ORDER.map((id) => {
          const place = PLACES[id];
          const region = regions.find((r) => r.id === id);
          const here = location === id && !travelling;
          const isTarget = selected === id;

          return (
            <g
              key={id}
              className={`place ${here ? 'is-here' : ''} ${isTarget ? 'is-target' : ''}`}
              transform={`translate(${place.x} ${place.y})`}
              onClick={() => onSelect?.(id)}
              style={{ cursor: onSelect && !here ? 'pointer' : 'default' }}
            >
              <circle r="17" className="place-hit" fill="transparent" />
              <circle r="7" className="place-dot" />
              <circle r="11.5" className="place-ring" fill="none" />

              <text
                className="place-label"
                x={place.side === 'left' ? -20 : 20}
                y="-2"
                textAnchor={place.side === 'left' ? 'end' : 'start'}
              >
                {place.label.split('\n').map((line, i) => (
                  <tspan key={i} x={place.side === 'left' ? -20 : 20} dy={i === 0 ? 0 : 12}>
                    {line}
                  </tspan>
                ))}
              </text>
              {region && !here && (
                <text
                  className="place-fare num"
                  x={place.side === 'left' ? -20 : 20}
                  y="26"
                  textAnchor={place.side === 'left' ? 'end' : 'start'}
                >
                  {region.travelCost.toLocaleString()} · {region.travelSeconds}s
                </text>
              )}
            </g>
          );
        })}

        <rect width="380" height="480" filter="url(#grain)" opacity="0.5" pointerEvents="none" />

        {/* Compass, bottom right. Purely decorative, and the map would
            look unfinished without it. */}
        <g transform="translate(336 434)" opacity="0.5">
          <circle r="17" fill="none" stroke="var(--map-ink)" strokeWidth="0.9" />
          <path d="M0 -13 L4 0 L0 13 L-4 0 Z" fill="var(--map-ink)" opacity="0.7" />
          <text className="compass-n" y="-20" textAnchor="middle">
            N
          </text>
        </g>
      </svg>

      {/* The traveller rides above the SVG in normal flow, so the figure
          keeps its own animation and does not inherit SVG scaling. */}
      {pos && (
        <div
          className={`traveller ${travelling ? 'is-moving' : ''}`}
          style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
        >
          <Caravan size={48} walking={travelling} loaded={loaded} />
        </div>
      )}

      {travelling && (
        <div className="travel-progress">
          <div className="travel-progress-bar">
            <span style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="num small">
            {Math.ceil(travel.seconds * (1 - progress))}s to{' '}
            {regions.find((r) => r.id === travel.to)?.name ?? travel.to}
          </span>
        </div>
      )}
    </div>
  );
}
