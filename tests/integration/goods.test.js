import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { warmMarketState } from '../../packages/api/src/services/market.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { goodSupply } from '../../packages/api/src/redis/keys.js';
import { Market } from '../../packages/api/src/models/Market.js';
import { price, buyCost, sellBreakdown } from '@tgc/shared';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply } from '../helpers/market.js';
import { DEFAULT_REGION } from '@tgc/shared';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

describe('GET /goods', () => {
  it('lists goods with their live price', async () => {
    await makeGood({ name: 'Copper', basePrice: 120, k: 12_000, n: 2 });
    await makeGood({ name: 'Iron', basePrice: 60, k: 20_000, n: 1 });

    const res = await request(app).get('/goods').expect(200);
    expect(res.body.goods).toHaveLength(2);

    const copper = res.body.goods.find((g) => g.name === 'Copper');
    expect(copper.price).toBe(120); // at zero supply, price is basePrice
    expect(copper.supply).toBe(0);
  });

  it('is public - no token required', async () => {
    await makeGood();
    await request(app).get('/goods').expect(200);
  });
});

describe('GET /goods/:id', () => {
  it('returns the curve shape alongside the live numbers', async () => {
    const { id, k, n } = await makeGood();
    await setSupply(id, 6_000);

    const res = await request(app).get(`/goods/${id}`).expect(200);
    expect(res.body.good.k).toBe(k);
    expect(res.body.good.n).toBe(n);
    expect(res.body.good.supply).toBe(6_000);
    expect(res.body.good.price).toBeCloseTo(price(120, 6_000, k, n), 1);
  });

  it('404s a malformed id rather than 500ing inside the driver', async () => {
    const res = await request(app).get('/goods/not-an-objectid').expect(404);
    expect(res.body.error).toBe('good_not_found');
  });
});

describe('GET /goods/:id/quote', () => {
  it('matches the curve math exactly for a buy', async () => {
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 12_000);

    const res = await request(app).get(`/goods/${id}/quote?side=buy&qty=500`).expect(200);
    expect(res.body.total).toBe(buyCost(basePrice, 12_000, 500, k, n));
    expect(res.body.spotPrice).toBe(480); // 120 * (1 + 12000/12000)^2
  });

  it('costs more than quantity times spot, because the order walks the curve', async () => {
    // The single most common misunderstanding of a bonding curve: a
    // large order does not transact at the displayed price.
    const { id } = await makeGood();
    await setSupply(id, 12_000);

    const res = await request(app).get(`/goods/${id}/quote?side=buy&qty=1000`).expect(200);
    expect(res.body.total).toBeGreaterThan(res.body.spotPrice * 1000);
    expect(res.body.avgPrice).toBeGreaterThan(res.body.spotPrice);
    expect(res.body.priceAfter).toBeGreaterThan(res.body.spotPrice);
  });

  it('takes exactly the 2% spread on a sell', async () => {
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 12_000);

    const res = await request(app).get(`/goods/${id}/quote?side=sell&qty=500`).expect(200);
    const expected = sellBreakdown(basePrice, 12_000, 500, k, n);

    expect(res.body.gross).toBe(expected.gross);
    expect(res.body.spread).toBe(expected.spread);
    expect(res.body.total).toBe(expected.net);
    expect(res.body.spread / res.body.gross).toBeCloseTo(0.02, 4);
  });

  it('shows a round trip losing money', async () => {
    // Quote a buy, then quote selling it straight back at the resulting
    // supply. This is FINDING-001 visible through the API.
    const { id } = await makeGood();
    await setSupply(id, 12_000);

    const buy = await request(app).get(`/goods/${id}/quote?side=buy&qty=500`).expect(200);
    await setSupply(id, 12_500);
    const sell = await request(app).get(`/goods/${id}/quote?side=sell&qty=500`).expect(200);

    expect(sell.body.total).toBeLessThan(buy.body.total);
  });

  it('caps a single trade as a share of supply', async () => {
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    const res = await request(app).get(`/goods/${id}/quote?side=buy&qty=99999`).expect(400);
    expect(res.body.error).toBe('trade_too_large');
    expect(res.body.details.maxQty).toBe(1_000); // 10% of supply
  });

  it('lets a brand new good be bootstrapped despite the percentage cap', async () => {
    // 10% of zero is zero, so without a floor the first buy of every new
    // good would be impossible.
    const { id } = await makeGood();
    await request(app).get(`/goods/${id}/quote?side=buy&qty=100`).expect(200);
  });

  it('refuses to sell more units than exist', async () => {
    const { id } = await makeGood();
    await setSupply(id, 500);

    const res = await request(app).get(`/goods/${id}/quote?side=sell&qty=400`).expect(400);
    expect(res.body.error).toBe('trade_too_large');
  });

  it.each([
    ['an unknown side', 'side=sideways&qty=10'],
    ['a fractional quantity', 'side=buy&qty=1.5'],
    ['a negative quantity', 'side=buy&qty=-5'],
    ['a missing side', 'qty=10'],
  ])('rejects %s', async (_label, query) => {
    const { id } = await makeGood();
    const res = await request(app).get(`/goods/${id}/quote?${query}`).expect(400);
    expect(res.body.error).toBe('validation_failed');
  });
});

describe('warming redis from mongo', () => {
  it('fills in a good redis has never seen', async () => {
    const { id } = await makeGood({ supply: 0 });
    await getRedis().del(goodSupply(id, DEFAULT_REGION));

    await warmMarketState();
    expect(await getRedis().get(goodSupply(id, DEFAULT_REGION))).toBe('0');
  });

  it('never overwrites live state with a stale mongo value', async () => {
    // This is the one that matters. Redis holds the supply that trades
    // have actually produced; Mongo's copy lags. A warm that overwrote
    // would silently roll the market back on every restart.
    const { id } = await makeGood({ supply: 0 });
    await setSupply(id, 47_000, DEFAULT_REGION);
    await Market.updateOne({ goodId: id, region: DEFAULT_REGION }, { supply: 0 });

    await warmMarketState();
    expect(await getRedis().get(goodSupply(id, DEFAULT_REGION))).toBe('47000');
  });
});
