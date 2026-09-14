import { User } from '../models/User.js';
import { getRedis } from '../redis/client.js';
import { userLocation, userArrivesAt, userHoldings, userCash } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { log } from '../log.js';
import {
  REGIONS,
  isRegion,
  regionById,
  travelCost,
  travelSeconds,
  DEFAULT_REGION,
} from '@tgc/shared';

/**
 * Where a player is, and getting them somewhere else.
 *
 * Location lives in Redis because every trade needs it to know which
 * region's prices apply, and a Mongo read per trade is the thing the
 * whole hot path is built to avoid. Mongo keeps the durable copy.
 */

export async function currentLocation(userId) {
  const redis = getRedis();
  const cached = await redis.get(userLocation(userId));
  if (cached && isRegion(cached)) return cached;

  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');

  const location = isRegion(user.location) ? user.location : DEFAULT_REGION;
  await redis.set(userLocation(userId), location);
  return location;
}

/**
 * Refuse to act while in transit.
 *
 * Trading from a moving caravan would make travel free - you could take
 * the cheap prices with you. The wait is what makes a price gap a risk
 * rather than a certainty: it can close while you are on the road.
 */
export async function assertNotTravelling(userId) {
  const raw = await getRedis().get(userArrivesAt(userId));
  if (!raw) return;

  const arrivesAt = Number(raw);
  if (Date.now() < arrivesAt) {
    throw ApiError.badRequest('in_transit', 'You are on the road', {
      arrivesAt: new Date(arrivesAt).toISOString(),
      secondsRemaining: Math.ceil((arrivesAt - Date.now()) / 1000),
    });
  }
  // Arrived. Clear it so the check is cheap next time.
  await getRedis().del(userArrivesAt(userId));
}

export async function travelTo({ userId, to }) {
  if (!isRegion(to)) throw ApiError.badRequest('unknown_region', 'No such place');

  await assertNotTravelling(userId);
  const from = await currentLocation(userId);
  if (from === to) throw ApiError.badRequest('already_here', 'You are already there');

  const cost = travelCost(from, to);
  const seconds = travelSeconds(from, to);

  const redis = getRedis();
  const cash = Number(await redis.get(userCash(userId)));
  if (cash < cost) {
    throw ApiError.badRequest('cannot_afford_travel', 'Not enough Notes for the journey', {
      required: cost,
      available: cash,
    });
  }

  const arrivesAt = Date.now() + seconds * 1_000;

  // The fare is burned rather than paid to anyone. Travel is a cost of
  // doing business, and a fare collected into some account would be a
  // pot that has to be managed. Burning keeps it a clean sink and keeps
  // the money supply invariant simple.
  await redis
    .multi()
    .decrby(userCash(userId), cost)
    .incrby('econ:burned', cost)
    .set(userLocation(userId), to)
    .set(userArrivesAt(userId), arrivesAt, 'PX', seconds * 1_000 + 5_000)
    .exec();

  await User.updateOne(
    { _id: userId },
    { $set: { location: to, arrivesAt: new Date(arrivesAt) }, $inc: { cash: -cost } },
  );

  log.info('travel', { userId, from, to, cost, seconds });

  return {
    from,
    to,
    cost,
    seconds,
    arrivesAt: new Date(arrivesAt).toISOString(),
    cash: cash - cost,
  };
}

/** How full the hold is. Cargo is carried, so it is not per-region. */
export async function cargoUsed(userId) {
  const hash = await getRedis().hgetall(userHoldings(userId));
  return Object.values(hash).reduce((sum, q) => sum + Math.max(0, Number(q)), 0);
}

export async function cargoState(userId) {
  const user = await User.findById(userId).lean();
  const used = await cargoUsed(userId);
  return {
    used,
    capacity: user?.cargoCapacity ?? 0,
    free: Math.max(0, (user?.cargoCapacity ?? 0) - used),
  };
}

/** The four markets, with what it costs to reach each from here. */
export async function regionsFor(userId) {
  const here = userId ? await currentLocation(userId) : DEFAULT_REGION;
  return REGIONS.map((r) => ({
    id: r.id,
    name: r.name,
    blurb: r.blurb,
    here: r.id === here,
    travelCost: travelCost(here, r.id),
    travelSeconds: travelSeconds(here, r.id),
  }));
}

export { regionById };
