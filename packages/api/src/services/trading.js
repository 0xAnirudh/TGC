import mongoose from 'mongoose';
import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { User } from '../models/User.js';
import { Holding } from '../models/Holding.js';
import { Trade } from '../models/Trade.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice, ECON_RESERVE, ECON_BURNED } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { buyCost, sellBreakdown, price, maxTradeQty } from '@tgc/shared';

/**
 * Trade execution - SEQUENTIAL VERSION.
 *
 * ============================================================
 *  THIS CODE HAS A KNOWN RACE CONDITION. IT IS LEFT IN ON
 *  PURPOSE AND IS FIXED IN PHASE 5. SEE ADR-013.
 * ============================================================
 *
 * Read the order of operations in `executeTrade` below. Between reading
 * supply and writing it back there is a gap, and in that gap another
 * request can read the same supply and act on it. Two simultaneous buys
 * of 100 units each on a good at supply 1000 can both read 1000, both
 * compute a price for 1000, and both write 1100 - so 200 units were sold
 * but supply only moved by 100, and the missing 100 were created from
 * nothing.
 *
 * The same gap exists on the cash check. Two concurrent buys can both
 * read a balance of 500, both decide 400 is affordable, and both spend
 * it. The account ends at -300.
 *
 * Why write it this way at all: the fix is a Redis Lua script, and a Lua
 * script is much harder to read than this. Writing the obvious version
 * first means Phase 5 is a targeted repair to a problem that has been
 * named, measured and documented, rather than complexity introduced up
 * front on the assurance that it is necessary.
 */

/** Read live supply and basePrice. Same source the quote endpoint uses. */
async function readLiveState(goodId) {
  const redis = getRedis();
  const [supply, basePrice] = await redis.mget(goodSupply(goodId), goodBasePrice(goodId));
  if (supply === null || basePrice === null) {
    throw ApiError.notFound('market_not_found', 'No live market for that good');
  }
  return { supply: Number(supply), basePrice: Number(basePrice) };
}

export async function executeTrade({ userId, goodId, side, qty }) {
  if (!mongoose.Types.ObjectId.isValid(goodId)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }

  const good = await Good.findById(goodId);
  if (!good) throw ApiError.notFound('good_not_found', 'No good with that id');

  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');

  // ---- READ ------------------------------------------------------
  const { supply, basePrice } = await readLiveState(goodId);

  const cap = maxTradeQty(supply);
  if (qty > cap) {
    throw ApiError.badRequest(
      'trade_too_large',
      `A single trade may move at most ${cap} units at the current supply`,
      { maxQty: cap },
    );
  }

  const result =
    side === 'buy'
      ? await executeBuy({ user, good, supply, basePrice, qty })
      : await executeSell({ user, good, supply, basePrice, qty });

  return result;
}

async function executeBuy({ user, good, supply, basePrice, qty }) {
  const cost = buyCost(basePrice, supply, qty, good.k, good.n);

  // ---- CHECK -----------------------------------------------------
  // Another request can spend this balance between here and the write
  // below. That is the race.
  if (cost > user.cash) {
    throw ApiError.badRequest('insufficient_funds', 'Not enough Notes for that trade', {
      required: cost,
      available: user.cash,
    });
  }

  const supplyAfter = supply + qty;
  const redis = getRedis();

  // ---- WRITE -----------------------------------------------------
  // Notes move from the player into the curve reserve. Nothing is
  // created or destroyed, which is what keeps NFR-5 true.
  await redis
    .multi()
    .set(goodSupply(good._id.toString()), supplyAfter)
    .incrby(ECON_RESERVE, cost)
    .exec();

  user.cash -= cost;
  user.tradeCount += 1;
  await user.save();

  await upsertHolding({ userId: user._id, goodId: good._id, qty, cost });
  await Market.updateOne(
    { goodId: good._id },
    { $set: { supply: supplyAfter }, $inc: { vol24h: qty } },
  );

  const trade = await Trade.create({
    userId: user._id,
    goodId: good._id,
    side: 'buy',
    quantity: qty,
    supplyBefore: supply,
    supplyAfter,
    basePrice,
    notional: cost,
    spread: 0,
    avgPrice: cost / qty,
  });

  return {
    trade,
    cash: user.cash,
    supply: supplyAfter,
    priceAfter: priceAt(good, basePrice, supplyAfter),
  };
}

async function executeSell({ user, good, supply, basePrice, qty }) {
  const holding = await Holding.findOne({ userId: user._id, goodId: good._id });

  if (!holding || holding.quantity < qty) {
    throw ApiError.badRequest('insufficient_holdings', 'You do not hold that many units', {
      required: qty,
      available: holding ? holding.quantity : 0,
    });
  }
  if (qty > supply) {
    throw ApiError.badRequest('insufficient_supply', 'Cannot sell more units than exist');
  }

  const { gross, spread, net } = sellBreakdown(basePrice, supply, qty, good.k, good.n);
  const supplyAfter = supply - qty;
  const redis = getRedis();

  // The curve pays out of the reserve; the spread is skimmed off that
  // payout and burned. gross === net + spread, so the reserve falls by
  // exactly what left it.
  await redis
    .multi()
    .set(goodSupply(good._id.toString()), supplyAfter)
    .decrby(ECON_RESERVE, gross)
    .incrby(ECON_BURNED, spread)
    .exec();

  user.cash += net;
  user.tradeCount += 1;
  await user.save();

  holding.quantity -= qty;
  // avgCost is deliberately untouched. Selling part of a position does
  // not change what the remaining part cost.
  if (holding.quantity === 0) holding.avgCost = 0;
  await holding.save();

  await Market.updateOne(
    { goodId: good._id },
    { $set: { supply: supplyAfter }, $inc: { vol24h: qty } },
  );

  const trade = await Trade.create({
    userId: user._id,
    goodId: good._id,
    side: 'sell',
    quantity: qty,
    supplyBefore: supply,
    supplyAfter,
    basePrice,
    notional: net,
    spread,
    avgPrice: net / qty,
  });

  return {
    trade,
    cash: user.cash,
    supply: supplyAfter,
    priceAfter: priceAt(good, basePrice, supplyAfter),
  };
}

/**
 * Add to a position, moving the weighted average cost.
 *
 * Buying 100 at 10 then 100 at 20 leaves 200 units at an average of 15.
 * The upsert is atomic against a concurrent insert of the same pair
 * thanks to the compound unique index, though the read-modify-write of
 * avgCost is not - another Phase 5 concern.
 */
async function upsertHolding({ userId, goodId, qty, cost }) {
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

const priceAt = (good, basePrice, supply) =>
  Math.round(price(basePrice, supply, good.k, good.n) * 100) / 100;

/**
 * A player's full position: cash, every holding valued at what it would
 * actually fetch right now, and the resulting net worth.
 */
export async function getPortfolio(userId) {
  const holdings = await Holding.find({ userId, quantity: { $gt: 0 } }).lean();
  const user = await User.findById(userId);

  const goods = await Good.find({ _id: { $in: holdings.map((h) => h.goodId) } }).lean();
  const goodsById = new Map(goods.map((g) => [g._id.toString(), g]));

  const redis = getRedis();
  const keys = holdings.flatMap((h) => [
    goodSupply(h.goodId.toString()),
    goodBasePrice(h.goodId.toString()),
  ]);
  const live = keys.length > 0 ? await redis.mget(...keys) : [];

  let holdingsValue = 0;
  const rows = holdings.map((h, i) => {
    const good = goodsById.get(h.goodId.toString());
    const supply = Number(live[i * 2]);
    const basePrice = Number(live[i * 2 + 1]);

    // Value the position at what selling it would actually return -
    // spread included, curve movement included. Marking it at spot price
    // times quantity would overstate every portfolio in the game.
    const sellable = Math.min(h.quantity, supply);
    const value = sellable > 0 ? sellBreakdown(basePrice, supply, sellable, good.k, good.n).net : 0;
    holdingsValue += value;

    const costBasis = Math.round(h.avgCost * h.quantity);
    return {
      goodId: h.goodId.toString(),
      name: good.name,
      colorToken: good.colorToken,
      quantity: h.quantity,
      avgCost: Math.round(h.avgCost * 100) / 100,
      currentPrice: Math.round(price(basePrice, supply, good.k, good.n) * 100) / 100,
      value,
      costBasis,
      unrealizedPL: value - costBasis,
    };
  });

  return {
    cash: user.cash,
    holdingsValue,
    netWorth: user.cash + holdingsValue,
    unrealizedPL: rows.reduce((sum, r) => sum + r.unrealizedPL, 0),
    holdings: rows,
  };
}
