import { Router } from 'express';
import { topByNetWorth } from '../services/leaderboard.js';

export const leaderboardRouter = Router();

/**
 * FR-8.1 / FR-8.2 - the net worth board.
 *
 * Reads the sorted set the revaluation job maintains. Never recomputes
 * on request.
 */
leaderboardRouter.get('/', async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json({ board: 'networth', entries: await topByNetWorth(limit) });
});
