import { Router } from 'express';
import { recentEvents } from '../services/events.js';

export const eventsRouter = Router();

/** Recent market shocks. Public - it is news, not private data. */
eventsRouter.get('/', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  res.json({ events: await recentEvents(limit) });
});
