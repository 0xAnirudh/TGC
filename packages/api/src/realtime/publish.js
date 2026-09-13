import { getRedis } from '../redis/client.js';

/**
 * Price changes are announced on a Redis pub/sub channel rather than
 * emitted straight to sockets.
 *
 * The API is horizontally scaled (NFR-7). A trade executed on instance A
 * has to reach a client whose socket is held by instance B, and instance
 * A has no way to reach that socket directly. Publishing to Redis means
 * every instance hears about every trade and can serve its own
 * connections.
 */
export const CHANNEL_PRICES = 'ch:prices';

export async function publishPriceChange({ goodId, price, supply, side, quantity }) {
  await getRedis().publish(
    CHANNEL_PRICES,
    JSON.stringify({ goodId, price, supply, side, quantity, at: Date.now() }),
  );
}
