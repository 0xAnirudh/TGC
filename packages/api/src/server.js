import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './log.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  log.info('api listening', { port: config.PORT, env: config.NODE_ENV });
});

/**
 * Graceful shutdown. The API is meant to run behind a load balancer with
 * several instances, so a rolling deploy must be able to drain a process
 * without cutting in-flight requests.
 */
async function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
