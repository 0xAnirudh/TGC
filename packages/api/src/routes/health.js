import { Router } from 'express';
import { mongoStatus } from '../db/mongo.js';
import { redisStatus } from '../redis/client.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * Liveness: is this process running at all?
 *
 * Never touches a store. An orchestrator uses this to decide whether to
 * kill and replace the container, and killing a healthy process because
 * a shared database is briefly unreachable would turn one store outage
 * into a full restart loop across every instance at once.
 */
healthRouter.get('/live', (req, res) => {
  res.json({ status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});

/**
 * Readiness: can this process serve traffic?
 *
 * Checks both stores and answers 503 when either is down, so a load
 * balancer takes the instance out of rotation without killing it. Redis
 * is pinged rather than trusted to report its own state, because
 * ioredis reports "ready" from the moment the socket connects, which is
 * not the same as the server answering commands.
 */
healthRouter.get('/', async (req, res) => {
  const [mongo, redis] = await Promise.all([Promise.resolve(mongoStatus()), redisStatus()]);

  const ready = mongo.connected && redis.connected;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    stores: { mongo, redis },
  });
});
