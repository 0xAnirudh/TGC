import Redis from 'ioredis';
import { config } from '../config.js';
import { log } from '../log.js';
import { backoffDelay } from '../util/backoff.js';

/**
 * Redis client.
 *
 * Redis is the hot path, not a cache. It holds live supply, live base
 * prices, user cash, the trade ledger head, the leaderboard and the rate
 * limit buckets. Nothing here is reconstructable from Mongo *cheaply* -
 * the rebuild path exists (Phase 6) but it replays the whole ledger, so
 * it is a recovery tool, not a fallback the request path can lean on.
 *
 * Consequence: unlike Mongo, a Redis outage is an outage. The client
 * reconnects forever and requests fail loudly while it is down, rather
 * than silently serving stale or partial market state.
 */

let client = null;

export function getRedis() {
  if (client) return client;

  client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    retryStrategy: (attempt) => backoffDelay(attempt - 1, { base: 200, max: 10_000 }),
    reconnectOnError: (err) => {
      // A failover promotes a replica, and the old primary starts
      // answering READONLY. Reconnecting picks up the new primary;
      // anything else is a real error and should surface.
      if (err.message.includes('READONLY')) return 2;
      return false;
    },
  });

  client.on('connect', () => log.info('redis connected'));
  client.on('error', (err) => log.warn('redis error', { err: err.message }));
  client.on('reconnecting', (delay) => log.warn('redis reconnecting', { delayMs: delay }));

  return client;
}

export async function connectRedis() {
  const redis = getRedis();
  if (redis.status === 'ready') return redis;
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  return redis;
}

export async function redisStatus() {
  const redis = getRedis();
  if (redis.status !== 'ready') return { connected: false, state: redis.status };
  try {
    const started = process.hrtime.bigint();
    await redis.ping();
    const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { connected: true, state: 'ready', rttMs: Number(rttMs.toFixed(2)) };
  } catch (err) {
    return { connected: false, state: redis.status, error: err.message };
  }
}

export async function disconnectRedis() {
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
  client = null;
  log.info('redis disconnected');
}
