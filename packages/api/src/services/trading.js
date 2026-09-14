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
} from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { ensureAccountLoaded, readCash, readHoldings } from './accounts.js';
import { publishPriceChange } from '../realtime/publish.js';
import { readGoodMeta } from './goodCache.js';
import { currentLocation, assertNotTravelling, cargoUsed } from './location.js';
import { Trade } from '../models/Trade.js';
import { Market } from '../models/Market.js';
import { User } from '../models/User.js';
import { log } from '../log.js';
import { randomUUID } from 'node:crypto';
import {
  buyCost,
  sellBreakdown,
  price,
  maxTradeQty,
  BPS,
  SELL_SPREAD_BPS,
  MAX_TRADE_SUPPLY_BPS,
  BOOTSTRAP_TRADE_QTY,
  BASE_CARGO,
} from '@tgc/shared';

/**
 * Trade execution - ATOMIC VERSION.
 *
 * The check-and-mutate lives in `lua/trade.lua`, which Redis runs start
 * to finish with nothing interleaved. That is what makes concurrent
 * trades correct, and it has not changed.
 *
 * What did change: the ledger row is written here, straight to Mongo,
 * rather than being appended to a Redis stream and projected by a
 * separate worker. That worker and its stream are gone.
 *
 * THE COST OF THAT, STATED HONESTLY. This is a dual write. The script
 * can succeed and the Mongo write can fail, leaving the market moved
 * with no ledger row to show for it. The stream version could not do
 * that, because there was no second write to fail.
 *
 * Why it is an acceptable trade here: the failure is loud (logged with
 * everything needed to reconstruct the row), it is rare (a Mongo outage,
 * not a race), and the live market - which is what players actually
 * interact with - is in Redis and stays correct either way. What is lost
 * is a row in the history, not a player's money.
 *
 * What is NOT lost: the rebuild. `services/rebuild.js` replays the Mongo
 * `trades` collection, which is still written on every trade. FLUSHDB
 * followed by `npm run rebuild` still reconstructs the entire market.
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
async function computeLimit({ good, side, qty, slippageBps, region }) {
  const redis = getRedis();
  const [supplyRaw, baseRaw] = await redis.mget(
    goodSupply(good.id, region),
    goodBasePrice(good.id, region),
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

  // You trade where you are standing. Trading from the road would make
  // travel free - you could carry the cheap prices with you.
  await assertNotTravelling(userId);
  const region = await currentLocation(userId);

  // Cargo is the scarce resource. Checked before the script runs,
  // because the hold belongs to the player rather than the market and
  // the script has no business knowing about it.
  if (side === 'buy') {
    const { User: U } = await import('../models/User.js');
    const [used, user] = await Promise.all([cargoUsed(userId), U.findById(userId).lean()]);
    const capacity = user?.cargoCapacity ?? BASE_CARGO;
    if (used + qty > capacity) {
      throw ApiError.badRequest('cargo_full', 'Not enough room in the hold', {
        used,
        capacity,
        free: Math.max(0, capacity - used),
        requested: qty,
      });
    }
  }

  const {
    limit,
    supply: supplyBefore,
    basePrice,
  } = await computeLimit({
    good,
    side,
    qty,
    slippageBps: tolerance,
    region,
  });

  const id = good.id;
  const redis = getRedis();

  // Everything that has to be indivisible happens inside this one call.
  // The only regional thing about it is which keys it is handed.
  const result = await redis.trade(
    goodSupply(id, region),
    goodBasePrice(id, region),
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

  // Announce the new price. Fire and forget: a trade that executed and
  // was written to the ledger must not fail because a notification
  // could not be delivered.
  publishPriceChange({
    goodId: good.id,
    region,
    price: Math.round(price(basePrice, supplyAfter, good.k, good.n) * 100) / 100,
    supply: supplyAfter,
    side,
    quantity: qty,
  }).catch(() => {});

  // Written in the background, deliberately not awaited. See recordTrade.
  const trade = buildLedgerRow({
    userId,
    good,
    region,
    side,
    qty,
    supplyBefore,
    supplyAfter,
    basePrice,
    notional,
    spread,
    region,
  });
  recordTrade(trade, cashAfter).catch(() => {});

  return {
    trade,
    cash: cashAfter,
    supply: supplyAfter,
    supplyBefore,
    priceAfter: Math.round(price(basePrice, supplyAfter, good.k, good.n) * 100) / 100,
  };
}

/**
 * The ledger row, built from the script's own return values.
 *
 * Everything needed is already known the moment the script returns -
 * nothing has to be read back - so the response can be assembled before
 * the row reaches Mongo.
 */
function buildLedgerRow({
  userId,
  good,
  region,
  side,
  qty,
  supplyBefore,
  supplyAfter,
  basePrice,
  notional,
  spread,
}) {
  return {
    id: randomUUID(),
    userId,
    goodId: good.id,
    region,
    side,
    quantity: qty,
    supplyBefore,
    supplyAfter,
    basePrice,
    notional,
    spread,
    avgPrice: Math.round((notional / qty) * 100) / 100,
    at: new Date().toISOString(),
  };
}

/**
 * Write the trade down, in the background.
 *
 * NOT awaited by the request, and the writes go out in parallel rather
 * than one after another. Both of those are deliberate, and the reason
 * is measurable.
 *
 * When the stream and relay were removed, these four writes moved into
 * the request path, sequentially. Trade latency went from a p50 of 6ms
 * to 932ms - four Atlas round trips at roughly 36ms each, plus a read.
 * That is not a tuning problem; it is what putting a remote database in
 * front of a response looks like.
 *
 * Not awaiting costs nothing that was not already given up. This was
 * always a dual write - the script can succeed and these can fail -
 * so the durability guarantee is identical whether the caller waits for
 * them or not. Waiting only made the player watch it happen.
 *
 * What it does cost: two trades in quick succession can have their
 * projections land out of order. Quantity uses $inc so it does not care,
 * and cash in Mongo is a projection that nothing reads - /me and the
 * portfolio both read Redis, and the rebuild recomputes from
 * startingGrant plus the trade rows. A stale value there is cosmetic.
 */
async function recordTrade(row, cashAfter) {
  try {
    await Promise.all([
      Trade.create({ ...row, streamId: row.id }),
      User.updateOne({ _id: row.userId }, { $set: { cash: cashAfter }, $inc: { tradeCount: 1 } }),
      Market.updateOne(
        { goodId: row.goodId, region: row.region },
        { $set: { supply: row.supplyAfter }, $inc: { vol24h: row.quantity } },
      ),
      updateHolding({
        userId: row.userId,
        goodId: row.goodId,
        side: row.side,
        qty: row.quantity,
        cost: row.notional,
      }),
    ]);
  } catch (err) {
    // Logged with every field needed to reconstruct the row by hand. The
    // player has already been told their trade succeeded, because in
    // Redis - which is the live market - it did.
    log.error('trade executed but the ledger write failed', { ...row, err: err.message });
  }
}

/** Move the position and its weighted average cost. Sells leave the average alone. */
async function updateHolding({ userId, goodId, side, qty, cost }) {
  if (side === 'sell') {
    await Holding.updateOne({ userId, goodId }, { $inc: { quantity: -qty } });
    await Holding.updateOne({ userId, goodId, quantity: { $lte: 0 } }, { $set: { avgCost: 0 } });
    return;
  }

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
  const region = await currentLocation(userId);

  const [cash, held] = await Promise.all([readCash(userId), readHoldings(userId)]);
  const goodIds = [...held.keys()];
  const goods = await Good.find({ _id: { $in: goodIds } }).lean();
  const goodsById = new Map(goods.map((g) => [g._id.toString(), g]));

  const mongoHoldings = await Holding.find({ userId, goodId: { $in: goodIds } }).lean();
  const costByGood = new Map(mongoHoldings.map((h) => [h.goodId.toString(), h.avgCost]));

  const redis = getRedis();
  // Valued at what they would fetch HERE. The same cargo is worth more
  // somewhere else, which is the point of moving it.
  const keys = goodIds.flatMap((id) => [goodSupply(id, region), goodBasePrice(id, region)]);
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

  const { openShorts } = await import('./shorting.js');
  const shorts = await openShorts(userId);

  // A short's contribution to net worth is what closing it would return
  // right now, since that is what the player would actually have.
  const shortsValue = shorts.reduce(
    (sum, s) => sum + Math.max(0, s.proceeds + s.collateral - s.costToClose),
    0,
  );

  const cargo = await cargoUsed(userId);
  const { User: U2 } = await import('../models/User.js');
  const me = await U2.findById(userId).lean();

  return {
    region,
    cargo: { used: cargo, capacity: me?.cargoCapacity ?? BASE_CARGO },
    debt: me?.debt ?? 0,
    cash,
    holdingsValue,
    shortsValue,
    netWorth: cash + holdingsValue + shortsValue,
    unrealizedPL:
      rows.reduce((sum, r) => sum + r.unrealizedPL, 0) +
      shorts.reduce((sum, s) => sum + s.unrealizedPL, 0),
    holdings: rows,
    shorts,
  };
}
