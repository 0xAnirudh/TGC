import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';

import { TRADE_LIMIT, AUTH_LIMIT } from '../../packages/api/src/middleware/rateLimit.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

describe('the token bucket', () => {
  it('allows a burst up to capacity, then refuses', async () => {
    const redis = getRedis();
    const results = [];
    for (let i = 0; i < TRADE_LIMIT.capacity + 3; i += 1) {
      const [allowed] = await redis.ratelimit(
        'rl:test:burst',
        TRADE_LIMIT.capacity,
        TRADE_LIMIT.refillPerSec,
        1,
      );
      results.push(allowed);
    }

    expect(results.filter((r) => r === 1)).toHaveLength(TRADE_LIMIT.capacity);
    expect(results.slice(TRADE_LIMIT.capacity)).toEqual([0, 0, 0]);
  });

  it('refills over time and restores capacity', async () => {
    const redis = getRedis();
    // Two tokens, refilling at ten a second: spend both, wait, get them back.
    for (let i = 0; i < 2; i += 1) await redis.ratelimit('rl:test:refill', 2, 10, 1);

    const [blocked] = await redis.ratelimit('rl:test:refill', 2, 10, 1);
    expect(blocked).toBe(0);

    await new Promise((r) => setTimeout(r, 350));
    const [afterWait] = await redis.ratelimit('rl:test:refill', 2, 10, 1);
    expect(afterWait).toBe(1);
  });

  it('never refills beyond capacity however long it idles', async () => {
    const redis = getRedis();
    await redis.ratelimit('rl:test:cap', 3, 1_000, 1);
    await new Promise((r) => setTimeout(r, 120));

    // A thousand tokens a second for 120ms is 120 tokens' worth of
    // refill against a bucket that holds 3.
    //
    // The obvious way to check this - spend tokens until refused and
    // count them - does not work at this refill rate, because the bucket
    // refills measurably *during* the loop doing the counting. Read the
    // remaining count instead: it is the cap itself, not a consequence
    // of it.
    const [allowed, remaining] = await redis.ratelimit('rl:test:cap', 3, 1_000, 1);
    expect(allowed).toBe(1);
    expect(Number(remaining)).toBeLessThanOrEqual(2);
  });

  it('reports how long to wait, never rounding down to zero', async () => {
    const redis = getRedis();
    await redis.ratelimit('rl:test:retry', 1, 1, 1);
    const [allowed, , retryAfterMs] = await redis.ratelimit('rl:test:retry', 1, 1, 1);

    expect(allowed).toBe(0);
    expect(Number(retryAfterMs)).toBeGreaterThan(0);
  });

  it('keeps separate callers in separate buckets', async () => {
    const redis = getRedis();
    for (let i = 0; i < 3; i += 1) await redis.ratelimit('rl:test:a', 3, 1, 1);

    const [aBlocked] = await redis.ratelimit('rl:test:a', 3, 1, 1);
    const [bAllowed] = await redis.ratelimit('rl:test:b', 3, 1, 1);
    expect(aBlocked).toBe(0);
    expect(bAllowed).toBe(1);
  });

  it('is atomic under concurrent consumption', async () => {
    // The reason this is a Lua script. Read-then-write in JavaScript
    // would let several of these each see the last token and spend it.
    const redis = getRedis();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => redis.ratelimit('rl:test:race', 5, 0.001, 1)),
    );
    expect(results.filter(([a]) => a === 1)).toHaveLength(5);
  });
});

describe('the haul buy rate limit', () => {
  async function player(username) {
    const { User } = await import('../../packages/api/src/models/User.js');
    const { issueToken } = await import('../../packages/api/src/services/auth.js');
    const user = await User.create({
      username,
      usernameLower: username.toLowerCase(),
      passwordHash: 'test-account-cannot-log-in',
    });
    return { token: issueToken(user), id: user._id.toString() };
  }

  it('throttles a player buying as fast as they can click', async () => {
    const { token } = await player('speedy');
    const start = await request(app)
      .post('/haul/start')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const good = start.body.run.board[0].id;

    // Fired together. In sequence the bucket refills faster than the
    // requests arrive, which is the limiter working rather than failing.
    const results = await Promise.all(
      Array.from({ length: TRADE_LIMIT.capacity + 10 }, () =>
        request(app)
          .post('/haul/buy')
          .set('Authorization', `Bearer ${token}`)
          .send({ good, qty: 1 }),
      ),
    );

    const throttled = results.filter((r) => r.status === 429);
    expect(throttled.length).toBeGreaterThan(0);
    expect(throttled[0].body.error).toBe('trade_rate_limited');
    expect(Number(throttled[0].headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('limits each player separately', async () => {
    const a = await player('busy_one');
    const b = await player('quiet_one');
    const startA = await request(app).post('/haul/start').set('Authorization', `Bearer ${a.token}`);
    await request(app).post('/haul/start').set('Authorization', `Bearer ${b.token}`);
    const good = startA.body.run.board[0].id;

    await Promise.all(
      Array.from({ length: TRADE_LIMIT.capacity + 10 }, () =>
        request(app)
          .post('/haul/buy')
          .set('Authorization', `Bearer ${a.token}`)
          .send({ good, qty: 1 }),
      ),
    );

    const other = await request(app)
      .post('/haul/buy')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ good, qty: 1 });
    expect(other.status).not.toBe(429);
  });
});

describe('auth rate limit', () => {
  it('resists credential stuffing from one address', async () => {
    const results = [];
    for (let i = 0; i < AUTH_LIMIT.capacity + 3; i += 1) {
      results.push(
        await request(app)
          .post('/auth/login')
          .send({ username: 'victim', password: `guess${i}` }),
      );
    }

    const throttled = results.filter((r) => r.status === 429);
    expect(throttled.length).toBeGreaterThan(0);
    expect(throttled[0].body.error).toBe('auth_rate_limited');
  });

  it('throttles registration from the same address too', async () => {
    // Otherwise the limit is trivially bypassed by registering fresh
    // accounts instead of guessing passwords.
    const results = [];
    for (let i = 0; i < AUTH_LIMIT.capacity + 3; i += 1) {
      results.push(
        await request(app)
          .post('/auth/register')
          .send({ username: `flood_${i}`, password: 'correct-horse-battery' }),
      );
    }
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });
});
