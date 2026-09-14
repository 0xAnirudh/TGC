import mongoose from 'mongoose';
import { ShortPosition } from '../models/ShortPosition.js';
import { User } from '../models/User.js';
import { Market } from '../models/Market.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice, userCash, ECON_RESERVE, ECON_BURNED } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { readGoodMeta } from './goodCache.js';
import { ensureAccountLoaded } from './accounts.js';
import { publishPriceChange } from '../realtime/publish.js';
import { log } from '../log.js';
import { price, buyCost, sellBreakdown, maxTradeQty } from '@tgc/shared';
import { currentLocation, assertNotTravelling } from './location.js';

/**
 * Short selling.
 *
 * Opening a short does three things at once: it sells units the player
 * does not own (so supply falls and the price drops, exactly as a normal
 * sell would), it holds the proceeds rather than paying them out, and it
 * locks collateral.
 *
 * Closing buys the units back at whatever the price is then. The player
 * gets back `proceeds + collateral - cost`. If the price fell, that is
 * more than they locked up. If it rose, it is less.
 *
 * HOW THIS STAYS INSIDE THE MONEY SUPPLY INVARIANT.
 *
 * The awkward part of shorting is that it looks like it creates units
 * from nothing. It does not, and the bookkeeping is what makes that
 * true:
 *
 *   open   supply falls by qty, and the curve pays out `gross` exactly
 *          as it would for any sell. That payout does not go to the
 *          player - it is held as `proceeds` against the position. The
 *          reserve decreases by the same amount it would for a normal
 *          sell, and the spread is burned the same way.
 *
 *   close  supply rises by qty and the player pays `cost` into the
 *          reserve, exactly as a normal buy. The held proceeds and
 *          collateral are then returned to their cash.
 *
 * So a short is a sell followed later by a buy, with the proceeds parked
 * in between. Every Note is accounted for at every moment, and
 * `granted == cash + reserve + burned + heldByShorts` holds throughout.
 */

/** Collateral as a share of the position's value at entry. */
export const COLLATERAL_RATIO = 0.6;

/**
 * How far the price may rise before the position is force-closed.
 *
 * Set below the point where losses would exceed the collateral, so the
 * liquidation happens while there is still enough locked to cover it.
 * Liquidating exactly at the break-even point would be too late - the
 * price moves while the job is running.
 */
export const LIQUIDATION_RATIO = 1.45;

/** Nobody may hold more than this many open shorts at once. */
export const MAX_OPEN_SHORTS = 5;

async function liveState(goodId, region) {
  const redis = getRedis();
  const [supply, basePrice] = await redis.mget(
    goodSupply(goodId, region),
    goodBasePrice(goodId, region),
  );
  if (supply === null || basePrice === null) {
    throw ApiError.notFound('market_not_found', 'No live market for that good');
  }
  return { supply: Number(supply), basePrice: Number(basePrice) };
}

export async function openShort({ userId, goodId, qty }) {
  if (!mongoose.Types.ObjectId.isValid(goodId)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }

  const good = await readGoodMeta(goodId);
  await ensureAccountLoaded(userId);
  await assertNotTravelling(userId);
  const region = await currentLocation(userId);

  const open = await ShortPosition.countDocuments({ userId, status: 'open' });
  if (open >= MAX_OPEN_SHORTS) {
    throw ApiError.badRequest(
      'too_many_shorts',
      `You may hold at most ${MAX_OPEN_SHORTS} open shorts`,
    );
  }

  const { supply, basePrice } = await liveState(goodId, region);

  const cap = maxTradeQty(supply);
  if (qty > cap) {
    throw ApiError.badRequest('trade_too_large', `At most ${cap} units at the current supply`, {
      maxQty: cap,
    });
  }
  // Shorting more than exists would drive supply negative. The curve has
  // no meaning below zero supply.
  if (qty > supply) {
    throw ApiError.badRequest('insufficient_supply', 'Cannot short more units than exist');
  }

  const { gross, spread, net } = sellBreakdown(basePrice, supply, qty, good.k, good.n);
  const entryPrice = price(basePrice, supply, good.k, good.n);
  const collateral = Math.ceil(net * COLLATERAL_RATIO);

  const redis = getRedis();
  const cash = Number(await redis.get(userCash(userId)));
  if (cash < collateral) {
    throw ApiError.badRequest(
      'insufficient_collateral',
      'Not enough Notes to cover the collateral',
      {
        required: collateral,
        available: cash,
      },
    );
  }

  const supplyAfter = supply - qty;

  // Collateral leaves cash and is held by the position. The proceeds are
  // never paid out at all - they sit against the position too. The
  // reserve and burn move exactly as they would for an ordinary sell.
  await redis
    .multi()
    .set(goodSupply(goodId, region), supplyAfter)
    .decrby(userCash(userId), collateral)
    .decrby(ECON_RESERVE, gross)
    .incrby(ECON_BURNED, spread)
    .exec();

  const position = await ShortPosition.create({
    userId,
    goodId,
    region,
    quantity: qty,
    proceeds: net,
    collateral,
    entryPrice: Math.round(entryPrice * 100) / 100,
    liquidationPrice: Math.round(entryPrice * LIQUIDATION_RATIO * 100) / 100,
  });

  await Market.updateOne(
    { goodId, region },
    { $set: { supply: supplyAfter }, $inc: { vol24h: qty } },
  );
  publishPrice(goodId, region, basePrice, supplyAfter, good).catch(() => {});

  return {
    position: position.toPublic(),
    cash: cash - collateral,
    supply: supplyAfter,
  };
}

export async function closeShort({ userId, positionId, liquidating = false }) {
  const position = await ShortPosition.findOne({ _id: positionId, status: 'open' });
  if (!position) throw ApiError.notFound('position_not_found', 'No open position with that id');
  if (!liquidating && position.userId.toString() !== userId) {
    throw ApiError.forbidden('not_your_position', 'That position is not yours');
  }

  const goodId = position.goodId.toString();
  // Closed in the market it was opened in, whatever the player has done
  // since. A short is a promise to return units to a specific place.
  const region = position.region;
  const good = await readGoodMeta(goodId);
  const { supply, basePrice } = await liveState(goodId, region);

  const cost = buyCost(basePrice, supply, position.quantity, good.k, good.n);
  const supplyAfter = supply + position.quantity;

  // What comes back: everything held against the position, minus what it
  // cost to buy the units back. Floored at zero - the collateral is the
  // most that can be lost, which is the whole reason it was taken.
  const returned = Math.max(0, position.proceeds + position.collateral - cost);
  const realizedPL = returned - position.collateral;

  // Any shortfall - the part of `cost` the held Notes could not cover -
  // has still been paid into the reserve by the buy. It comes out of the
  // burn, because those Notes were destroyed by the spread on the way in
  // and this is the economy absorbing the difference rather than minting.
  const shortfall = Math.max(0, cost - (position.proceeds + position.collateral));

  const redis = getRedis();
  const tx = redis
    .multi()
    .set(goodSupply(goodId, region), supplyAfter)
    .incrby(userCash(position.userId.toString()), returned)
    .incrby(ECON_RESERVE, cost);
  if (shortfall > 0) tx.decrby(ECON_BURNED, shortfall);
  await tx.exec();

  position.status = liquidating ? 'liquidated' : 'closed';
  position.realizedPL = realizedPL;
  position.closedAt = new Date();
  await position.save();

  await Market.updateOne(
    { goodId, region },
    { $set: { supply: supplyAfter }, $inc: { vol24h: position.quantity } },
  );
  await User.updateOne({ _id: position.userId }, { $inc: { tradeCount: 1 } });
  publishPrice(goodId, region, basePrice, supplyAfter, good).catch(() => {});

  return {
    position: position.toPublic(),
    cost,
    returned,
    realizedPL,
    supply: supplyAfter,
  };
}

/**
 * Force-close every position whose price has risen past its liquidation
 * point.
 *
 * This is what makes the collateral meaningful. Without it, a losing
 * short could sit open indefinitely while the loss grew past what was
 * locked, and the difference would have to come from somewhere.
 */
export async function liquidateUnderwater() {
  const open = await ShortPosition.find({ status: 'open' }).lean();
  if (open.length === 0) return { checked: 0, liquidated: 0 };

  const redis = getRedis();
  let liquidated = 0;

  for (const position of open) {
    const goodId = position.goodId.toString();
    const [supplyRaw, baseRaw] = await redis.mget(
      goodSupply(goodId, position.region),
      goodBasePrice(goodId, position.region),
    );
    if (supplyRaw === null || baseRaw === null) continue;

    const good = await readGoodMeta(goodId);
    const current = price(Number(baseRaw), Number(supplyRaw), good.k, good.n);
    if (current < position.liquidationPrice) continue;

    try {
      await closeShort({
        userId: position.userId.toString(),
        positionId: position._id.toString(),
        liquidating: true,
      });
      liquidated += 1;
      log.info('short liquidated', {
        user: position.userId.toString(),
        good: good.name,
        at: Math.round(current * 100) / 100,
        trigger: position.liquidationPrice,
      });
    } catch (err) {
      log.error('liquidation failed', { position: position._id.toString(), err: err.message });
    }
  }

  return { checked: open.length, liquidated };
}

/** Open positions with their current profit or loss. */
export async function openShorts(userId) {
  const positions = await ShortPosition.find({ userId, status: 'open' }).lean();
  if (positions.length === 0) return [];

  const redis = getRedis();
  const rows = [];

  for (const p of positions) {
    const goodId = p.goodId.toString();
    const good = await readGoodMeta(goodId);
    const [supplyRaw, baseRaw] = await redis.mget(
      goodSupply(goodId, p.region),
      goodBasePrice(goodId, p.region),
    );
    if (supplyRaw === null) continue;

    const supply = Number(supplyRaw);
    const basePrice = Number(baseRaw);
    const cost = buyCost(basePrice, supply, p.quantity, good.k, good.n);
    const current = price(basePrice, supply, good.k, good.n);

    rows.push({
      id: p._id.toString(),
      goodId,
      name: good.name,
      colorToken: good.colorToken,
      region: p.region,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      currentPrice: Math.round(current * 100) / 100,
      liquidationPrice: p.liquidationPrice,
      collateral: p.collateral,
      proceeds: p.proceeds,
      costToClose: cost,
      unrealizedPL: Math.max(0, p.proceeds + p.collateral - cost) - p.collateral,
      openedAt: p.createdAt,
    });
  }
  return rows;
}

/** Notes held against open shorts. A term in the money supply invariant. */
export async function heldByShorts() {
  const open = await ShortPosition.find({ status: 'open' }).lean();
  return open.reduce((sum, p) => sum + p.proceeds + p.collateral, 0);
}

function publishPrice(goodId, region, basePrice, supply, good) {
  return publishPriceChange({
    goodId,
    region,
    price: Math.round(price(basePrice, supply, good.k, good.n) * 100) / 100,
    supply,
    side: 'short',
    quantity: 0,
  });
}
