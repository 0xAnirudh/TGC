import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';

/**
 * These run without any store. That is the point: readiness must report
 * a missing store rather than throw, because an instance that cannot
 * answer its own health check is indistinguishable from a dead one.
 */
describe('health', () => {
  const app = createApp();

  it('reports liveness without touching a store', async () => {
    const res = await request(app).get('/health/live').expect(200);
    expect(res.body.status).toBe('alive');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('answers readiness with 503 and names the missing store', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.stores.mongo.connected).toBe(false);
    expect(res.body.stores.redis.connected).toBe(false);
  });

  it('404s an unknown path as JSON rather than an HTML error page', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found', path: '/nope' });
  });
});
