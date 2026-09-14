import cron from 'node-cron';
import { connectMongo, disconnectMongo } from '@tgc/api/src/db/mongo.js';
import { connectRedis, disconnectRedis } from '@tgc/api/src/redis/client.js';
import { withJobLock } from '@tgc/api/src/services/jobLock.js';
import { driftTick } from '@tgc/api/src/services/drift.js';
import { revalueAll } from '@tgc/api/src/services/leaderboard.js';
import { generateNewspaper } from '@tgc/api/src/services/newspaper.js';
import { log } from '@tgc/api/src/log.js';

/**
 * The scheduled job runner.
 *
 * Every job goes through withJobLock, which is what satisfies NFR-8:
 * exactly once per tick across all instances. Deploy two of these and
 * each tick still runs once - the loser of the lock simply skips.
 *
 * The lock TTL for each job is set a little above how long that job
 * could plausibly take. Too short and a slow run loses its own lock
 * mid-flight, letting a second process start; too long and a crashed
 * process blocks the job for longer than necessary.
 */

const JOBS = [
  {
    name: 'drift',
    // Every minute. Frequent enough that a chart has shape within an
    // hour, slow enough that a month of snapshots stays a manageable
    // collection.
    schedule: '* * * * *',
    lockTtlMs: 50_000,
    run: () => driftTick(),
  },
  {
    name: 'revalue',
    // Every two minutes. The board is a ranking, not a live readout, and
    // valuing every holding against the curve is the most expensive
    // thing scheduled here.
    schedule: '*/2 * * * *',
    lockTtlMs: 110_000,
    run: () => revalueAll(),
  },
  {
    name: 'newspaper',
    // Hourly rather than once at midnight. The paper is upserted on its
    // date, so an hourly run keeps today's edition current instead of
    // showing a stale one all day, and a missed midnight tick does not
    // cost a whole edition.
    schedule: '0 * * * *',
    lockTtlMs: 110_000,
    run: () => generateNewspaper(),
  },
];

export async function runJob(job) {
  const started = Date.now();
  try {
    const { ran } = await withJobLock(job.name, job.lockTtlMs, job.run);
    if (ran) log.info('job finished', { job: job.name, ms: Date.now() - started });
  } catch (err) {
    log.error('job failed', { job: job.name, err: err.message });
  }
}

export async function start() {
  await Promise.all([connectMongo(), connectRedis()]);

  for (const job of JOBS) {
    cron.schedule(job.schedule, () => runJob(job));
    log.info('job scheduled', { job: job.name, schedule: job.schedule });
  }

  // Run both once at boot so a freshly seeded market has a first
  // snapshot to chart and a populated board, rather than an empty graph
  // and an empty leaderboard for the first minute.
  for (const job of JOBS) await runJob(job);
}

export async function stop() {
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}

if (process.argv[1]?.endsWith('jobs/src/index.js')) {
  start().catch((err) => {
    log.error('job runner failed to start', { err: err.message });
    process.exit(1);
  });
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
}
