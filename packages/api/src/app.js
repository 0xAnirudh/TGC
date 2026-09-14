import express from 'express';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { haulRouter } from './routes/haul.js';
import { log } from './log.js';
import { ApiError } from './util/errors.js';

/**
 * The Express application, with no server attached.
 *
 * Keeping `app` separate from `server.js` is what lets Supertest drive
 * the real app in-process without binding a port, which every
 * integration test from Phase 2 onwards depends on.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind Render's load balancer every request arrives from the proxy.
  // Without this, req.ip is the proxy for everyone and the per-IP auth
  // limit throttles the entire world into one bucket.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));

  /**
   * CORS.
   *
   * In development the frontend is proxied by Vite, so every request is
   * same-origin and this does nothing. In production the frontend is on
   * Vercel and the API is on Render, which are different origins.
   *
   * WEB_ORIGIN is an explicit allow-list rather than a wildcard. A
   * wildcard would let any site on the internet make authenticated
   * requests with a user's token if it ever got hold of one.
   */
  app.use((req, res, next) => {
    const allowed = process.env.WEB_ORIGIN;
    const origin = req.get('origin');

    if (allowed && origin && allowed.split(',').includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/me', meRouter);
  app.use('/haul', haulRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Express identifies an error handler by its arity, so `next` has to
  // stay in the signature even though it is unused.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      const body = { error: err.code, message: err.message };
      if (err.details) body.details = err.details;
      return res.status(err.status).json(body);
    }

    // Anything not deliberately thrown is a bug. Log it in full, tell
    // the client nothing - stack traces and driver messages leak schema
    // details and library versions.
    log.error('unhandled request error', {
      path: req.path,
      err: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
