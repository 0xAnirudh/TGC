import mongoose from 'mongoose';
import { config } from '../config.js';
import { log } from '../log.js';
import { backoffDelay, sleep } from '../util/backoff.js';

/**
 * MongoDB connection.
 *
 * Mongo is the durable projection, not the hot path - from Phase 6 it
 * holds the trade ledger that Redis state is rebuilt from. Losing it
 * does not stop trades executing, so the API retries indefinitely rather
 * than crashing, and the relay lets stream entries accumulate until it
 * comes back.
 */

let connecting = null;

export async function connectMongo({ maxAttempts = Infinity } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  connecting = (async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await mongoose.connect(config.MONGO_URI, {
          dbName: config.MONGO_DB_NAME,
          serverSelectionTimeoutMS: 8_000,
        });
        log.info('mongo connected', { db: config.MONGO_DB_NAME });
        return mongoose.connection;
      } catch (err) {
        const delay = backoffDelay(attempt);
        log.warn('mongo connection failed, retrying', {
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
      }
    }
    throw new Error(`mongo failed to connect after ${maxAttempts} attempts`);
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export function mongoStatus() {
  const { readyState } = mongoose.connection;
  return {
    connected: readyState === 1,
    state: READY_STATES[readyState] ?? 'unknown',
  };
}

export async function disconnectMongo() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  log.info('mongo disconnected');
}

mongoose.connection.on('disconnected', () => log.warn('mongo disconnected unexpectedly'));
mongoose.connection.on('reconnected', () => log.info('mongo reconnected'));
