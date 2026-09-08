import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { getPortfolio } from '../services/trading.js';

export const portfolioRouter = Router();

/** FR-1.4 - cash, holdings, net worth, unrealised P/L. */
portfolioRouter.get('/', authenticate, async (req, res) => {
  res.json(await getPortfolio(req.auth.userId));
});
