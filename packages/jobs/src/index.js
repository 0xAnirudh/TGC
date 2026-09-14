import cron from 'node-cron';
import { connectMongo, disconnectMongo } from '@tgc/api/src/db/mongo.js';
import { connectRedis, disconnectRedis } from '@tgc/api/src/redis/client.js';
import { withJobLock } from '@tgc/api/src/services/jobLock.js';
import { driftTick } from '@tgc/api/src/services/drift.js';
import { revalueAll } from '@tgc/api/src/services/leaderboard.js';
import { generateNewspaper } from '@tgc/api/src/services/newspaper.js';
import { ensureBots, botTick } from '@tgc/api/src/services/bots.js';
import { maybeFireEvent } from '@tgc/api/src/services/events.js';
import { liquidateUnderwater } from '@tgc/api/src/services/shorting.js';
import { log } from '@tgc/api/src/log.js';
import { config } from '@tgc/api/src/config.js';

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

/**
 * Jobs that run faster than once a minute.
 *
 * cron cannot express a sub-minute schedule, and a minute is far too
 * slow for anything a player is watching. These run on plain intervals.
 *
 * They take the same Redis lock as the cron jobs, so two job runners
 * still produce one tick each - NFR-8 does not care how the schedule is
 * expressed.
 */
const INTERVAL_JOBS = [
  {
    name: 'bots',
    everySec: config.BOT_INTERVAL_SEC,
    lockTtlMs: config.BOT_INTERVAL_SEC * 1_000 - 500,
    run: () => botTick(),
  },
  {
    name: 'events',
    everySec: config.EVENT_INTERVAL_SEC,
    lockTtlMs: config.EVENT_INTERVAL_SEC * 1_000 - 500,
    run: () => maybeFireEvent(),
  },
  {
    // Checked often, because a short's loss is unbounded until it is
    // closed. A liquidation that runs late is a liquidation that
    // happens after the collateral stopped covering the loss.
    name: 'liquidate',
    everySec: 8,
    lockTtlMs: 7_500,
    run: () => liquidateUnderwater(),
  },
  {
    name: 'drift',
    everySec: config.DRIFT_INTERVAL_SEC,
    lockTtlMs: config.DRIFT_INTERVAL_SEC * 1_000 - 500,
    run: () => driftTick(),
  },
];

const JOBS = [
  {
    name: 'revalue',
    // Every two minutes. The board is a ranking, not a live readout, and
    // valuing every holding against the curve is the most expensive
    // thing scheduled here.
    schedule: config.REVALUE_CRON,
    lockTtlMs: 110_000,
    run: () => revalueAll(),
  },
  {
    name: 'newspaper',
    // Hourly rather than once at midnight. The paper is upserted on its
    // date, so an hourly run keeps today's edition current instead of
    // showing a stale one all day, and a missed midnight tick does not
    // cost a whole edition.
    schedule: config.NEWSPAPER_CRON,
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

  // The bot roster has to exist before the bot tick has anything to do.
  await ensureBots().catch((err) => log.error('bot setup failed', { err: err.message }));

  for (const job of JOBS) {
    cron.schedule(job.schedule, () => runJob(job));
    log.info('job scheduled', { job: job.name, schedule: job.schedule });
  }

  for (const job of INTERVAL_JOBS) {
    setInterval(() => runJob(job), job.everySec * 1_000).unref();
    log.info('job scheduled', { job: job.name, everySec: job.everySec });
  }

  // Run everything once at boot, so a freshly seeded market has a
  // snapshot to chart, a populated board and some bot activity rather
  // than an empty graph and an empty leaderboard.
  for (const job of [...INTERVAL_JOBS, ...JOBS]) await runJob(job);
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
