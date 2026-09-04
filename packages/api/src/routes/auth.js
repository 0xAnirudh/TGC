import { Router } from 'express';
import { validateBody } from '../middleware/validate.js';
import { registerSchema, loginSchema } from '../schemas/auth.js';
import { register, login } from '../services/auth.js';

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), async (req, res) => {
  const { user, token } = await register(req.body);
  // 201 with the token attached, so a client does not have to log in
  // immediately after registering just to get one.
  res.status(201).json({ token, user: user.toPrivate() });
});

authRouter.post('/login', validateBody(loginSchema), async (req, res) => {
  const { user, token } = await login(req.body);
  res.json({ token, user: user.toPrivate() });
});
