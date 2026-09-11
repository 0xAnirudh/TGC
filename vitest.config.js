import 'dotenv/config';
import { defineConfig } from 'vitest/config';

/**
 * Point the test run at isolated stores.
 *
 * Integration tests drop collections and flush keys, so they must never
 * be able to reach the development data. Two separate guards:
 *
 *   - a different Mongo database name (tgc_test, never tgc)
 *   - a different Redis logical database (15, never 0)
 *
 * Both are forced here rather than read from .env, so a developer whose
 * .env points at production cannot accidentally run the suite against
 * it. The connection *targets* come from .env because there is no local
 * Mongo - only the database name is overridden.
 */
const TEST_REDIS_DB = 15;

function testRedisUrl(url = 'redis://localhost:6379') {
  const parsed = new URL(url);
  parsed.pathname = `/${TEST_REDIS_DB}`;
  return parsed.toString();
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // Integration tests share one Mongo database and one Redis database,
    // so files must not run concurrently against each other.
    fileParallelism: false,
    // Integration tests talk to Atlas over the network, so a test that
    // places a few dozen trades spends most of its time in flight rather
    // than computing. 60s is generous for a local suite and still catches
    // a genuine hang.
    testTimeout: 60_000,
    hookTimeout: 30_000,

    env: {
      NODE_ENV: 'test',
      MONGO_URI: process.env.MONGO_URI ?? 'mongodb://localhost:27017',
      MONGO_DB_NAME: 'tgc_test',
      REDIS_URL: testRedisUrl(process.env.REDIS_URL),
      JWT_SECRET: 'test-only-secret-not-used-in-any-real-deployment',
      JWT_TTL: '7d',
      LOG_LEVEL: 'error',

      // bcrypt is deliberately slow. At the production factor of 12 a
      // suite that registers a few dozen accounts spends most of its
      // runtime waiting on a function whose whole purpose is to be
      // expensive. 4 exercises the identical code path for a fraction of
      // the cost; production refuses anything under 10.
      BCRYPT_ROUNDS: '4',
    },
  },
});
