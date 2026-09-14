import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { User } from '../models/User.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice, userCash, ECON_BURNED } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';
import { ensureAccountLoaded } from './accounts.js';
import { log } from '../log.js';
import { MIN_CURVE_N, MAX_CURVE_N, MIN_CURVE_K } from '@tgc/shared';

/**
 * Player-issued goods.
 *
 * v1 is flat fee only. No royalty, no issuer lock, no free allocation -
 * see IMPLEMENTATION_PLAN.md section 26.7 for what v2 adds and why.
 *
 * TWO REASONS THE ISSUER GETS NO ALLOCATION.
 *
 * The economic one: a free allocation is a mint. It creates value out of
 * nothing and hands it to one player, who can then sell it into demand
 * other players generated. Every issued good would be an exit-liquidity
 * trap, and the money supply invariant would need a term for value that
 * was never granted or earned.
 *
 * The structural one, found in Phase 6: supply that no trade created is
 * not reconstructable. The rebuild derives supply from the ledger alone,
 * so an initial allocation would be silently erased the first time
 * anyone ran it (FINDING-007). Even if the economics were acceptable,
 * the durability model would not survive it.
 *
 * So a new good starts at zero supply and the issuer buys on the same
 * curve as everyone else, from the same starting point.
 */

export const ISSUE_FEE = 25_000;

/** FR-5.1 - who may issue. */
export const GATE = {
  minNetWorth: 120_000,
  minAccountAgeDays: 1,
  minTradeCount: 10,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function checkGate(user) {
  const ageDays = (Date.now() - user.createdAt.getTime()) / DAY_MS;
  const failures = [];

  if (user.netWorthCached < GATE.minNetWorth) {
    failures.push({
      requirement: 'netWorth',
      need: GATE.minNetWorth,
      have: user.netWorthCached,
    });
  }
  if (ageDays < GATE.minAccountAgeDays) {
    failures.push({
      requirement: 'accountAgeDays',
      need: GATE.minAccountAgeDays,
      have: Math.floor(ageDays * 100) / 100,
    });
  }
  if (user.tradeCount < GATE.minTradeCount) {
    failures.push({ requirement: 'tradeCount', need: GATE.minTradeCount, have: user.tradeCount });
  }

  return failures;
}

export async function issueGood({ userId, name, colorToken, k, n, basePrice }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('account_missing', 'Account no longer exists');

  const failures = checkGate(user);
  if (failures.length > 0) {
    throw ApiError.forbidden('issuance_gate', 'You do not yet meet the requirements to issue');
  }

  // Bounds belong here as well as in the schema. The schema stops a bad
  // request; this stops a bad good, and the two are different jobs - a
  // future admin path or seed script must not be able to create a good
  // outside the band either.
  if (n < MIN_CURVE_N || n > MAX_CURVE_N) {
    throw ApiError.badRequest(
      'curve_out_of_band',
      `n must be between ${MIN_CURVE_N} and ${MAX_CURVE_N}`,
    );
  }
  if (k < MIN_CURVE_K) {
    throw ApiError.badRequest('curve_out_of_band', `k must be at least ${MIN_CURVE_K}`);
  }

  const nameLower = name.toLowerCase();
  if (await Good.findOne({ nameLower })) {
    throw ApiError.conflict('good_name_taken', 'A good with that name already exists');
  }

  await ensureAccountLoaded(userId);

  // Charge before creating. If the fee fails there is no good, and if
  // creation fails afterwards the fee has been burned for nothing - the
  // lesser of the two, and recoverable by hand. The alternative ordering
  // gives away a free good whenever the charge fails.
  const [status, ...rest] = await getRedis().issue(userCash(userId), ECON_BURNED, ISSUE_FEE);

  if (status === 'error') {
    const [code, need, have] = rest;
    if (code === 'insufficient_funds') {
      throw ApiError.badRequest('insufficient_funds', 'Not enough Notes to pay the issuing fee', {
        required: Number(need),
        available: Number(have),
      });
    }
    throw ApiError.badRequest(code, 'Could not charge the issuing fee');
  }

  const cashAfter = Number(rest[0]);

  const good = await Good.create({ name, nameLower, colorToken, issuerId: user._id, k, n });
  await Market.create({ goodId: good._id, basePrice, supply: 0, vol24h: 0 });

  const id = good._id.toString();
  await getRedis().mset(goodSupply(id), 0, goodBasePrice(id), basePrice);
  await User.updateOne({ _id: userId }, { $set: { cash: cashAfter } });

  log.info('good issued', { name, issuer: user.username, fee: ISSUE_FEE });

  return { good, cash: cashAfter, fee: ISSUE_FEE };
}
