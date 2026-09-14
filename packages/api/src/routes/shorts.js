import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { tradeRateLimit } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import {
  openShort,
  closeShort,
  openShorts,
  COLLATERAL_RATIO,
  LIQUIDATION_RATIO,
  MAX_OPEN_SHORTS,
} from '../services/shorting.js';

export const shortsRouter = Router();

const openSchema = z.object({
  goodId: z.string().min(1),
  qty: z.number().int().positive().max(1_000_000),
});

/** The rules, so the UI can explain them before anyone commits. */
shortsRouter.get('/rules', (req, res) => {
  res.json({
    collateralRatio: COLLATERAL_RATIO,
    liquidationRatio: LIQUIDATION_RATIO,
    maxOpen: MAX_OPEN_SHORTS,
    explanation:
      'Shorting sells units you do not own and buys them back later. ' +
      'You profit if the price falls and lose if it rises. Collateral is ' +
      'locked up front, and the position is force-closed if the price ' +
      `rises to ${LIQUIDATION_RATIO}x your entry - so the collateral is the ` +
      'most you can lose.',
  });
});

shortsRouter.get('/', authenticate, async (req, res) => {
  res.json({ positions: await openShorts(req.auth.userId) });
});

shortsRouter.post('/', authenticate, tradeRateLimit, validateBody(openSchema), async (req, res) => {
  res.status(201).json(await openShort({ userId: req.auth.userId, ...req.body }));
});

shortsRouter.post('/:id/close', authenticate, tradeRateLimit, async (req, res) => {
  res.json(await closeShort({ userId: req.auth.userId, positionId: req.params.id }));
});
