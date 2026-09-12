import { Good } from '../../packages/api/src/models/Good.js';
import { Market } from '../../packages/api/src/models/Market.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { goodSupply, goodBasePrice } from '../../packages/api/src/redis/keys.js';

/** Create a good with a live market, in both stores. */
export async function makeGood({
  name = 'Copper',
  colorToken = 'orange',
  basePrice = 120,
  k = 12_000,
  n = 2,
  supply = 0,
} = {}) {
  const good = await Good.create({ name, nameLower: name.toLowerCase(), colorToken, k, n });
  await Market.create({ goodId: good._id, basePrice, supply });

  const id = good._id.toString();
  await getRedis().mset(goodSupply(id), supply, goodBasePrice(id), basePrice);

  return { good, id, basePrice, k, n, supply };
}

export async function setSupply(goodId, supply) {
  await getRedis().set(goodSupply(goodId), supply);
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
  });

  const id = user._id.toString();
  await getRedis()
    .multi()
    .set(userCash(id), STARTING_GRANT)
    .incrby(ECON_GRANTED, STARTING_GRANT)
    .exec();

  return { token: issueToken(user), id };
}
