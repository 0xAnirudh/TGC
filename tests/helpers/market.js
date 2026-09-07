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
