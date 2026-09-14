import mongoose from 'mongoose';
import { Good } from '../models/Good.js';
import { Holding } from '../models/Holding.js';
import { getRedis } from '../redis/client.js';
import {
  goodSupply,
  goodBasePrice,
  userCash,
  userHoldings,
  ECON_RESERVE,
  ECON_BURNED,
  STREAM_TRADES,
} from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { ensureAccountLoaded, readCash, readHoldings } from './accounts.js';
import { publishPriceChange } from '../realtime/publish.js';
import { readGoodMeta } from './goodCache.js';
import {
  buyCost,
  sellBreakdown,
  price,
  maxTradeQty,
  BPS,
  SELL_SPREAD_BPS,
  MAX_TRADE_SUPPLY_BPS,
  BOOTSTRAP_TRADE_QTY,
} from '@tgc/shared';

/**
 * Trade execution - ATOMIC VERSION.
 *
 * The check-and-mutate lives in `lua/trade.lua`, which Redis runs start
 * to finish with nothing interleaved. Since Phase 6 that script also
 * appends the trade to a Redis stream inside the same atomic block, so
 * this module writes nothing to Mongo at all.
 *
 * That is the point. There is no second write here that could fail and
 * leave the market moved with the ledger silent. The stream *is* the
 * ledger; `packages/relay` copies it into Mongo afterwards, and if Mongo
 * is unreachable the entries simply wait.
 *
 * What remains in JavaScript is only the slippage bound, which does not
 * need to be atomic - it is an input to the script, not a mutation.
 */

/** How far the price may move against the caller before the trade is refused. */
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%

/**
 * The good's curve shape, from the Redis cache.
 *
 * k and n never change, so there is no reason for a trade to ask Mongo
 * for them. Doing so put an Atlas round trip inside a path that is
 * otherwise Redis-only, and it showed up as an 827ms p95 against a 42ms
 * p50 under load - the tail was the database, every time.
 */
async function loadGood(goodId) {
  if (!mongoose.Types.ObjectId.isValid(goodId)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }
  return readGoodMeta(goodId);
}

/**
 * Turn a slippage tolerance into a hard number the script can compare
 * against.
 *
 * The client sends a tolerance, never a price. This reads supply now,
 * prices the trade at that supply, and widens it by the tolerance. By
 * the time the script runs, supply may have moved - that is precisely
 * the window the bound protects. A trade that would execute outside it
 * is refused rather than filled at a worse price.
 */
async function computeLimit({ good, side, qty, slippageBps }) {
  const redis = getRedis();
  const [supplyRaw, baseRaw] = await redis.mget(goodSupply(good.id), goodBasePrice(good.id));
  if (supplyRaw === null || baseRaw === null) {
    throw ApiError.notFound('market_not_found', 'No live market for that good');
  }

  const supply = Number(supplyRaw);
  const basePrice = Number(baseRaw);

  if (side === 'buy') {
    const expected = buyCost(basePrice, supply, qty, good.k, good.n);
    return {
      limit: Math.ceil((expected * (BPS + slippageBps)) / BPS),
      supply,
      basePrice,
      expected,
    };
  }

  if (qty > supply) {
    throw ApiError.badRequest('insufficient_supply', 'Cannot sell more units than exist');
  }
  const expected = sellBreakdown(basePrice, supply, qty, good.k, good.n).net;
  return { limit: Math.floor((expected * (BPS - slippageBps)) / BPS), supply, basePrice, expected };
}

const ERROR_MAP = {
  market_not_found: () => ApiError.notFound('market_not_found', 'No live market for that good'),
  cash_not_loaded: () => ApiError.badRequest('cash_not_loaded', 'Account not loaded'),
  trade_too_large: (cap) =>
    ApiError.badRequest(
      'trade_too_large',
      `A single trade may move at most ${cap} units at the current supply`,
      { maxQty: Number(cap) },
    ),
  insufficient_funds: (required, available) =>
    ApiError.badRequest('insufficient_funds', 'Not enough Notes for that trade', {
      required: Number(required),
      available: Number(available),
    }),
  insufficient_holdings: (required, available) =>
    ApiError.badRequest('insufficient_holdings', 'You do not hold that many units', {
      required: Number(required),
      available: Number(available),
    }),
  insufficient_supply: () =>
    ApiError.badRequest('insufficient_supply', 'Cannot sell more units than exist'),
  slippage: (actual, limit) =>
    ApiError.badRequest('slippage_exceeded', 'The price moved past your slippage tolerance', {
      actual: Number(actual),
      limit: Number(limit),
    }),
};

export async function executeTrade({ userId, goodId, side, qty, slippageBps }) {
  const tolerance = slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const good = await loadGood(goodId);

  await ensureAccountLoaded(userId);
  const {
    limit,
    supply: supplyBefore,
    basePrice,
  } = await computeLimit({
    good,
    side,
    qty,
    slippageBps: tolerance,
  });

  const id = good.id;
  const redis = getRedis();

  // Everything that has to be indivisible happens inside this one call.
  const result = await redis.trade(
    goodSupply(id),
    goodBasePrice(id),
    userCash(userId),
    userHoldings(userId),
    ECON_RESERVE,
    ECON_BURNED,
    STREAM_TRADES,
    side,
    qty,
    id,
    good.k,
    good.n,
    SELL_SPREAD_BPS,
    limit,
    MAX_TRADE_SUPPLY_BPS,
    BOOTSTRAP_TRADE_QTY,
    userId,
  );

  const [status, ...rest] = result;
  if (status === 'error') {
    const [code, ...details] = rest;
    const build = ERROR_MAP[code];
    throw build ? build(...details) : ApiError.badRequest(code, 'Trade rejected');
  }

  const [supplyAfterRaw, notionalRaw, spreadRaw, cashAfterRaw, streamId] = rest;
  const supplyAfter = Number(supplyAfterRaw);
  const notional = Number(notionalRaw);
  const spread = Number(spreadRaw);
  const cashAfter = Number(cashAfterRaw);

  // Announce the new price. Fire and forget: a trade that executed and
  // was written to the ledger must not fail because a notification
  // could not be delivered.
  publishPriceChange({
    goodId: good.id,
    price: Math.round(price(basePrice, supplyAfter, good.k, good.n) * 100) / 100,
    supply: supplyAfter,
    side,
    quantity: qty,
  }).catch(() => {});

  // The trade is already durable at this point - it is in the stream.
  // What comes back is built from the script's own return values rather
  // than read back from Mongo, which has very likely not been projected
  // yet and is not the source of truth anyway.
  return {
    trade: {
      id: streamId,
      goodId: good.id,
      side,
      quantity: qty,
      notional,
      spread,
      avgPrice: Math.round((notional / qty) * 100) / 100,
      at: new Date().toISOString(),
    },
    cash: cashAfter,
    supply: supplyAfter,
    supplyBefore,
    priceAfter: Math.round(price(basePrice, supplyAfter, good.k, good.n) * 100) / 100,
  };
}

/**
 * A player's full position, read from the live Redis state rather than
 * the Mongo projection, so it can never show a stale balance.
 */
export async function getPortfolio(userId) {
  await ensureAccountLoaded(userId);

  const [cash, held] = await Promise.all([readCash(userId), readHoldings(userId)]);
  const goodIds = [...held.keys()];
  const goods = await Good.find({ _id: { $in: goodIds } }).lean();
  const goodsById = new Map(goods.map((g) => [g._id.toString(), g]));

  const mongoHoldings = await Holding.find({ userId, goodId: { $in: goodIds } }).lean();
  const costByGood = new Map(mongoHoldings.map((h) => [h.goodId.toString(), h.avgCost]));

  const redis = getRedis();
  const keys = goodIds.flatMap((id) => [goodSupply(id), goodBasePrice(id)]);
  const live = keys.length > 0 ? await redis.mget(...keys) : [];

  let holdingsValue = 0;
  const rows = goodIds.map((goodId, i) => {
    const good = goodsById.get(goodId);
    const quantity = held.get(goodId);
    const supply = Number(live[i * 2]);
    const basePrice = Number(live[i * 2 + 1]);
    const avgCost = costByGood.get(goodId) ?? 0;

    // Valued at what selling would actually return: spread taken, curve
    // walked back down. Spot times quantity would overstate every
    // portfolio in the game.
    const sellable = Math.min(quantity, supply, maxTradeQty(supply));
    const value = sellable > 0 ? sellBreakdown(basePrice, supply, sellable, good.k, good.n).net : 0;
    const scaled = sellable > 0 ? Math.round((value / sellable) * quantity) : 0;
    holdingsValue += scaled;

    const costBasis = Math.round(avgCost * quantity);
    return {
      goodId,
      name: good.name,
      colorToken: good.colorToken,
      quantity,
      avgCost: Math.round(avgCost * 100) / 100,
      currentPrice: Math.round(price(basePrice, supply, good.k, good.n) * 100) / 100,
      value: scaled,
      costBasis,
      unrealizedPL: scaled - costBasis,
    };
  });

  return {
    cash,
    holdingsValue,
    netWorth: cash + holdingsValue,
    unrealizedPL: rows.reduce((sum, r) => sum + r.unrealizedPL, 0),
    holdings: rows,
  };
}
