import { connectMongo, disconnectMongo } from '@tgc/api/src/db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '@tgc/api/src/redis/client.js';
import { STREAM_TRADES } from '@tgc/api/src/redis/keys.js';
import { log } from '@tgc/api/src/log.js';
import { config } from '@tgc/api/src/config.js';
import { projectEntry } from './project.js';

/**
 * The relay worker.
 *
 * Reads the trade stream with a consumer group and writes each entry
 * into Mongo. This is the process that makes Mongo a *projection* of the
 * stream rather than a second source of truth.
 *
 * Why a consumer group rather than a plain XREAD: the group tracks which
 * entries have been acknowledged. If this process dies mid-batch, the
 * unacknowledged entries stay pending and are handed back on restart -
 * so nothing is skipped. The cost is at-least-once delivery, which is
 * why every write in project.js is idempotent.
 *
 * If Mongo is unreachable the loop keeps failing and never acknowledges,
 * so entries accumulate in the stream and are projected when it returns.
 * Nothing is lost, and there is nothing to compensate, because the trade
 * was already durable the moment the Lua script appended it.
 */

export const GROUP = 'relay';
const CONSUMER = `relay-${process.pid}`;
const BATCH = 100;
const BLOCK_MS = config.RELAY_BLOCK_MS;

let running = false;
let blockingClient = null;

/**
 * A connection of its own, used only for the blocking read.
 *
 * A blocking command monopolises its connection for as long as it
 * blocks - the server simply does not answer anything else on that
 * socket. Sharing the API's client would therefore stall every ordinary
 * command behind a read that is, by design, waiting for something that
 * has not happened yet.
 *
 * This is not a theoretical tidiness point. Running the blocking read on
 * the shared client made a `BLOCK 1` - one millisecond - take sixty
 * seconds, because the reply sat behind auto-pipelined traffic on a
 * socket the server had stopped answering.
 */
function getBlockingClient() {
  blockingClient ??= getRedis().duplicate({ enableAutoPipelining: false });
  return blockingClient;
}

async function ensureGroup(redis) {
  try {
    // MKSTREAM so the group can be created before any trade exists.
    await redis.xgroup('CREATE', STREAM_TRADES, GROUP, '0', 'MKSTREAM');
    log.info('created consumer group', { stream: STREAM_TRADES, group: GROUP });
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

/**
 * Claim and project anything left pending by a previous run.
 *
 * A crash between the Mongo write and the acknowledgement leaves entries
 * in the pending list. Without this they would sit there indefinitely -
 * the stream would look drained while the ledger was short.
 */
async function drainPending(redis) {
  const pending = await redis.xreadgroup(
    'GROUP',
    GROUP,
    CONSUMER,
    'COUNT',
    BATCH,
    'STREAMS',
    STREAM_TRADES,
    '0',
  );
  return handle(redis, pending);
}

async function handle(redis, response) {
  if (!response) return 0;

  let projected = 0;
  for (const [, entries] of response) {
    for (const [id, flat] of entries) {
      const fields = {};
      for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];

      try {
        const { firstDelivery } = await projectEntry(id, fields);
        await redis.xack(STREAM_TRADES, GROUP, id);
        projected += 1;
        if (!firstDelivery) log.warn('redelivered entry projected again', { id });
      } catch (err) {
        // Deliberately not acknowledged. The entry stays pending and is
        // retried, which is the whole reason Mongo being down is
        // survivable rather than lossy.
        log.error('projection failed, leaving entry pending', { id, err: err.message });
        return projected;
      }
    }
  }
  return projected;
}

export async function runOnce() {
  const redis = getRedis();
  const response = await redis.xreadgroup(
    'GROUP',
    GROUP,
    CONSUMER,
    'COUNT',
    BATCH,
    'STREAMS',
    STREAM_TRADES,
    '>',
  );
  return handle(redis, response);
}

export async function start() {
  await Promise.all([connectMongo(), connectRedis()]);
  const redis = getRedis();
  await ensureGroup(redis);

  const recovered = await drainPending(redis);
  if (recovered > 0) log.info('recovered pending entries', { count: recovered });

  running = true;
  log.info('relay running', { consumer: CONSUMER });

  const blocking = getBlockingClient();

  while (running) {
    try {
      // Blocks on its own connection, so the API's traffic is untouched.
      const response = await blocking.xreadgroup(
        'GROUP',
        GROUP,
        CONSUMER,
        'COUNT',
        BATCH,
        'BLOCK',
        BLOCK_MS,
        'STREAMS',
        STREAM_TRADES,
        '>',
      );
      await handle(redis, response);
    } catch (err) {
      if (!running) break;
      log.error('relay loop error', { err: err.message });
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

export async function stop() {
  running = false;
  if (blockingClient) {
    blockingClient.disconnect();
    blockingClient = null;
  }
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}

// Only run the loop when started directly, so tests can import the
// pieces without launching a worker.
if (process.argv[1]?.endsWith('relay/src/index.js')) {
  start().catch((err) => {
    log.error('relay failed to start', { err: err.message });
    process.exit(1);
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
