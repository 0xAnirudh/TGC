import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';
import { claimDailyBonus } from '../services/bonus.js';
import { rankOf } from '../services/leaderboard.js';
import { readCash } from '../services/accounts.js';

export const meRouter = Router();

meRouter.get('/', authenticate, requireUser, async (req, res) => {
  // Cash comes from Redis, not from the Mongo document.
  //
  // Since Phase 6 the API writes no balances to Mongo at all - the relay
  // projects them from the trade stream, so the document lags the live
  // value by however long that takes. Serving the document's copy here
  // means a player who trades and glances at their balance sees the
  // figure from before the trade, which reads as the trade not having
  // happened.
  //
  // Falls back to the document for an account that has never been loaded
  // into Redis, where the two agree anyway.
  const liveCash = await readCash(req.auth.userId);

  res.json({
    user: {
      ...req.user.toPrivate(),
      cash: liveCash ?? req.user.cash,
      rank: await rankOf(req.user._id),
    },
  });
});

/** FR-1.6 - show the full portfolio publicly, or only net worth. */
meRouter.patch(
  '/',
  authenticate,
  requireUser,
  validateBody(z.object({ portfolioPublic: z.boolean() })),
  async (req, res) => {
    req.user.portfolioPublic = req.body.portfolioPublic;
    await req.user.save();
    res.json({ user: req.user.toPrivate() });
  },
);

/** FR-8.4 - the daily bonus. A faucet, counted against ECON_GRANTED. */
meRouter.post('/bonus', authenticate, async (req, res) => {
  res.json(await claimDailyBonus(req.auth.userId));
});
