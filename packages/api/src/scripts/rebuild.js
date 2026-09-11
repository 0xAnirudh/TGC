import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis } from '../redis/client.js';
import { rebuildFromLedger } from '../services/rebuild.js';
import { log } from '../log.js';

/**
 *   npm run rebuild --workspace=@tgc/api
 *   npm run rebuild --workspace=@tgc/api -- --dry-run
 *
 * Replays the Mongo trade ledger and writes the resulting market state
 * into Redis. Safe to run against a populated Redis - it overwrites,
 * which is the point.
 */
const dryRun = process.argv.includes('--dry-run');

await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);
const { summary } = await rebuildFromLedger({ dryRun });

console.log(`\n  ${dryRun ? 'DRY RUN - nothing written' : 'rebuilt from ledger'}`);
console.log(`  users   ${summary.users}`);
console.log(`  goods   ${summary.goods}`);
console.log(`  trades  ${summary.trades}`);
console.log(`  granted ${summary.granted.toLocaleString()}`);
console.log(`  reserve ${summary.reserve.toLocaleString()}`);
console.log(`  burned  ${summary.burned.toLocaleString()}`);
console.log(`  took    ${summary.ms}ms\n`);

await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
log.info('done');
