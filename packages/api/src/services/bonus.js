import { User } from '../models/User.js';
import { getRedis } from '../redis/client.js';
import { userCash, ECON_GRANTED } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';

/**
 * Daily login bonus.
 *
 * A faucet, so every Note it creates has to be counted against
 * ECON_GRANTED or the money supply invariant stops balancing. That is
 * the only genuinely delicate thing about this feature.
 *
 * Scaled by account age so a returning player gets a little more than a
 * brand new one, and capped so it never becomes a substitute for
 * trading.
 */
export const BASE_BONUS = 2_000;
export const MAX_BONUS = 6_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function bonusFor(accountAgeDays) {
  const scaled = BASE_BONUS + Math.floor(accountAgeDays / 7) * 500;
  return Math.min(MAX_BONUS, scaled);
}

export async function claimDailyBonus(userId) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');

  const now = Date.now();
  if (user.lastBonusAt && now - user.lastBonusAt.getTime() < DAY_MS) {
    const nextAt = new Date(user.lastBonusAt.getTime() + DAY_MS);
    throw ApiError.badRequest('bonus_already_claimed', 'Come back tomorrow', { nextAt });
  }

  const ageDays = Math.floor((now - user.createdAt.getTime()) / DAY_MS);
  const amount = bonusFor(ageDays);

  // Claim the slot in Mongo first, and only pay out if this update
  // actually matched. Two simultaneous claims both pass the check above,
  // but only one can satisfy the lastBonusAt condition here - so only
  // one pays.
  const claimed = await User.updateOne(
    {
      _id: userId,
      $or: [{ lastBonusAt: null }, { lastBonusAt: user.lastBonusAt }],
    },
    { $set: { lastBonusAt: new Date(now) }, $inc: { cash: amount } },
  );

  if (claimed.modifiedCount !== 1) {
    throw ApiError.badRequest('bonus_already_claimed', 'Come back tomorrow');
  }

  const redis = getRedis();
  await redis.multi().incrby(userCash(userId), amount).incrby(ECON_GRANTED, amount).exec();

  const cash = Number(await redis.get(userCash(userId)));
  return { amount, cash };
}
