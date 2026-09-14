import { Good } from '../../packages/api/src/models/Good.js';
import { Market } from '../../packages/api/src/models/Market.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { goodSupply, goodBasePrice } from '../../packages/api/src/redis/keys.js';
import { cacheGoodMeta } from '../../packages/api/src/services/goodCache.js';
import { REGIONS, DEFAULT_REGION } from '@tgc/shared';

/**
 * Create a good with a live market in every region.
 *
 * `supply` and `basePrice` apply to the region under test (the default
 * one unless told otherwise); the other three get the same numbers, so a
 * test that never mentions regions behaves as though there were only
 * one. Tests about arbitrage set the others explicitly.
 */
export async function makeGood({
  name = 'Copper',
  colorToken = 'orange',
  basePrice = 120,
  k = 12_000,
  n = 2,
  supply = 0,
  region = DEFAULT_REGION,
} = {}) {
  const good = await Good.create({ name, nameLower: name.toLowerCase(), colorToken, k, n });
  const id = good._id.toString();
  const redis = getRedis();

  for (const r of REGIONS) {
    await Market.create({
      goodId: good._id,
      region: r.id,
      basePrice,
      launchPrice: basePrice,
      // Whatever a test seeds a market with IS its opening stock - no
      // trade created it, so the rebuild has to start from it.
      openingStock: supply,
      supply,
    });
    await redis.mset(goodSupply(id, r.id), supply, goodBasePrice(id, r.id), basePrice);
  }

  await cacheGoodMeta(good);
  return { good, id, basePrice, k, n, supply, region };
}

/** Set supply in one region, or in every region when none is named. */
export async function setSupply(goodId, supply, region = null) {
  const redis = getRedis();
  if (region) {
    await redis.set(goodSupply(goodId, region), supply);
    return;
  }
  for (const r of REGIONS) await redis.set(goodSupply(goodId, r.id), supply);
}

/** Set a region's base price, for tests about price gaps between markets. */
export async function setBasePrice(goodId, basePrice, region = DEFAULT_REGION) {
  await getRedis().set(goodBasePrice(goodId, region), basePrice);
}

/** Move a player without waiting out the journey. */
export async function placeAt(userId, region) {
  const { userLocation, userArrivesAt } = await import('../../packages/api/src/redis/keys.js');
  const { User } = await import('../../packages/api/src/models/User.js');
  await getRedis().set(userLocation(userId), region);
  await getRedis().del(userArrivesAt(userId));
  await User.updateOne({ _id: userId }, { $set: { location: region, arrivesAt: null } });
}

/**
 * Create a player without going through POST /auth/register.
 *
 * Registration is rate limited per IP (ten attempts), and a test that
 * needs sixty concurrent traders is not testing registration - it would
 * just be throttled by a limiter working exactly as intended. This
 * builds the account and token directly.
 */
export async function makePlayerDirect(username) {
  const { User } = await import('../../packages/api/src/models/User.js');
  const { issueToken } = await import('../../packages/api/src/services/auth.js');
  const { getRedis } = await import('../../packages/api/src/redis/client.js');
  const { userCash, ECON_GRANTED } = await import('../../packages/api/src/redis/keys.js');
  const { STARTING_GRANT } = await import('@tgc/shared');

  const user = await User.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: 'not-a-real-hash-this-account-cannot-log-in',
    cash: STARTING_GRANT,
    startingGrant: STARTING_GRANT,
    // Generous, so a test about trading is never silently a test about
    // the cargo limit. Tests that mean to exercise the hold set it.
    cargoCapacity: 1_000_000,
  });

  const id = user._id.toString();
  await getRedis()
    .multi()
    .set(userCash(id), STARTING_GRANT)
    .incrby(ECON_GRANTED, STARTING_GRANT)
    .exec();

  return { token: issueToken(user), id };
}
