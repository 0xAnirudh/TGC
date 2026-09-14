import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { tradeRateLimit } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import { viewRun, startRun, endRun, buy, sell, repay, upgrade, travel } from '../services/haul.js';
import { Run } from '../models/Run.js';
import { User } from '../models/User.js';
import { RUN_DAYS, OPENING_CASH, OPENING_DEBT, OPENING_CAPACITY, DEBT_RATE_BPS } from '@tgc/shared';

export const haulRouter = Router();

const tradeSchema = z.object({
  good: z.string().min(1),
  qty: z.number().int().positive().max(100_000),
});

/** The rules, so the game can explain itself before anyone commits. */
haulRouter.get('/rules', (req, res) => {
  res.json({
    days: RUN_DAYS,
    openingCash: OPENING_CASH,
    openingDebt: OPENING_DEBT,
    openingCapacity: OPENING_CAPACITY,
    debtRatePct: DEBT_RATE_BPS / 100,
  });
});

/** The run in progress, or null. */
haulRouter.get('/', authenticate, async (req, res) => {
  res.json({ run: await viewRun(req.auth.userId) });
});

haulRouter.post('/start', authenticate, async (req, res) => {
  res.status(201).json({ run: await startRun(req.auth.userId) });
});

haulRouter.post('/end', authenticate, async (req, res) => {
  const result = await endRun(req.auth.userId, { abandoned: Boolean(req.body?.abandon) });
  res.json(result);
});

haulRouter.post(
  '/buy',
  authenticate,
  tradeRateLimit,
  validateBody(tradeSchema),
  async (req, res) => {
    await buy(req.auth.userId, req.body.good, req.body.qty);
    res.json({ run: await viewRun(req.auth.userId) });
  },
);

haulRouter.post(
  '/sell',
  authenticate,
  tradeRateLimit,
  validateBody(tradeSchema),
  async (req, res) => {
    await sell(req.auth.userId, req.body.good, req.body.qty);
    res.json({ run: await viewRun(req.auth.userId) });
  },
);

haulRouter.post(
  '/travel',
  authenticate,
  tradeRateLimit,
  validateBody(z.object({ to: z.string().min(1) })),
  async (req, res) => {
    const { event } = await travel(req.auth.userId, req.body.to);
    res.json({ run: await viewRun(req.auth.userId), event });
  },
);

haulRouter.post(
  '/repay',
  authenticate,
  validateBody(z.object({ amount: z.number().int().positive() })),
  async (req, res) => {
    await repay(req.auth.userId, req.body.amount);
    res.json({ run: await viewRun(req.auth.userId) });
  },
);

haulRouter.post('/upgrade', authenticate, async (req, res) => {
  await upgrade(req.auth.userId);
  res.json({ run: await viewRun(req.auth.userId) });
});

/**
 * The board.
 *
 * Best finished run per player, so someone with a hundred attempts does
 * not fill it - the interesting number is the best haul anyone managed,
 * not how many they tried.
 */
haulRouter.get('/board', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const rows = await Run.aggregate([
    { $match: { status: 'finished', score: { $gt: 0 } } },
    { $sort: { score: -1 } },
    {
      $group: {
        _id: '$userId',
        score: { $first: '$score' },
        runId: { $first: '$_id' },
        at: { $first: '$finishedAt' },
      },
    },
    { $sort: { score: -1 } },
    { $limit: limit },
  ]);

  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u.username]));

  res.json({
    entries: rows.map((r, i) => ({
      rank: i + 1,
      username: byId.get(r._id.toString()) ?? 'unknown',
      score: r.score,
      at: r.at,
      runId: r.runId.toString(),
    })),
  });
});

/** A player's own finished runs. */
haulRouter.get('/history', authenticate, async (req, res) => {
  const runs = await Run.find({ userId: req.auth.userId, status: { $ne: 'active' } })
    .sort({ finishedAt: -1 })
    .limit(20)
    .lean();

  res.json({
    runs: runs.map((r) => ({
      id: r._id.toString(),
      score: r.score,
      ruined: r.ruined,
      days: r.day,
      status: r.status,
      at: r.finishedAt,
    })),
  });
});
