import { PriceSnapshot } from '../models/PriceSnapshot.js';

const RANGES = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const VALID_RANGES = Object.keys(RANGES);

/**
 * Price history for a chart.
 *
 * Long ranges are downsampled rather than returned in full. A month of
 * minute-resolution snapshots is around 43,000 points for one good,
 * which is far more than any chart can draw and far more than is worth
 * sending - so the query thins them to roughly `maxPoints` by taking
 * every Nth reading.
 *
 * Thinning rather than averaging is deliberate: every point returned is
 * a price that genuinely existed at that moment. An averaged point is a
 * number that was never true, which is a strange thing to draw on a
 * price chart.
 */
export async function priceHistory(goodId, { range = '24h', maxPoints = 200 } = {}) {
  const windowMs = RANGES[range] ?? RANGES['24h'];
  const since = new Date(Date.now() - windowMs);

  const snapshots = await PriceSnapshot.find({ goodId, at: { $gte: since } })
    .sort({ at: 1 })
    .lean();

  if (snapshots.length <= maxPoints) {
    return { range, points: snapshots.map(toPoint) };
  }

  const step = Math.ceil(snapshots.length / maxPoints);
  const thinned = snapshots.filter((_, i) => i % step === 0);

  // Always keep the most recent reading, whatever the step lands on -
  // a chart whose last point is several minutes stale looks broken.
  const last = snapshots[snapshots.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);

  return { range, points: thinned.map(toPoint) };
}

const toPoint = (s) => ({ at: s.at, price: s.price, supply: s.supply });

/** Price change over a window, for the market listing. */
export async function change24h(goodIds) {
  const since = new Date(Date.now() - RANGES['24h']);
  const out = new Map();

  for (const goodId of goodIds) {
    const [oldest, newest] = await Promise.all([
      PriceSnapshot.findOne({ goodId, at: { $gte: since } })
        .sort({ at: 1 })
        .lean(),
      PriceSnapshot.findOne({ goodId }).sort({ at: -1 }).lean(),
    ]);

    if (!oldest || !newest || oldest.price === 0) {
      out.set(goodId.toString(), null);
      continue;
    }
    out.set(
      goodId.toString(),
      Math.round(((newest.price - oldest.price) / oldest.price) * 10_000) / 100,
    );
  }
  return out;
}
