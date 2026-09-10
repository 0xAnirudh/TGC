import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { validateBody } from '../middleware/validate.js';
import { tradeBodySchema } from '../schemas/market.js';
import { executeTrade } from '../services/trading.js';
import { Trade } from '../models/Trade.js';

export const tradesRouter = Router();

/**
 * FR-3.1 / FR-3.2 - execute a trade.
 *
 * Note what the client does *not* send: a price. The curve decides it
 * from supply at the moment of execution. A client-supplied price would
 * be the whole exploit - submit a stale low price, get filled at it.
 *
 * What it sends instead is slippageBps - a bound it refuses to cross.
 * That is the correct way to give a client price control: the curve
 * still decides the price, and the client only gets to decline.
 */
tradesRouter.post('/', authenticate, validateBody(tradeBodySchema), async (req, res) => {
  const { goodId, side, qty, slippageBps } = req.body;
  const result = await executeTrade({
    userId: req.auth.userId,
    goodId,
    side,
    qty,
    slippageBps,
  });

  res.status(201).json({
    trade: result.trade.toPublic(),
    cash: result.cash,
    supply: result.supply,
    priceAfter: result.priceAfter,
  });
});

/** The caller's own trade history, newest first. */
tradesRouter.get('/', authenticate, async (req, res) => {
  const trades = await Trade.find({ userId: req.auth.userId }).sort({ createdAt: -1 }).limit(50);
  res.json({ trades: trades.map((t) => t.toPublic()) });
});
