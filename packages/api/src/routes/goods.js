import { Router } from 'express';
import mongoose from 'mongoose';
import { Good } from '../models/Good.js';
import { ApiError } from '../util/errors.js';
import { validateQuery } from '../middleware/validate.js';
import { quoteQuerySchema } from '../schemas/market.js';
import { listGoodsWithMarket, readMarketState, computeQuote } from '../services/market.js';
import { readGoodMeta } from '../services/goodCache.js';
import { priceHistory, VALID_RANGES } from '../services/history.js';
import { price } from '@tgc/shared';
import { z } from 'zod';

export const goodsRouter = Router();

/**
 * Look a good up by id, rejecting a malformed id before it reaches
 * Mongo. Casting a bad ObjectId throws from inside the driver, which
 * would surface as a 500 for what is plainly a client mistake.
 */
async function findGoodOr404(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }
  const good = await Good.findById(id);
  if (!good) throw ApiError.notFound('good_not_found', 'No good with that id');
  return good;
}

/** FR-2.1 - the market listing. Public; no token required. */
goodsRouter.get('/', async (req, res) => {
  res.json({ goods: await listGoodsWithMarket() });
});

const historyQuerySchema = z.object({
  range: z.enum(VALID_RANGES).default('24h'),
});

/** FR-2.2 - one good in detail. */
goodsRouter.get('/:id', async (req, res) => {
  const good = await findGoodOr404(req.params.id);
  const { supply, basePrice } = await readMarketState(good._id.toString());

  res.json({
    good: {
      ...good.toPublic(),
      supply,
      basePrice,
      price: Math.round(price(basePrice, supply, good.k, good.n) * 100) / 100,
    },
  });
});

/**
 * FR-2.3 - a non-binding quote.
 *
 * Served entirely from Redis apart from the Good lookup, which supplies
 * the immutable curve shape. NFR-1 holds this to p95 under 10ms.
 */
goodsRouter.get('/:id/quote', validateQuery(quoteQuerySchema), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw ApiError.notFound('good_not_found', 'No good with that id');
  }

  // Curve shape from the Redis cache, live numbers from Redis. No Mongo
  // on this path at all - see the comment on the goodMeta key for what
  // that was costing.
  const good = await readGoodMeta(req.params.id);
  const { supply, basePrice } = await readMarketState(good.id);
  const { side, qty } = req.validatedQuery;

  res.json({
    goodId: good.id,
    name: good.name,
    ...computeQuote({ basePrice, supply, k: good.k, n: good.n, side, qty }),
  });
});

/**
 * FR-2.2 - price history for a chart.
 *
 * Reads snapshots written by the drift job. Long ranges are thinned to
 * roughly 200 points, keeping real readings rather than averaging them
 * into numbers that were never true.
 */
goodsRouter.get('/:id/history', validateQuery(historyQuerySchema), async (req, res) => {
  const good = await findGoodOr404(req.params.id);
  const history = await priceHistory(good._id, { range: req.validatedQuery.range });
  res.json({ goodId: good._id.toString(), name: good.name, ...history });
});
