import { User } from '../models/User.js';
import { Good } from '../models/Good.js';
import { getRedis } from '../redis/client.js';
import { LB_NETWORTH, userCash, userHoldings, goodSupply, goodBasePrice } from '../redis/keys.js';
import { log } from '../log.js';
import { sellBreakdown, maxTradeQty, REGIONS } from '@tgc/shared';

/**
 * Net worth leaderboard.
 *
 * v1 has exactly one board. The gain-percent, issuer and firm boards are
 * deferred - see IMPLEMENTATION_PLAN.md section 26.8.
 *
 * The board is recomputed on a schedule and served from a Redis sorted
 * set. It is never computed on request, and that is not an optimisation
 * detail - valuing one player's net worth means pricing every holding
 * against the curve, so computing the board per request would make its
 * cost scale with both player count and page views at once, on the
 * request path.
 *
 * A sorted set makes the read O(log N) and the write somebody else's
 * problem.
 */

/** What a player's holdings would fetch if sold right now. */
async function valueHoldings(userId, goodsById) {
  const redis = getRedis();
  const held = await redis.hgetall(userHoldings(userId));
  const entries = Object.entries(held).filter(([, q]) => Number(q) > 0);
  if (entries.length === 0) return 0;

  // Cargo is valued at the best price any market would pay for it, since
  // that is what it is actually worth to a player who can travel.
  const keys = entries.flatMap(([goodId]) =>
    REGIONS.flatMap((r) => [goodSupply(goodId, r.id), goodBasePrice(goodId, r.id)]),
  );
  const live = await redis.mget(...keys);
  const perGood = REGIONS.length * 2;

  let total = 0;
  entries.forEach(([goodId, qtyRaw], i) => {
    const good = goodsById.get(goodId);
    if (!good) return;

    const quantity = Number(qtyRaw);

    // Best of the four markets.
    let supply = NaN;
    let basePrice = NaN;
    let best = -1;
    for (let r = 0; r < REGIONS.length; r += 1) {
      const s = Number(live[i * perGood + r * 2]);
      const b = Number(live[i * perGood + r * 2 + 1]);
      if (!Number.isFinite(s) || !Number.isFinite(b)) continue;
      const sellable = Math.min(quantity, s, maxTradeQty(s));
      if (sellable <= 0) continue;
      const worth = sellBreakdown(b, s, sellable, good.k, good.n).net / sellable;
      if (worth > best) {
        best = worth;
        supply = s;
        basePrice = b;
      }
    }
    if (!Number.isFinite(supply) || !Number.isFinite(basePrice)) return;

    // Valued at what selling would actually return - spread taken, curve
    // walked down. Marking at spot price times quantity would overstate
    // every position on the board.
    //
    // A position larger than one trade may move is valued by pricing the
    // largest legal slice and scaling. It overstates a very large holding
    // slightly, since later slices would sell into a lower price, but the
    // alternative is simulating the whole unwind per player per tick.
    const sellable = Math.min(quantity, supply, maxTradeQty(supply));
    if (sellable <= 0) return;

    const slice = sellBreakdown(basePrice, supply, sellable, good.k, good.n).net;
    total += Math.round((slice / sellable) * quantity);
  });

  return total;
}

export async function revalueAll() {
  const started = Date.now();
  const redis = getRedis();

  const [users, goods] = await Promise.all([User.find().lean(), Good.find().lean()]);
  const goodsById = new Map(goods.map((g) => [g._id.toString(), g]));

  const scored = [];
  for (const user of users) {
    const id = user._id.toString();
    const cashRaw = await redis.get(userCash(id));
    // A player who has never traded has no Redis cash key yet; their
    // Mongo balance is still correct.
    const cash = cashRaw === null ? user.cash : Number(cashRaw);
    const holdingsValue = await valueHoldings(id, goodsById);
    scored.push({ id, netWorth: cash + holdingsValue });
  }

  if (scored.length > 0) {
    await redis.zadd(LB_NETWORTH, ...scored.flatMap((s) => [s.netWorth, s.id]));
    await Promise.all(
      scored.map((s) =>
        User.updateOne(
          { _id: s.id },
          { $set: { netWorthCached: s.netWorth, netWorthAt: new Date() } },
        ),
      ),
    );
  }

  log.info('revaluation complete', { players: scored.length, ms: Date.now() - started });
  return { players: scored.length, ms: Date.now() - started };
}

/** Top N by net worth, read straight from the sorted set. */
export async function topByNetWorth(limit = 50) {
  const redis = getRedis();
  const rows = await redis.zrevrange(LB_NETWORTH, 0, limit - 1, 'WITHSCORES');

  const ids = [];
  const scoreById = new Map();
  for (let i = 0; i < rows.length; i += 2) {
    ids.push(rows[i]);
    scoreById.set(rows[i], Number(rows[i + 1]));
  }
  if (ids.length === 0) return [];

  const users = await User.find({ _id: { $in: ids } }).lean();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));

  return ids
    .map((id, index) => {
      const user = byId.get(id);
      if (!user) return null;
      return { rank: index + 1, username: user.username, netWorth: scoreById.get(id) };
    })
    .filter(Boolean);
}

/** One player's rank, or null if the board has not been built yet. */
export async function rankOf(userId) {
  const rank = await getRedis().zrevrank(LB_NETWORTH, userId.toString());
  return rank === null ? null : rank + 1;
}
