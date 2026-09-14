import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './log.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { connectRedis, disconnectRedis } from './redis/client.js';
import { attachRealtime, closeRealtime } from './realtime/server.js';

const app = createApp();

/**
 * Listen first, connect afterwards.
 *
 * The obvious ordering - connect to both stores, then bind the port -
 * means a process that cannot reach Mongo never starts, never binds, and
 * therefore never answers a health check. The orchestrator sees a dead
 * container rather than a degraded one, and the operator gets no signal
 * beyond a restart loop.
 *
 * Binding first means /health is answerable from the first moment and
 * reports exactly which store is missing. Readiness returns 503 until
 * both are up, so the load balancer keeps traffic away regardless.
 */
const server = app.listen(config.PORT, () => {
  log.info('api listening', { port: config.PORT, env: config.NODE_ENV });
});

async function connectStores() {
  await Promise.all([
    connectMongo().catch((err) => log.error('mongo gave up', { err: err.message })),
    connectRedis().catch((err) => log.error('redis setup failed', { err: err.message })),
  ]);

  // Attached after Redis is up, because the adapter and the price
  // subscriber both need working connections to duplicate from.
  try {
    attachRealtime(server);
  } catch (err) {
    log.error('realtime failed to attach', { err: err.message });
  }
}

connectStores();

/**
 * Graceful shutdown. The API runs behind a load balancer with several
 * instances, so a rolling deploy must be able to drain a process without
 * cutting in-flight requests.
 */
async function shutdown(signal) {
  log.info('shutting down', { signal });
  const forced = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async () => {
    await Promise.allSettled([closeRealtime(), disconnectMongo(), disconnectRedis()]);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
