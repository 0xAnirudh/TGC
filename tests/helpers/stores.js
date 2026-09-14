import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../../packages/api/src/db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/api/src/redis/client.js';
import { config } from '../../packages/api/src/config.js';

/**
 * Test store lifecycle.
 *
 * `reset` destroys data, so before it is allowed to run anything the
 * targets are checked to be the test ones. vitest.config.js already
 * forces both, but a guard that costs one comparison is worth having in
 * front of an operation that cannot be undone - a misconfiguration that
 * silently wipes the development database would be discovered far too
 * late.
 */

const EXPECTED_DB = 'tgc_test';
const EXPECTED_REDIS_DB = 15;

function assertSafeTargets() {
  if (config.MONGO_DB_NAME !== EXPECTED_DB) {
    throw new Error(
      `refusing to reset: MONGO_DB_NAME is "${config.MONGO_DB_NAME}", expected "${EXPECTED_DB}"`,
    );
  }
  const redisDb = Number(new URL(config.REDIS_URL).pathname.slice(1) || 0);
  if (redisDb !== EXPECTED_REDIS_DB) {
    throw new Error(
      `refusing to reset: REDIS_URL points at logical database ${redisDb}, expected ${EXPECTED_REDIS_DB}`,
    );
  }
}

export async function setupStores() {
  assertSafeTargets();
  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);

  // Mongoose creates the indexes a schema declares and never drops the
  // ones it used to. Market.goodId was unique when there was one market
  // per good; it is unique per good PER REGION now, and the stale index
  // sits in the test database refusing the second region with a
  // duplicate-key error naming a constraint that is no longer in the
  // code. The dev database has the same problem - see the seed script.
  try {
    await mongoose.connection.db.collection('markets').dropIndex('goodId_1');
  } catch {
    // Already gone, which is the normal case after the first run.
  }
}

export async function resetStores() {
  assertSafeTargets();
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await getRedis().flushdb();
}

export async function teardownStores() {
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}

/**
 * Wait until the ledger has caught up with the trades just placed.
 *
 * The ledger write is deliberately not awaited by the request - see the
 * comment on recordTrade for why - so a test that places trades and then
 * reads Mongo is racing a write that has not landed yet. Production does
 * not care, because nothing reads those rows on the request path. Tests
 * that assert on them do.
 *
 * Polls rather than sleeping a fixed amount, so it is as fast as the
 * write actually is.
 */
export async function settleLedger(expected, timeoutMs = 10_000) {
  const { Trade } = await import('../../packages/api/src/models/Trade.js');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await Trade.countDocuments()) >= expected) {
      // One more tick, so the sibling writes in the same Promise.all
      // (holdings, market, cash) have landed too.
      await new Promise((r) => setTimeout(r, 60));
      return true;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}
