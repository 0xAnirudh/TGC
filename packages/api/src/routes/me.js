import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';

export const meRouter = Router();

meRouter.get('/', authenticate, requireUser, async (req, res) => {
  res.json({ user: req.user.toPrivate() });
});

/** Whether this player's finished runs are visible to others. */
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
