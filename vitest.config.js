import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],

    /**
     * Environment for the test process.
     *
     * config.js validates the environment at import time and exits if it
     * is wrong, which is the behaviour we want from a real process and
     * exactly the wrong behaviour inside a test runner. Supplying a valid
     * environment here means importing any API module in a test is safe.
     *
     * These point at the local docker-compose stores and a throwaway
     * database name. Integration tests from Phase 2 onwards drop and
     * recreate MONGO_DB_NAME, so it must never be the dev database.
     */
    env: {
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://localhost:27017',
      MONGO_DB_NAME: 'tgc_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-only-secret-not-used-in-any-real-deployment',
      LOG_LEVEL: 'error',
    },
  },
});
