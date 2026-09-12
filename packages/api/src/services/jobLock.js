import { randomUUID } from 'node:crypto';
import { getRedis } from '../redis/client.js';
import { log } from '../log.js';

/**
 * Run a function only if this process wins the lock for it.
 *
 * NFR-8: scheduled jobs run exactly once per tick across all instances.
 * Without this, every deployed instance would apply its own drift tick
 * and prices would move N times per tick for N machines.
 */
export async function withJobLock(name, ttlMs, fn) {
  const key = `lock:job:${name}`;
  const token = randomUUID();
  const redis = getRedis();

  const acquired = await redis.joblock(key, token, ttlMs);
  if (acquired !== 1) {
    log.debug('job lock held elsewhere, skipping', { job: name });
    return { ran: false };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await redis.jobunlock(key, token);
  }
}
