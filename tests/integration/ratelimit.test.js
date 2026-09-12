import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { rateLimitTrade, STREAM_TRADES } from '../../packages/api/src/redis/keys.js';
import { TRADE_LIMIT, AUTH_LIMIT } from '../../packages/api/src/middleware/rateLimit.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(async () => {
  await resetStores();
  await getRedis()
    .xgroup('CREATE', STREAM_TRADES, 'relay', '0', 'MKSTREAM')
    .catch(() => {});
});

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

describe('POST /trades rate limit', () => {
  async function player(username) {
    const res = await request(app)
      .post('/auth/register')
      .send({ username, password: 'correct-horse-battery' });
    return { token: res.body.token, id: res.body.user.id };
  }

  it('throttles a player firing trades as fast as possible', async () => {
    const { token, id: userId } = await player('speedy');
    const { id } = await makeGood({ basePrice: 5, k: 500_000, n: 1 });
    await setSupply(id, 100_000);

    const results = [];
    for (let i = 0; i < TRADE_LIMIT.capacity + 5; i += 1) {
      results.push(
        await request(app)
          .post('/trades')
          .set('Authorization', `Bearer ${token}`)
          .send({ goodId: id, side: 'buy', qty: 10, slippageBps: 2_000 }),
      );
    }

    const throttled = results.filter((r) => r.status === 429);
    expect(throttled.length).toBeGreaterThan(0);
    expect(throttled[0].body.error).toBe('trade_rate_limited');
    expect(Number(throttled[0].headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(await getRedis().exists(rateLimitTrade(userId))).toBe(1);
  });

  it('returns the remaining allowance on a successful trade', async () => {
    const { token } = await player('counter');
    const { id } = await makeGood({ basePrice: 5, k: 500_000, n: 1 });
    await setSupply(id, 100_000);

    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${token}`)
      .send({ goodId: id, side: 'buy', qty: 10, slippageBps: 2_000 })
      .expect(201);

    expect(Number(res.headers['x-ratelimit-limit'])).toBe(TRADE_LIMIT.capacity);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(TRADE_LIMIT.capacity - 1);
  });

  it('limits each player separately', async () => {
    const a = await player('busy_one');
    const b = await player('quiet_one');
    const { id } = await makeGood({ basePrice: 5, k: 500_000, n: 1 });
    await setSupply(id, 100_000);

    for (let i = 0; i < TRADE_LIMIT.capacity + 2; i += 1) {
      await request(app)
        .post('/trades')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ goodId: id, side: 'buy', qty: 10, slippageBps: 2_000 });
    }

    await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ goodId: id, side: 'buy', qty: 10, slippageBps: 2_000 })
      .expect(201);
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
