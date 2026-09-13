import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';
import { claimDailyBonus } from '../services/bonus.js';
import { rankOf } from '../services/leaderboard.js';

export const meRouter = Router();

meRouter.get('/', authenticate, requireUser, async (req, res) => {
  res.json({
    user: { ...req.user.toPrivate(), rank: await rankOf(req.user._id) },
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
