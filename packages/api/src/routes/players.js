import { Router } from 'express';
import { User } from '../models/User.js';
import { Holding } from '../models/Holding.js';
import { Good } from '../models/Good.js';
import { ApiError } from '../util/errors.js';
import { rankOf } from '../services/leaderboard.js';

export const playersRouter = Router();

/**
 * FR-1.5 - a public profile.
 *
 * Net worth and rank are always visible; the holdings breakdown honours
 * the player's visibility setting (FR-1.6). Hiding positions matters in
 * a game where knowing what someone holds tells you what they are about
 * to sell.
 */
playersRouter.get('/:username', async (req, res) => {
  const user = await User.findOne({ usernameLower: String(req.params.username).toLowerCase() });
  if (!user) throw ApiError.notFound('player_not_found', 'No player with that name');

  const profile = {
    username: user.username,
    netWorth: user.netWorthCached,
    netWorthAt: user.netWorthAt,
    rank: await rankOf(user._id),
    tradeCount: user.tradeCount,
    memberSince: user.createdAt,
    portfolioPublic: user.portfolioPublic,
  };

  if (user.portfolioPublic) {
    const holdings = await Holding.find({ userId: user._id, quantity: { $gt: 0 } }).lean();
    const goods = await Good.find({ _id: { $in: holdings.map((h) => h.goodId) } }).lean();
    const byId = new Map(goods.map((g) => [g._id.toString(), g]));

    profile.holdings = holdings.map((h) => ({
      goodId: h.goodId.toString(),
      name: byId.get(h.goodId.toString())?.name ?? 'Unknown',
      quantity: h.quantity,
    }));
  }

  res.json({ player: profile });
});
