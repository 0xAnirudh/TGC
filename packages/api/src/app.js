import express from 'express';
import { healthRouter } from './routes/health.js';
import { log } from './log.js';

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
  app.use(express.json({ limit: '16kb' }));

  app.use('/health', healthRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Express identifies an error handler by its arity, so `next` has to
  // stay in the signature even though it is unused.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('unhandled request error', { path: req.path, err: err.message });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
