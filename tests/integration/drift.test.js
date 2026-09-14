import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { goodBasePrice } from '../../packages/api/src/redis/keys.js';
import {
  driftTick,
  nextBasePrice,
  MAX_TICK_DRIFT_BPS,
  MIN_BASE_PRICE_RATIO,
  MAX_BASE_PRICE_RATIO,
} from '../../packages/api/src/services/drift.js';
import { withJobLock } from '../../packages/api/src/services/jobLock.js';
import { PriceSnapshot } from '../../packages/api/src/models/PriceSnapshot.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood } from '../helpers/market.js';
import { REGIONS, DEFAULT_REGION } from '@tgc/shared';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

describe('drift bounds', () => {
  it('never moves a price more than the per-tick cap', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const next = nextBasePrice({ basePrice: 1_000, launchPrice: 1_000, random: () => r });
      const movedBps = (Math.abs(next - 1_000) / 1_000) * 10_000;
      expect(movedBps).toBeLessThanOrEqual(MAX_TICK_DRIFT_BPS + 1);
    }
  });

  it('cannot fall below the floor however many ticks run against it', () => {
    // Drift pinned hard downward, five hundred times.
    let basePrice = 1_000;
    for (let i = 0; i < 500; i += 1) {
      basePrice = nextBasePrice({ basePrice, launchPrice: 1_000, random: () => 0 });
    }
    expect(basePrice).toBe(1_000 * MIN_BASE_PRICE_RATIO);
  });

  it('cannot rise above the ceiling however many ticks run against it', () => {
    let basePrice = 1_000;
    for (let i = 0; i < 500; i += 1) {
      basePrice = nextBasePrice({ basePrice, launchPrice: 1_000, random: () => 0.999999 });
    }
    expect(basePrice).toBe(1_000 * MAX_BASE_PRICE_RATIO);
  });

  it('always yields a whole number', () => {
    // A fractional basePrice would make the Lua and JavaScript curves
    // agree only to float precision - the FINDING-005 failure mode.
    for (let i = 0; i < 200; i += 1) {
      const next = nextBasePrice({ basePrice: 137, launchPrice: 137 });
      expect(Number.isInteger(next)).toBe(true);
    }
  });

  it('tilts with volume rather than being replaced by it', () => {
    // A strong buy bias must still be able to produce a down tick,
    // otherwise it is a trend rather than a market.
    const outcomes = new Set();
    for (const r of [0, 0.2, 0.5, 0.8, 0.999999]) {
      outcomes.add(
        Math.sign(
          nextBasePrice({
            basePrice: 1_000,
            launchPrice: 1_000,
            volumeBias: 0.4,
            random: () => r,
          }) - 1_000,
        ),
      );
    }
    expect(outcomes.has(-1)).toBe(true);
    expect(outcomes.has(1)).toBe(true);
  });
});

describe('driftTick', () => {
  it('moves prices and writes a snapshot for every good', async () => {
    const a = await makeGood({ name: 'Iron', basePrice: 500, k: 20_000, n: 1 });
    await makeGood({ name: 'Silk', basePrice: 300, k: 8_000, n: 2 });

    const before = await getRedis().get(goodBasePrice(a.id, DEFAULT_REGION));
    const result = await driftTick({ random: () => 0.999999 });

    expect(result.goods).toBe(2);
    // One snapshot per good per region - each market drifts on its own.
    expect(result.snapshots).toBe(2 * REGIONS.length);
    expect(Number(await getRedis().get(goodBasePrice(a.id, DEFAULT_REGION)))).toBeGreaterThan(
      Number(before),
    );
    expect(await PriceSnapshot.countDocuments()).toBe(2 * REGIONS.length);
  });

  it('moves basePrice and never supply', async () => {
    // Supply is what the ledger accounts for. Moving it here would
    // create units nobody bought, and the rebuild would correctly erase
    // them - see FINDING-007.
    const { id } = await makeGood({ supply: 4_000 });
    const redis = getRedis();

    await driftTick({ random: () => 0.999999 });
    for (const r of REGIONS) {
      expect(await redis.get(`mkt:${id}:${r.id}:supply`)).toBe('4000');
    }
  });
});

describe('job locking', () => {
  it('lets only one caller run a job per tick', async () => {
    // NFR-8. Without this, every deployed instance applies its own drift
    // tick and prices move once per machine rather than once per tick.
    let ran = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        withJobLock('test-job', 5_000, async () => {
          ran += 1;
          await new Promise((r) => setTimeout(r, 50));
        }),
      ),
    );

    expect(ran).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });

  it('releases the lock so the next tick can run', async () => {
    await withJobLock('test-release', 5_000, async () => {});
    const second = await withJobLock('test-release', 5_000, async () => {});
    expect(second.ran).toBe(true);
  });

  it('releases the lock even when the job throws', async () => {
    await expect(
      withJobLock('test-throw', 5_000, async () => {
        throw new Error('job blew up');
      }),
    ).rejects.toThrow('job blew up');

    const after = await withJobLock('test-throw', 5_000, async () => 'ok');
    expect(after.ran).toBe(true);
  });
});

describe('GET /goods/:id/history', () => {
  it('returns the snapshots the drift job wrote', async () => {
    const { id } = await makeGood();
    await driftTick();
    await driftTick();

    const res = await request(app).get(`/goods/${id}/history?range=24h`).expect(200);
    // Two ticks, one snapshot per region each.
    expect(res.body.points.length).toBe(2 * REGIONS.length);
    expect(res.body.points[0]).toHaveProperty('price');
    expect(res.body.points[0]).toHaveProperty('supply');
  });

  it('thins a long series but keeps the latest reading', async () => {
    const { id, good } = await makeGood();
    const now = Date.now();
    await PriceSnapshot.insertMany(
      Array.from({ length: 900 }, (_, i) => ({
        goodId: good._id,
        region: DEFAULT_REGION,
        price: 100 + i,
        supply: 0,
        basePrice: 100,
        at: new Date(now - (900 - i) * 60_000),
      })),
    );

    const res = await request(app).get(`/goods/${id}/history?range=30d`).expect(200);
    expect(res.body.points.length).toBeLessThanOrEqual(202);
    // The final point must be the newest reading, or a chart's right-hand
    // edge is stale.
    expect(res.body.points[res.body.points.length - 1].price).toBe(999);
  });

  it('rejects an unknown range', async () => {
    const { id } = await makeGood();
    const res = await request(app).get(`/goods/${id}/history?range=forever`).expect(400);
    expect(res.body.error).toBe('validation_failed');
  });
});
