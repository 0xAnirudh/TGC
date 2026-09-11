import { User } from '../models/User.js';
import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { Trade } from '../models/Trade.js';
import { getRedis } from '../redis/client.js';
import {
  goodSupply,
  goodBasePrice,
  userCash,
  userHoldings,
  ECON_GRANTED,
  ECON_RESERVE,
  ECON_BURNED,
} from '../redis/keys.js';
import { log } from '../log.js';

/**
 * Reconstruct the entire live market from the Mongo ledger.
 *
 * This is two things at once, and the second is the more valuable:
 *
 *   1. The disaster recovery path. Redis holds supply, cash and
 *      holdings; if it is lost, this puts them back.
 *
 *   2. The proof that the ledger is honest. If replaying every trade in
 *      order reproduces the exact state the live system had, then the
 *      ledger really does contain everything that happened - no trade
 *      was missed, none was double-counted, and the running state was
 *      never quietly edited by anything other than a trade.
 *
 * Nothing here reads Redis. It starts from Mongo alone and writes the
 * result, which is what makes it a genuine reconstruction rather than a
 * repair.
 *
 * Trades replay in stream-id order. Redis stream ids are
 * `<millis>-<sequence>`, monotonically increasing, so that ordering is
 * the true execution order - not `createdAt`, which can tie.
 */
export async function rebuildFromLedger({ dryRun = false } = {}) {
  const started = Date.now();

  const [users, goods, markets] = await Promise.all([
    User.find().lean(),
    Good.find().lean(),
    Market.find().lean(),
  ]);

  // Every account starts from its grant. This is the faucet side of the
  // money supply invariant.
  const cash = new Map();
  let granted = 0;
  for (const u of users) {
    cash.set(u._id.toString(), u.startingGrant);
    granted += u.startingGrant;
  }

  // Every good starts at zero supply, whatever Mongo's cached copy says.
  // Trusting the cached supply would defeat the point - the whole claim
  // is that supply is derivable from the trades alone.
  const supply = new Map();
  for (const g of goods) supply.set(g._id.toString(), 0);

  const basePrice = new Map();
  for (const m of markets) basePrice.set(m.goodId.toString(), m.basePrice);

  const holdings = new Map(); // userId -> Map(goodId -> qty)
  let reserve = 0;
  let burned = 0;

  const trades = await Trade.find().sort({ streamId: 1 }).lean();

  for (const t of trades) {
    const uid = t.userId.toString();
    const gid = t.goodId.toString();
    if (!holdings.has(uid)) holdings.set(uid, new Map());
    const userHeld = holdings.get(uid);

    if (t.side === 'buy') {
      cash.set(uid, (cash.get(uid) ?? 0) - t.notional);
      supply.set(gid, (supply.get(gid) ?? 0) + t.quantity);
      userHeld.set(gid, (userHeld.get(gid) ?? 0) + t.quantity);
      reserve += t.notional;
    } else {
      cash.set(uid, (cash.get(uid) ?? 0) + t.notional);
      supply.set(gid, (supply.get(gid) ?? 0) - t.quantity);
      userHeld.set(gid, (userHeld.get(gid) ?? 0) - t.quantity);
      // The curve paid out the gross; the spread was skimmed off it and
      // burned. gross === notional + spread.
      reserve -= t.notional + t.spread;
      burned += t.spread;
    }
  }

  const state = { cash, supply, basePrice, holdings, granted, reserve, burned };
  const summary = {
    users: users.length,
    goods: goods.length,
    trades: trades.length,
    granted,
    reserve,
    burned,
    ms: Date.now() - started,
  };

  if (dryRun) return { state, summary, written: false };

  await writeToRedis(state);
  log.info('rebuild complete', summary);
  return { state, summary, written: true };
}

async function writeToRedis(state) {
  const redis = getRedis();
  const tx = redis.multi();

  for (const [goodId, value] of state.supply) tx.set(goodSupply(goodId), value);
  for (const [goodId, value] of state.basePrice) tx.set(goodBasePrice(goodId), value);
  for (const [userId, value] of state.cash) tx.set(userCash(userId), value);

  for (const [userId, held] of state.holdings) {
    tx.del(userHoldings(userId));
    const pairs = [...held].filter(([, q]) => q > 0).flatMap(([g, q]) => [g, q]);
    if (pairs.length > 0) tx.hset(userHoldings(userId), ...pairs);
  }

  tx.set(ECON_GRANTED, state.granted);
  tx.set(ECON_RESERVE, state.reserve);
  tx.set(ECON_BURNED, state.burned);

  await tx.exec();
}

/**
 * Snapshot every key the rebuild is responsible for.
 *
 * Used by the rebuild test: snapshot, flush, rebuild, compare. If the
 * two snapshots differ anywhere, the ledger does not contain everything
 * that happened.
 */
export async function snapshotState() {
  const redis = getRedis();
  const [users, goods] = await Promise.all([User.find().lean(), Good.find().lean()]);
  const snapshot = {};

  for (const g of goods) {
    const id = g._id.toString();
    const [s, b] = await redis.mget(goodSupply(id), goodBasePrice(id));
    snapshot[goodSupply(id)] = s;
    snapshot[goodBasePrice(id)] = b;
  }

  for (const u of users) {
    const id = u._id.toString();
    snapshot[userCash(id)] = await redis.get(userCash(id));
    const held = await redis.hgetall(userHoldings(id));
    // Drop zero-quantity fields so a holding sold down to nothing
    // compares equal to one that never existed.
    snapshot[userHoldings(id)] = Object.fromEntries(
      Object.entries(held).filter(([, q]) => Number(q) !== 0),
    );
  }

  const [granted, reserve, burned] = await redis.mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);
  snapshot[ECON_GRANTED] = granted;
  snapshot[ECON_RESERVE] = reserve;
  snapshot[ECON_BURNED] = burned;

  return snapshot;
}
