import { Router } from 'express';
import { latestNewspaper, newspaperFor } from '../services/newspaper.js';
import { ApiError } from '../util/errors.js';

export const newspaperRouter = Router();

newspaperRouter.get('/', async (req, res) => {
  const paper = await latestNewspaper();
  if (!paper) throw ApiError.notFound('no_newspaper', 'No edition has been published yet');
  res.json({ newspaper: paper });
});

newspaperRouter.get('/:date', async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    throw ApiError.badRequest('bad_date', 'Date must be YYYY-MM-DD');
  }
  const paper = await newspaperFor(req.params.date);
  if (!paper) throw ApiError.notFound('no_newspaper', 'No edition for that date');
  res.json({ newspaper: paper });
});
