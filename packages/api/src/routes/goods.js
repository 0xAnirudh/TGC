import { Router } from 'express';
import mongoose from 'mongoose';
import { Good } from '../models/Good.js';
import { ApiError } from '../util/errors.js';
import { validateQuery } from '../middleware/validate.js';
import { quoteQuerySchema } from '../schemas/market.js';
import { listGoodsWithMarket, readMarketState, computeQuote } from '../services/market.js';
import { price } from '@tgc/shared';

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
  const good = await findGoodOr404(req.params.id);
  const { supply, basePrice } = await readMarketState(good._id.toString());
  const { side, qty } = req.validatedQuery;

  res.json({
    goodId: good._id.toString(),
    name: good.name,
    ...computeQuote({ basePrice, supply, k: good.k, n: good.n, side, qty }),
  });
});
