import mongoose from 'mongoose';
import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { User } from '../models/User.js';
import { Holding } from '../models/Holding.js';
import { Trade } from '../models/Trade.js';
import { getRedis } from '../redis/client.js';
import {
  goodSupply,
  goodBasePrice,
  userCash,
  userHoldings,
  ECON_RESERVE,
  ECON_BURNED,
} from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { ensureAccountLoaded, readCash, readHoldings } from './accounts.js';
import { log } from '../log.js';
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
 * The check-and-mutate that used to live here now lives in
 * `lua/trade.lua`, which Redis runs start to finish with nothing
 * interleaved. What remains in JavaScript is everything that does *not*
 * need to be atomic:
 *
 *   before  work out the slippage bound to hand the script
 *   after   write the outcome down in Mongo
 *
 * The "after" half is still a second write that can fail on its own, and
 * Phase 6 removes it: the script appends the trade to a Redis stream, and
 * a separate worker projects that stream into Mongo. Until then the
 * durable record can lag the live state, which is noted in ADR-014.
 */

/** How far the price may move against the caller before the trade is refused. */
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%

async function loadGood(goodId) {
  if (!mongoose.Types.ObjectId.isValid(goodId)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }
  const good = await Good.findById(goodId);
  if (!good) throw ApiError.notFound('good_not_found', 'No good with that id');
  return good;
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
  const [supplyRaw, baseRaw] = await redis.mget(
    goodSupply(good._id.toString()),
    goodBasePrice(good._id.toString()),
  );
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

  const id = good._id.toString();
  const redis = getRedis();

  // Everything that has to be indivisible happens inside this one call.
  const result = await redis.trade(
    goodSupply(id),
    goodBasePrice(id),
    userCash(userId),
    userHoldings(userId),
    ECON_RESERVE,
    ECON_BURNED,
    side,
    qty,
    id,
    good.k,
    good.n,
    SELL_SPREAD_BPS,
    limit,
    MAX_TRADE_SUPPLY_BPS,
    BOOTSTRAP_TRADE_QTY,
  );

  const [status, ...rest] = result;
  if (status === 'error') {
    const [code, ...details] = rest;
    const build = ERROR_MAP[code];
    throw build ? build(...details) : ApiError.badRequest(code, 'Trade rejected');
  }

  const [supplyAfterRaw, notionalRaw, spreadRaw, cashAfterRaw] = rest;
  const supplyAfter = Number(supplyAfterRaw);
  const notional = Number(notionalRaw);
  const spread = Number(spreadRaw);
  const cashAfter = Number(cashAfterRaw);

  const trade = await projectToMongo({
    userId,
    good,
    side,
    qty,
    supplyBefore,
    supplyAfter,
    basePrice,
    notional,
    spread,
    cashAfter,
  });

  return {
    trade,
    cash: cashAfter,
    supply: supplyAfter,
    priceAfter: Math.round(price(basePrice, supplyAfter, good.k, good.n) * 100) / 100,
  };
}

/**
 * Write the executed trade down in Mongo.
 *
 * This runs *after* the atomic block, so it can fail independently -
 * leaving Redis correct and Mongo behind. That is the dual write Phase 6
 * removes by making the script append to a Redis stream and having a
 * relay worker project it. Failures are logged loudly rather than
 * swallowed, because until then they need a human.
 */
async function projectToMongo({
  userId,
  good,
  side,
  qty,
  supplyBefore,
  supplyAfter,
  basePrice,
  notional,
  spread,
  cashAfter,
}) {
  try {
    await User.updateOne({ _id: userId }, { $set: { cash: cashAfter }, $inc: { tradeCount: 1 } });

    if (side === 'buy') {
      await addToHolding({ userId, goodId: good._id, qty, cost: notional });
    } else {
      await Holding.updateOne({ userId, goodId: good._id }, { $inc: { quantity: -qty } });
      await Holding.updateOne(
        { userId, goodId: good._id, quantity: { $lte: 0 } },
        { $set: { avgCost: 0 } },
      );
    }

    await Market.updateOne(
      { goodId: good._id },
      { $set: { supply: supplyAfter }, $inc: { vol24h: qty } },
    );

    return await Trade.create({
      userId,
      goodId: good._id,
      side,
      quantity: qty,
      supplyBefore,
      supplyAfter,
      basePrice,
      notional,
      spread,
      avgPrice: notional / qty,
    });
  } catch (err) {
    log.error('trade executed in redis but failed to project to mongo', {
      userId,
      goodId: good._id.toString(),
      side,
      qty,
      err: err.message,
    });
    throw err;
  }
}

async function addToHolding({ userId, goodId, qty, cost }) {
  const existing = await Holding.findOne({ userId, goodId });
  if (!existing) {
    await Holding.create({ userId, goodId, quantity: qty, avgCost: cost / qty });
    return;
  }
  const totalCost = existing.avgCost * existing.quantity + cost;
  existing.quantity += qty;
  existing.avgCost = totalCost / existing.quantity;
  await existing.save();
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
