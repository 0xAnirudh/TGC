import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { PriceSnapshot } from '../models/PriceSnapshot.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice } from '../redis/keys.js';
import { log } from '../log.js';
import { price } from '@tgc/shared';

/**
 * Price drift.
 *
 * Without this, a good's price is completely static whenever nobody is
 * trading it, which makes an empty market feel dead and makes every
 * chart a flat line. Drift nudges `basePrice` on a bounded random walk so
 * the world keeps moving.
 *
 * It moves `basePrice`, never `supply`. Supply is the thing the ledger
 * accounts for - moving it here would create units nobody bought, and
 * the Phase 6 rebuild would correctly erase them (FINDING-007).
 * `basePrice` is not conserved by any invariant, so it is safe to move.
 *
 * Drift also cannot mint or burn Notes. It changes what things cost, not
 * who owns what, so the money supply invariant is untouched by
 * construction.
 */

/** Most a single tick may move a price, either way. */
export const MAX_TICK_DRIFT_BPS = 150; // 1.5%

/** Bounds relative to the good's launch price, so nothing runs away. */
export const MIN_BASE_PRICE_RATIO = 0.25;
export const MAX_BASE_PRICE_RATIO = 4;

/**
 * Nudge one price.
 *
 * Recent volume biases the direction: a good people are actively buying
 * drifts up, one being sold off drifts down. Without the bias, drift is
 * pure noise and a player's trading has no lasting effect on anything
 * beyond the immediate curve position.
 *
 * `random` is injectable so the bounds can be tested at their extremes
 * rather than hoped for across many samples.
 */
export function nextBasePrice({ basePrice, launchPrice, volumeBias = 0, random = Math.random }) {
  // random() in [0,1) maps to [-1,1], then shifted by the bias.
  const direction = random() * 2 - 1 + volumeBias;
  const clamped = Math.max(-1, Math.min(1, direction));
  const move = (clamped * MAX_TICK_DRIFT_BPS) / 10_000;

  const next = basePrice * (1 + move);
  const floor = launchPrice * MIN_BASE_PRICE_RATIO;
  const ceiling = launchPrice * MAX_BASE_PRICE_RATIO;

  // Round to whole Notes. A basePrice with a fractional part would make
  // the Lua and JavaScript curves agree only to float precision, and
  // FINDING-005 is about exactly that class of divergence.
  return Math.max(floor, Math.min(ceiling, Math.round(next)));
}

/**
 * One drift tick across every good, plus a price snapshot each.
 *
 * Must be called inside a job lock - see services/jobLock.js. Running it
 * on several instances at once would move every price once per instance.
 */
export async function driftTick({ random = Math.random } = {}) {
  const redis = getRedis();
  const goods = await Good.find().lean();
  const markets = await Market.find().lean();
  const launchPriceByGood = new Map(markets.map((m) => [m.goodId.toString(), m.basePrice]));

  const snapshots = [];
  const moved = [];

  for (const good of goods) {
    const id = good._id.toString();
    const [supplyRaw, baseRaw] = await redis.mget(goodSupply(id), goodBasePrice(id));
    if (supplyRaw === null || baseRaw === null) continue;

    const supply = Number(supplyRaw);
    const basePrice = Number(baseRaw);
    const launchPrice = launchPriceByGood.get(id) ?? basePrice;

    const market = markets.find((m) => m.goodId.toString() === id);
    const volumeBias = volumeBiasFor(market?.vol24h ?? 0, supply);

    const next = nextBasePrice({ basePrice, launchPrice, volumeBias, random });
    if (next !== basePrice) {
      await redis.set(goodBasePrice(id), next);
      moved.push({ good: good.name, from: basePrice, to: next });
    }

    snapshots.push({
      goodId: good._id,
      price: Math.round(price(next, supply, good.k, good.n) * 100) / 100,
      supply,
      basePrice: next,
      at: new Date(),
    });
  }

  if (snapshots.length > 0) {
    await PriceSnapshot.insertMany(snapshots, { ordered: false });
    await Promise.all(
      snapshots.map((s) =>
        Market.updateOne({ goodId: s.goodId }, { $set: { basePrice: s.basePrice } }),
      ),
    );
  }

  log.info('drift tick', { goods: goods.length, moved: moved.length });
  return { goods: goods.length, moved, snapshots: snapshots.length };
}

/**
 * Turn recent volume into a directional nudge in [-0.4, 0.4].
 *
 * Deliberately capped well below 1 so the bias tilts the walk rather
 * than replacing it. A bias of 1 would make a busy good drift up on
 * every single tick, which is a trend, not a market.
 */
function volumeBiasFor(vol24h, supply) {
  if (supply <= 0) return 0;
  const turnover = vol24h / supply;
  return Math.min(0.4, turnover) * 0.8;
}
