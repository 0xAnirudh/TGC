import { Router } from 'express';
import { authenticate, requireUser } from '../middleware/authenticate.js';

export const meRouter = Router();

meRouter.get('/', authenticate, requireUser, (req, res) => {
  res.json({ user: req.user.toPrivate() });
});
