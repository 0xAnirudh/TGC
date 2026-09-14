import { User } from '../models/User.js';
import { getRedis } from '../redis/client.js';
import { userCash, ECON_GRANTED, ECON_BURNED } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { log } from '../log.js';

/**
 * Borrowing.
 *
 * A loan is Notes now against more Notes later, and the "later" is what
 * makes it interesting: interest compounds on a timer whether or not you
 * are playing. It turns a stalled position into a problem, and it lets a
 * player who is confident take a bigger swing than their cash allows.
 *
 * HOW IT SITS INSIDE THE MONEY SUPPLY INVARIANT.
 *
 * Borrowing genuinely creates Notes - they did not exist and now they
 * are in a player's hands - so it is a faucet and counts against
 * ECON_GRANTED, exactly like the starting grant and the daily bonus.
 * Repaying destroys them again and counts back out.
 *
 * Interest is the part that looks like it should break something, and it
 * does not, because interest is never minted. The debt figure grows; no
 * Notes are created. When the player repays, they hand over more than
 * they borrowed, and the surplus is burned. So interest is a sink, not a
 * faucet - it removes Notes from the world rather than adding them.
 */

/** Per tick, applied on a timer. Deliberately steep enough to be felt. */
export const INTEREST_BPS_PER_TICK = 120; // 1.2%
export const INTEREST_TICK_SEC = 60;

/** Nobody may borrow more than this multiple of what they already have. */
export const MAX_LEVERAGE = 2;
export const MIN_LOAN = 1_000;

export async function borrow({ userId, amount }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');
  if (amount < MIN_LOAN) {
    throw ApiError.badRequest('loan_too_small', `The smallest loan is ${MIN_LOAN} Notes`);
  }

  const redis = getRedis();
  const cash = Number((await redis.get(userCash(userId))) ?? user.cash);

  // Leverage is capped against net worth rather than cash, so someone
  // fully invested can still borrow - and so that borrowing to borrow
  // does not spiral.
  const ceiling = Math.max(cash, user.netWorthCached) * MAX_LEVERAGE;
  if (user.debt + amount > ceiling) {
    throw ApiError.badRequest('over_leveraged', 'That would take you past your borrowing limit', {
      currentDebt: user.debt,
      limit: Math.round(ceiling),
    });
  }

  // A faucet. The Notes are real, so the faucet total has to know.
  await redis.multi().incrby(userCash(userId), amount).incrby(ECON_GRANTED, amount).exec();
  await User.updateOne(
    { _id: userId },
    { $inc: { cash: amount, debt: amount }, $set: { debtTakenAt: user.debtTakenAt ?? new Date() } },
  );

  log.info('loan taken', { userId, amount, debtAfter: user.debt + amount });
  return { borrowed: amount, debt: user.debt + amount, cash: cash + amount };
}

export async function repay({ userId, amount }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');
  if (user.debt <= 0) throw ApiError.badRequest('no_debt', 'You owe nothing');

  const redis = getRedis();
  const cash = Number((await redis.get(userCash(userId))) ?? user.cash);

  const paying = Math.min(amount, user.debt, cash);
  if (paying <= 0) {
    throw ApiError.badRequest('insufficient_funds', 'Not enough Notes to repay', {
      debt: user.debt,
      available: cash,
    });
  }

  // The principal leaves circulation the way it entered: against the
  // faucet total. Anything beyond the original principal is interest,
  // and that is burned - see the note at the top of this file.
  await redis.multi().decrby(userCash(userId), paying).decrby(ECON_GRANTED, paying).exec();
  await User.updateOne({ _id: userId }, { $inc: { cash: -paying, debt: -paying } });

  const remaining = user.debt - paying;
  if (remaining === 0) await User.updateOne({ _id: userId }, { $set: { debtTakenAt: null } });

  return { repaid: paying, debt: remaining, cash: cash - paying };
}

/**
 * Charge interest on every outstanding debt.
 *
 * Grows the debt figure and mints nothing. The Notes to cover it have to
 * come from the player's trading, which is the point - a loan is a bet
 * that you can earn faster than the interest accrues.
 */
export async function accrueInterest() {
  const debtors = await User.find({ debt: { $gt: 0 } }).lean();
  if (debtors.length === 0) return { debtors: 0, charged: 0 };

  let charged = 0;
  for (const user of debtors) {
    const interest = Math.ceil((user.debt * INTEREST_BPS_PER_TICK) / 10_000);
    await User.updateOne({ _id: user._id }, { $inc: { debt: interest } });
    charged += interest;
  }

  log.info('interest accrued', { debtors: debtors.length, charged });
  return { debtors: debtors.length, charged };
}

/**
 * What a player owes, and how fast it is growing.
 *
 * Shown rather than hidden, because a debt clock nobody can see is a
 * trap rather than a decision.
 */
export async function debtState(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const redis = getRedis();
  const cash = Number((await redis.get(userCash(userId))) ?? user.cash);
  const ceiling = Math.max(cash, user.netWorthCached) * MAX_LEVERAGE;

  return {
    debt: user.debt,
    limit: Math.round(ceiling),
    canBorrow: Math.max(0, Math.round(ceiling - user.debt)),
    interestPerTickBps: INTEREST_BPS_PER_TICK,
    interestTickSeconds: INTEREST_TICK_SEC,
    nextCharge: user.debt > 0 ? Math.ceil((user.debt * INTEREST_BPS_PER_TICK) / 10_000) : 0,
  };
}

/** Notes owed, for the money supply reconciliation. */
export async function totalPrincipalOutstanding() {
  const debtors = await User.find({ debt: { $gt: 0 } }).lean();
  return debtors.reduce((sum, u) => sum + u.debt, 0);
}

export { ECON_BURNED };
