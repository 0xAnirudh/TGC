import { Market } from '../models/Market.js';
import { Good } from '../models/Good.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice } from '../redis/keys.js';
import { log } from '../log.js';
import { ApiError } from '../util/errors.js';
import { price, buyCost, sellBreakdown, maxTradeQty } from '@tgc/shared';

/**
 * Market state lives in two places, and which one wins matters.
 *
 *   Redis  - the live copy. Every read on the hot path comes from here,
 *            and from Phase 5 every write happens here, atomically.
 *   Mongo  - the durable copy. What Redis is rebuilt from when it is
 *            empty.
 *
 * Redis is authoritative while the system is running. Mongo is
 * authoritative only when Redis has nothing.
 */

/**
 * Copy market state from Mongo into Redis for any good Redis does not
 * already know about.
 *
 * The NX flag is the whole point. If Redis already holds a supply for a
 * good, that value reflects trades that have happened and Mongo's copy
 * is stale - overwriting it on boot would silently roll the market back.
 * So warming only ever fills gaps; it never corrects.
 */
export async function warmMarketState() {
  const redis = getRedis();
  const markets = await Market.find().lean();

  let warmed = 0;
  for (const m of markets) {
    const id = m.goodId.toString();
    const [supplySet, priceSet] = await Promise.all([
      redis.set(goodSupply(id), m.supply, 'NX'),
      redis.set(goodBasePrice(id), m.basePrice, 'NX'),
    ]);
    if (supplySet || priceSet) warmed += 1;
  }

  log.info('market state warmed', { markets: markets.length, warmed });
  return { total: markets.length, warmed };
}

/**
 * Read one good's live numbers from Redis. No Mongo round trip - this is
 * on the quote path, which NFR-1 holds to p95 under 10ms.
 */
export async function readMarketState(goodId) {
  const redis = getRedis();
  const [supply, basePrice] = await redis.mget(goodSupply(goodId), goodBasePrice(goodId));

  if (supply === null || basePrice === null) {
    throw ApiError.notFound('market_not_found', 'No live market for that good');
  }
  return { supply: Number(supply), basePrice: Number(basePrice) };
}

/** Read every good's live numbers in one round trip rather than N. */
export async function readAllMarketState(goodIds) {
  if (goodIds.length === 0) return new Map();

  const redis = getRedis();
  const keys = goodIds.flatMap((id) => [goodSupply(id), goodBasePrice(id)]);
  const values = await redis.mget(...keys);

  const state = new Map();
  goodIds.forEach((id, i) => {
    const supply = values[i * 2];
    const basePrice = values[i * 2 + 1];
    if (supply !== null && basePrice !== null) {
      state.set(id, { supply: Number(supply), basePrice: Number(basePrice) });
    }
  });
  return state;
}

/**
 * Price a hypothetical trade.
 *
 * Non-binding, and deliberately so. By the time the client acts on it
 * someone else may have moved the supply, which is why every real trade
 * carries a maxSlippage from Phase 5 rather than a price. The client
 * never submits a price; the curve decides it.
 */
export function computeQuote({ basePrice, supply, k, n, side, qty }) {
  const cap = maxTradeQty(supply);
  if (qty > cap) {
    throw ApiError.badRequest(
      'trade_too_large',
      `A single trade may move at most ${cap} units at the current supply`,
      { maxQty: cap },
    );
  }

  const spotPrice = price(basePrice, supply, k, n);

  if (side === 'buy') {
    const total = buyCost(basePrice, supply, qty, k, n);
    const supplyAfter = supply + qty;
    return {
      side,
      qty,
      supply,
      spotPrice: round2(spotPrice),
      total,
      avgPrice: round2(total / qty),
      priceAfter: round2(price(basePrice, supplyAfter, k, n)),
      spread: 0,
      maxQty: cap,
    };
  }

  if (qty > supply) {
    throw ApiError.badRequest('insufficient_supply', 'Cannot sell more units than exist');
  }

  const { gross, spread, net } = sellBreakdown(basePrice, supply, qty, k, n);
  const supplyAfter = supply - qty;
  return {
    side,
    qty,
    supply,
    spotPrice: round2(spotPrice),
    total: net,
    gross,
    avgPrice: round2(net / qty),
    priceAfter: round2(price(basePrice, supplyAfter, k, n)),
    spread,
    maxQty: cap,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

/** A good plus its live market numbers, for listings and detail pages. */
export async function listGoodsWithMarket() {
  const goods = await Good.find().lean();
  const state = await readAllMarketState(goods.map((g) => g._id.toString()));

  return goods.map((g) => {
    const id = g._id.toString();
    const live = state.get(id);
    return {
      id,
      name: g.name,
      colorToken: g.colorToken,
      issuerId: g.issuerId ? g.issuerId.toString() : null,
      k: g.k,
      n: g.n,
      // A good with no live state has not been warmed into Redis yet.
      // Report it rather than inventing a price.
      price: live ? round2(price(live.basePrice, live.supply, g.k, g.n)) : null,
      supply: live ? live.supply : null,
    };
  });
}
