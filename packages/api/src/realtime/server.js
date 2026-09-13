import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../config.js';
import { log } from '../log.js';
import { getRedis } from '../redis/client.js';
import { CHANNEL_PRICES } from './publish.js';

/**
 * Live price updates.
 *
 * Clients subscribe to individual goods and receive price changes as
 * they happen. Two things are worth explaining here.
 *
 * THE REDIS ADAPTER. Socket.IO holds connections in process memory, so
 * with several API instances a broadcast from one reaches only the
 * clients connected to that instance. The adapter routes broadcasts
 * through Redis so every instance delivers to its own sockets. Without
 * it, whether a client sees a price move would depend on which machine
 * the load balancer happened to give them.
 *
 * COALESCING. A busy good can trade many times a second, and emitting
 * every change individually means a client redraws its chart dozens of
 * times a second to show numbers no human can read that fast. Changes
 * are buffered and flushed every 250ms, keeping only the latest price
 * per good - which is the only one still true.
 */

const FLUSH_MS = 250;

let io = null;
let pending = new Map();
let flushTimer = null;

export function attachRealtime(httpServer) {
  const redis = getRedis();

  io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    // The adapter needs two dedicated connections - a subscriber cannot
    // issue ordinary commands, so it cannot share the API's client.
    adapter: createAdapter(redis.duplicate(), redis.duplicate()),
  });

  /**
   * A token is optional. The market is public (FR-2), so a guest can
   * watch prices move without an account; a token only adds the personal
   * channel.
   */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next();

    try {
      const claims = jwt.verify(token, config.JWT_SECRET);
      socket.data.userId = claims.sub;
      socket.data.username = claims.username;
      next();
    } catch {
      // A bad token is rejected rather than quietly downgraded to guest.
      // A client that believes it is authenticated and silently is not
      // would wait forever for personal events that never arrive.
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.userId) socket.join(`user:${socket.data.userId}`);

    socket.on('watch', (goodId) => {
      if (typeof goodId === 'string' && goodId.length <= 64) socket.join(`good:${goodId}`);
    });

    socket.on('unwatch', (goodId) => {
      if (typeof goodId === 'string') socket.leave(`good:${goodId}`);
    });
  });

  const subscriber = redis.duplicate();
  subscriber.subscribe(CHANNEL_PRICES).catch((err) => {
    log.error('failed to subscribe to price channel', { err: err.message });
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL_PRICES) return;
    try {
      const update = JSON.parse(raw);
      // Last write wins: only the newest price for a good is still true.
      pending.set(update.goodId, update);
      scheduleFlush();
    } catch (err) {
      log.warn('unparseable price message', { err: err.message });
    }
  });

  log.info('realtime attached');
  return io;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  flushTimer = null;
  if (!io || pending.size === 0) return;

  for (const [goodId, update] of pending) {
    io.to(`good:${goodId}`).emit('price', update);
  }
  // One summary to everyone, so a client watching the whole market list
  // does not need to join a room per good.
  io.emit('market', [...pending.values()]);
  pending = new Map();
}

export function getIo() {
  return io;
}

export async function closeRealtime() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (io) await io.close();
  io = null;
}
