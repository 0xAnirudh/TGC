import { useState } from 'react';
import { notes, money } from '../ui/index.jsx';

const COLOR = {
  slate: '#64748b',
  amber: '#c2851b',
  orange: '#c2601b',
  violet: '#6d4aa8',
  yellow: '#a8871b',
  blue: '#2c4a6e',
  indigo: '#45408f',
  rose: '#a8324a',
};

/**
 * The price board.
 *
 * Prices are shown against each good's usual value, because that
 * comparison IS the decision. A player cannot see what the next town
 * pays, so the only way to judge "is this cheap" is against what the
 * good is normally worth - and making them hold eight base values in
 * their head would be busywork, not difficulty.
 */
export function PriceBoard({ run, onBuy, onSell, busy }) {
  const [qty, setQty] = useState({});
  const room = run.capacity - run.carried;

  const setFor = (id, v) => setQty((q) => ({ ...q, [id]: v }));

  return (
    <table className="ledger prices">
      <thead>
        <tr>
          <th>Good</th>
          <th className="r">Price</th>
          <th className="r">Usually</th>
          <th className="r">Carrying</th>
          <th className="r" style={{ width: 210 }}>
            Trade
          </th>
        </tr>
      </thead>
      <tbody>
        {run.board.map((row) => {
          const ratio = row.price / row.base;
          // A verdict rather than a number, so the board can be read at a
          // glance instead of computed.
          const verdict =
            ratio < 0.55
              ? 'steal'
              : ratio < 0.8
                ? 'cheap'
                : ratio > 1.8
                  ? 'killing'
                  : ratio > 1.25
                    ? 'dear'
                    : null;

          const canAfford = Math.floor(run.cash / Math.max(1, row.effective));
          const maxBuy = Math.max(0, Math.min(room, canAfford));
          const want = qty[row.id] ?? '';

          return (
            <tr key={row.id} className={verdict ? `is-${verdict}` : ''}>
              <td>
                <span className="good">
                  <span className="swatch" style={{ background: COLOR[row.color] }} />
                  <span className="good-name">{row.name}</span>
                </span>
              </td>
              <td className="r">
                <span className="num price-now">{money(row.effective)}</span>
                {verdict && <span className={`verdict ${verdict}`}>{verdict}</span>}
              </td>
              <td className="r num faint">{notes(row.base)}</td>
              <td className="r num">
                {row.held > 0 ? notes(row.held) : <span className="faint">—</span>}
              </td>
              <td className="r">
                <div className="trade-cell">
                  <input
                    type="number"
                    min="1"
                    placeholder="0"
                    value={want}
                    onChange={(e) => setFor(row.id, e.target.value)}
                  />
                  <button
                    className="tiny buy"
                    disabled={busy || maxBuy < 1}
                    onClick={() => onBuy(row.id, Number(want) || maxBuy)}
                    title={`Up to ${maxBuy}`}
                  >
                    Buy
                  </button>
                  <button
                    className="tiny sell"
                    disabled={busy || row.held < 1}
                    onClick={() => onSell(row.id, Number(want) || row.held)}
                    title={`Up to ${row.held}`}
                  >
                    Sell
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
