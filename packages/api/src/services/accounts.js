import { User } from '../models/User.js';
import { Holding } from '../models/Holding.js';
import { getRedis } from '../redis/client.js';
import { userCash, userHoldings } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { log } from '../log.js';

/**
 * Make sure a player's cash and holdings exist in Redis.
 *
 * Redis is the live truth for both from Phase 5, but a player who
 * registered before a Redis flush - or during a Redis outage - will have
 * their state only in Mongo. Rather than warming every account at boot,
 * which does not scale past a few thousand players, accounts are loaded
 * the first time they try to trade.
 *
 * The cash key doubles as the "is this account loaded" marker. Its SET
 * uses NX so two concurrent first-trades cannot overwrite each other,
 * and the holdings write is idempotent because both requests copy the
 * same rows out of Mongo.
 */
export async function ensureAccountLoaded(userId) {
  const redis = getRedis();
  if (await redis.exists(userCash(userId))) return;

  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');

  const holdings = await Holding.find({ userId, quantity: { $gt: 0 } }).lean();

  const tx = redis.multi().set(userCash(userId), user.cash, 'NX');
  if (holdings.length > 0) {
    tx.hset(userHoldings(userId), ...holdings.flatMap((h) => [h.goodId.toString(), h.quantity]));
  }
  await tx.exec();

  log.info('account loaded into redis', { userId, holdings: holdings.length });
}

/** Live cash, straight from Redis. */
export async function readCash(userId) {
  const value = await getRedis().get(userCash(userId));
  return value === null ? null : Number(value);
}

/** Live holdings as a Map of goodId -> quantity. */
export async function readHoldings(userId) {
  const hash = await getRedis().hgetall(userHoldings(userId));
  const out = new Map();
  for (const [goodId, qty] of Object.entries(hash)) {
    const n = Number(qty);
    if (n > 0) out.set(goodId, n);
  }
  return out;
}
