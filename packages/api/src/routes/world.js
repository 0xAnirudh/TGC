import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';
import { travelTo, regionsFor, cargoState, currentLocation } from '../services/location.js';
import { borrow, repay, debtState, MIN_LOAN } from '../services/debt.js';
import { User } from '../models/User.js';
import { getRedis } from '../redis/client.js';
import { userCash } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { cargoUpgradeCost, CARGO_STEP, MAX_CARGO, BASE_CARGO, isRegion } from '@tgc/shared';

export const worldRouter = Router();

/** The four markets, with what it costs to reach each from where you are. */
worldRouter.get('/regions', async (req, res) => {
  const header = req.get('authorization');
  let userId = null;
  if (header) {
    try {
      const jwt = (await import('jsonwebtoken')).default;
      const { config } = await import('../config.js');
      userId = jwt.verify(header.split(' ')[1], config.JWT_SECRET).sub;
    } catch {
      // Guests see the map from the default region.
    }
  }
  res.json({ regions: await regionsFor(userId) });
});

worldRouter.post(
  '/travel',
  authenticate,
  validateBody(z.object({ to: z.string().refine(isRegion, 'No such place') })),
  async (req, res) => {
    res.json(await travelTo({ userId: req.auth.userId, to: req.body.to }));
  },
);

worldRouter.get('/cargo', authenticate, async (req, res) => {
  const state = await cargoState(req.auth.userId);
  res.json({
    ...state,
    location: await currentLocation(req.auth.userId),
    upgrade:
      state.capacity >= MAX_CARGO
        ? null
        : { step: CARGO_STEP, cost: cargoUpgradeCost(state.capacity) },
  });
});

/**
 * Buy more hold.
 *
 * The fee is burned, like the issuing fee and the travel fare. Cargo
 * space is bought from the world, not from another player, so there is
 * nobody for the Notes to go to.
 */
worldRouter.post('/cargo/upgrade', authenticate, requireUser, async (req, res) => {
  const user = req.user;
  const currentCapacity = user.cargoCapacity ?? BASE_CARGO;
  if (currentCapacity >= MAX_CARGO) {
    throw ApiError.badRequest('cargo_maxed', 'Your hold is already as large as it gets');
  }

  const cost = cargoUpgradeCost(currentCapacity);
  const redis = getRedis();
  const cash = Number((await redis.get(userCash(user._id.toString()))) ?? user.cash);

  if (cash < cost) {
    throw ApiError.badRequest('insufficient_funds', 'Not enough Notes for that upgrade', {
      required: cost,
      available: cash,
    });
  }

  await redis
    .multi()
    .decrby(userCash(user._id.toString()), cost)
    .incrby('econ:burned', cost)
    .exec();

  const capacity = Math.min(MAX_CARGO, currentCapacity + CARGO_STEP);
  await User.updateOne(
    { _id: user._id },
    { $set: { cargoCapacity: capacity }, $inc: { cash: -cost } },
  );

  res.json({ capacity, paid: cost, cash: cash - cost });
});

worldRouter.get('/loans', authenticate, async (req, res) => {
  res.json(await debtState(req.auth.userId));
});

worldRouter.post(
  '/loans/borrow',
  authenticate,
  validateBody(z.object({ amount: z.number().int().min(MIN_LOAN).max(10_000_000) })),
  async (req, res) => {
    res.json(await borrow({ userId: req.auth.userId, amount: req.body.amount }));
  },
);

worldRouter.post(
  '/loans/repay',
  authenticate,
  validateBody(z.object({ amount: z.number().int().positive().max(10_000_000) })),
  async (req, res) => {
    res.json(await repay({ userId: req.auth.userId, amount: req.body.amount }));
  },
);
