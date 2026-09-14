import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../redis/client.js';
import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { goodSupply, goodBasePrice } from '../redis/keys.js';
import { log } from '../log.js';
import { cacheGoodMeta } from '../services/goodCache.js';
import { REGIONS, reserveAt, openingStockFor } from '@tgc/shared';

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

/**
 * Drop indexes that no longer match the schema.
 *
 * Mongoose creates the indexes a schema declares, and never removes the
 * ones it used to. Market.goodId was unique when there was one market
 * per good; it is now unique per good PER REGION, and the old index sits
 * in the database refusing the second region with a duplicate key error
 * that names a constraint no longer in the code.
 *
 * Nothing warns about this. The schema and the database simply disagree
 * until someone notices.
 */
async function dropStaleIndexes() {
  const stale = [
    { collection: 'markets', index: 'goodId_1' },
    { collection: 'trades', index: 'streamId_1' },
  ];

  // Market documents from before regions existed have no region at all.
  // They are not upgradeable - there is no way to know which of the four
  // markets an old row was - so they are removed and reseeded.
  const orphaned = await Market.deleteMany({ region: { $exists: false } });
  if (orphaned.deletedCount > 0) {
    log.warn('removed pre-region market documents', { count: orphaned.deletedCount });
  }

  for (const { collection, index } of stale) {
    try {
      const indexes = await mongoose.connection.db.collection(collection).indexes();
      const found = indexes.find((i) => i.name === index);
      // Only drop it if it is the stale *unique* form. A same-named
      // index that is no longer unique is someone else's business.
      if (found?.unique && collection === 'markets') {
        await mongoose.connection.db.collection(collection).dropIndex(index);
        log.warn('dropped stale index', { collection, index });
      }
    } catch {
      // Collection or index does not exist. Nothing to drop.
    }
  }
}

async function seed({ reset = false } = {}) {
  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);
  const redis = getRedis();
  await dropStaleIndexes();

  if (reset) {
    log.warn('resetting goods and markets');
    const existing = await Market.find().lean();
    await Promise.all(
      existing.map((m) =>
        redis.del(
          goodSupply(m.goodId.toString(), m.region),
          goodBasePrice(m.goodId.toString(), m.region),
        ),
      ),
    );
    await Promise.all([Good.deleteMany({}), Market.deleteMany({})]);
  }

  let openingReserve = 0;

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

    // One market per region, each starting at a different price.
    //
    // The biases are what create the opening arbitrage: the harbour is
    // the source and sells cheap, the frontier is far from everything
    // and pays dearly. Without a spread on day one there is nothing to
    // notice and no reason to travel.
    for (const region of REGIONS) {
      const basePrice = Math.max(5, Math.round(spec.basePrice * region.priceBias));
      const stock = openingStockFor(good.k);

      const existing = await Market.findOne({ goodId: good._id, region: region.id });

      await Market.updateOne(
        { goodId: good._id, region: region.id },
        {
          $setOnInsert: {
            basePrice,
            launchPrice: basePrice,
            openingStock: stock,
            supply: stock,
            vol24h: 0,
          },
        },
        { upsert: true },
      );

      // NX so re-running the seed never resets a market that has traded.
      const supplySet = await redis.set(goodSupply(id, region.id), stock, 'NX');
      await redis.set(goodBasePrice(id, region.id), basePrice, 'NX');

      // Opening stock was paid for by the world, so the Notes backing it
      // are real. They go into the reserve, and into the faucet total -
      // otherwise the invariant would show a reserve holding Notes that
      // were never granted, which is exactly the leak it exists to catch.
      if (supplySet && !existing) {
        const backing = Math.round(reserveAt(basePrice, stock, good.k, good.n));
        openingReserve += backing;
      }
    }

    await cacheGoodMeta(good);
  }

  if (openingReserve > 0) {
    await redis.incrby('econ:reserve', openingReserve);
    await redis.incrby('econ:granted', openingReserve);
  }

  const count = await Good.countDocuments();
  log.info('seed complete', { goods: count, openingReserve });

  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
  await mongoose.disconnect().catch(() => {});
}

seed({ reset: process.argv.includes('--reset') }).catch((err) => {
  log.error('seed failed', { err: err.message });
  process.exit(1);
});
