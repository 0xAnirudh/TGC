import express from 'express';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { goodsRouter } from './routes/goods.js';
import { tradesRouter } from './routes/trades.js';
import { portfolioRouter } from './routes/portfolio.js';
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
  app.use(express.json({ limit: '16kb' }));

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/me', meRouter);
  app.use('/goods', goodsRouter);
  app.use('/trades', tradesRouter);
  app.use('/portfolio', portfolioRouter);

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
