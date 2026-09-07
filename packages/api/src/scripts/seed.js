import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../redis/client.js';
import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { goodSupply, goodBasePrice } from '../redis/keys.js';
import { log } from '../log.js';

/**
 * Seed the starting market.
 *
 * These are the same eight goods, with the same curve parameters, that
 * the Phase 0 simulation ran ten thousand trades against. Reusing them
 * means the live market's behaviour is already characterised: we know
 * roughly how far each one moves and that none of them run away.
 *
 *   npm run seed           add anything missing, leave existing alone
 *   npm run seed -- --reset  wipe goods and markets first
 */
const GOODS = [
  { name: 'Iron', colorToken: 'slate', basePrice: 60, k: 20_000, n: 1 },
  { name: 'Grain', colorToken: 'amber', basePrice: 45, k: 25_000, n: 1 },
  { name: 'Copper', colorToken: 'orange', basePrice: 120, k: 12_000, n: 2 },
  { name: 'Silk', colorToken: 'violet', basePrice: 200, k: 8_000, n: 2 },
  { name: 'Amber', colorToken: 'yellow', basePrice: 340, k: 5_000, n: 2 },
  { name: 'Cobalt', colorToken: 'blue', basePrice: 180, k: 6_000, n: 3 },
  { name: 'Ink', colorToken: 'indigo', basePrice: 90, k: 15_000, n: 2 },
  { name: 'Saffron', colorToken: 'rose', basePrice: 500, k: 3_000, n: 3 },
];

async function seed({ reset = false } = {}) {
  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);
  const redis = getRedis();

  if (reset) {
    log.warn('resetting goods and markets');
    const existing = await Market.find().lean();
    await Promise.all(
      existing.map((m) =>
        redis.del(goodSupply(m.goodId.toString()), goodBasePrice(m.goodId.toString())),
      ),
    );
    await Promise.all([Good.deleteMany({}), Market.deleteMany({})]);
  }

  for (const spec of GOODS) {
    const nameLower = spec.name.toLowerCase();
    let good = await Good.findOne({ nameLower });

    if (!good) {
      good = await Good.create({
        name: spec.name,
        nameLower,
        colorToken: spec.colorToken,
        k: spec.k,
        n: spec.n,
      });
      log.info('created good', { name: good.name, k: good.k, n: good.n });
    }

    const id = good._id.toString();
    await Market.updateOne(
      { goodId: good._id },
      { $setOnInsert: { basePrice: spec.basePrice, supply: 0, vol24h: 0 } },
      { upsert: true },
    );

    // NX so re-running the seed never resets a market that has traded.
    await redis.set(goodSupply(id), 0, 'NX');
    await redis.set(goodBasePrice(id), spec.basePrice, 'NX');
  }

  const count = await Good.countDocuments();
  log.info('seed complete', { goods: count });

  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
  await mongoose.disconnect().catch(() => {});
}

seed({ reset: process.argv.includes('--reset') }).catch((err) => {
  log.error('seed failed', { err: err.message });
  process.exit(1);
});
