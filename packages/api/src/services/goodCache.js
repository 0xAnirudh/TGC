import { Good } from '../models/Good.js';
import { getRedis } from '../redis/client.js';
import { goodMeta } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';

/**
 * The immutable half of a good, cached in Redis.
 *
 * `k`, `n`, `name`, `colorToken` and `issuerId` are set when a good is
 * created and never change. Keeping them in Redis takes Mongo off both
 * hot paths - quoting and trading - and there is no invalidation to get
 * wrong because there is nothing that invalidates.
 *
 * A miss falls back to Mongo and populates the cache, so this
 * self-heals after a flush without anything having to remember to warm
 * it.
 */
export async function cacheGoodMeta(good) {
  await getRedis().hset(goodMeta(good._id.toString()), {
    name: good.name,
    colorToken: good.colorToken,
    k: String(good.k),
    n: String(good.n),
    issuerId: good.issuerId ? good.issuerId.toString() : '',
  });
}

export async function readGoodMeta(goodId) {
  const cached = await getRedis().hgetall(goodMeta(goodId));

  if (cached && cached.k) {
    return {
      id: goodId,
      name: cached.name,
      colorToken: cached.colorToken,
      k: Number(cached.k),
      n: Number(cached.n),
      issuerId: cached.issuerId || null,
    };
  }

  const good = await Good.findById(goodId);
  if (!good) throw ApiError.notFound('good_not_found', 'No good with that id');

  await cacheGoodMeta(good);
  return {
    id: goodId,
    name: good.name,
    colorToken: good.colorToken,
    k: good.k,
    n: good.n,
    issuerId: good.issuerId ? good.issuerId.toString() : null,
  };
}
