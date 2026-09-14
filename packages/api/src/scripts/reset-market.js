import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../redis/client.js';
import { User } from '../models/User.js';
import { Trade } from '../models/Trade.js';
import { Holding } from '../models/Holding.js';
import { Market } from '../models/Market.js';
import { ShortPosition } from '../models/ShortPosition.js';
import { PriceSnapshot } from '../models/PriceSnapshot.js';
import { MarketEvent } from '../models/MarketEvent.js';
import { Newspaper } from '../models/Newspaper.js';
import { log } from '../log.js';

/**
 * Put the world back to its starting state.
 *
 *   npm run reset:market            wipe trades, prices, bots, keep people
 *   npm run reset:market -- --all   wipe everything including accounts
 *
 * Development accumulates junk: load-test accounts with fifty times the
 * starting grant, prices left at twenty times launch by a bad bot tuning,
 * a leaderboard of nothing but `lt_` usernames. This clears it without
 * having to remember which collections exist.
 *
 * Refuses to run against anything but a development database, because
 * everything it does is irreversible.
 */
const wipeAll = process.argv.includes('--all');

await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);

if (process.env.NODE_ENV === 'production') {
  console.error('\n  Refusing to run with NODE_ENV=production.\n');
  process.exit(1);
}

const redis = getRedis();

// Load-test accounts always go. They exist with fifty times the normal
// grant purely to drive the load generator, and they make the
// leaderboard meaningless the moment they are left behind.
const loadTest = await User.find({ usernameLower: /^lt_/ }).lean();
const bots = await User.find({ isBot: true }).lean();
const doomed = [...loadTest, ...(wipeAll ? await User.find({}).lean() : bots)];

for (const u of doomed) {
  await redis.del(`user:${u._id}:cash`, `user:${u._id}:holdings`);
}
await User.deleteMany({ _id: { $in: doomed.map((u) => u._id) } });

await Promise.all([
  Trade.deleteMany({}),
  Holding.deleteMany({}),
  ShortPosition.deleteMany({}),
  PriceSnapshot.deleteMany({}),
  MarketEvent.deleteMany({}),
  Newspaper.deleteMany({}),
]);

// Markets back to zero supply and their launch price.
const markets = await Market.find().lean();
for (const m of markets) {
  const id = m.goodId.toString();
  await redis.mset(`mkt:${id}:supply`, 0, `mkt:${id}:basePrice`, m.basePrice);
  await Market.updateOne({ goodId: m.goodId }, { $set: { supply: 0, vol24h: 0 } });
}

// The economy counters have to be recomputed, not zeroed: the remaining
// players still hold their grants, and the invariant has to keep
// balancing after this runs.
const remaining = await User.find().lean();
const granted = remaining.reduce((sum, u) => sum + u.startingGrant, 0);
for (const u of remaining) {
  await redis.set(`user:${u._id}:cash`, u.startingGrant);
  await redis.del(`user:${u._id}:holdings`);
  await User.updateOne({ _id: u._id }, { $set: { cash: u.startingGrant, tradeCount: 0 } });
}
await redis.mset('econ:granted', granted, 'econ:reserve', 0, 'econ:burned', 0);
await redis.del('lb:networth');

log.info('market reset', {
  removedAccounts: doomed.length,
  remainingPlayers: remaining.length,
  goods: markets.length,
  granted,
});

console.log(
  `\n  removed ${doomed.length} accounts (${loadTest.length} load-test, ${wipeAll ? 'all' : bots.length + ' bots'})`,
);
console.log(`  ${remaining.length} players kept, balances reset to their grant`);
console.log(`  ${markets.length} goods back to zero supply at launch price\n`);

await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
