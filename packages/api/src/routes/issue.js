import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';
import { issueGood, checkGate, GATE, ISSUE_FEE } from '../services/issuance.js';
import { MIN_CURVE_N, MAX_CURVE_N, MIN_CURVE_K } from '@tgc/shared';

export const issueRouter = Router();

const COLORS = ['slate', 'amber', 'orange', 'violet', 'yellow', 'blue', 'indigo', 'rose', 'green'];

const issueSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(
      /^[A-Za-z][A-Za-z0-9 ]*$/,
      'Name must start with a letter and contain only letters, numbers and spaces',
    ),
  colorToken: z.enum(COLORS),
  // The curve band. An issuer choosing n = 50 would create a good whose
  // price goes vertical after a handful of trades - not a market, a trap
  // for whoever buys second.
  k: z.number().int().min(MIN_CURVE_K).max(500_000),
  n: z.number().int().min(MIN_CURVE_N).max(MAX_CURVE_N),
  basePrice: z.number().int().min(5).max(5_000),
});

/** What it takes to issue, and whether the caller qualifies yet. */
issueRouter.get('/requirements', authenticate, requireUser, (req, res) => {
  const failures = checkGate(req.user);
  res.json({
    fee: ISSUE_FEE,
    requirements: GATE,
    curve: { k: { min: MIN_CURVE_K, max: 500_000 }, n: { min: MIN_CURVE_N, max: MAX_CURVE_N } },
    colors: COLORS,
    eligible: failures.length === 0,
    failures,
  });
});

/** FR-5 - issue a good. */
issueRouter.post('/', authenticate, validateBody(issueSchema), async (req, res) => {
  const result = await issueGood({ userId: req.auth.userId, ...req.body });
  res.status(201).json({
    good: result.good.toPublic(),
    cash: result.cash,
    feeBurned: result.fee,
  });
});
