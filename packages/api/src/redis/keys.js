/**
 * Every Redis key the system uses, in one place.
 *
 * Keys are built through these functions and never by string
 * concatenation at the call site. The reason is Phase 6: the rebuild
 * path has to know the complete set of keys that make up market state in
 * order to reconstruct it, and a key format invented inline in some
 * route is a key the rebuild will silently miss.
 */

/** Live supply of a good. Written only by trade.lua from Phase 5. */
export const goodSupply = (goodId) => `mkt:${goodId}:supply`;

/** Live base price of a good. Moved by the drift job from Phase 8. */
export const goodBasePrice = (goodId) => `mkt:${goodId}:basePrice`;

/**
 * A good's immutable identity and curve shape: name, colour, k, n.
 *
 * Cached in Redis because it is needed on both hot paths - a quote and a
 * trade both have to know k and n - and reading it from Mongo put an
 * Atlas round trip in front of an operation that is otherwise pure
 * arithmetic on two Redis values.
 *
 * That was not a theoretical cost. Load testing showed quote p95 at
 * 827ms against a p50 of 42ms: the tail was entirely the database. NFR-1
 * asks for p95 under 10ms, and no amount of tuning gets there with a
 * network hop in the path.
 *
 * Safe to cache indefinitely because none of these fields ever change
 * after the good is created. There is no invalidation problem because
 * there is nothing to invalidate.
 */
export const goodMeta = (goodId) => `good:${goodId}:meta`;

/** A player's cash. The source of truth from Phase 5 onward. */
export const userCash = (userId) => `user:${userId}:cash`;

/**
 * A player's holdings, as a hash of goodId -> quantity.
 *
 * These live in Redis for the same reason cash does: a sell has to check
 * and decrement them inside the same atomic block that moves supply.
 * Checking holdings in Mongo and then mutating Redis would leave exactly
 * the gap Phase 5 exists to close - two concurrent sells could both pass
 * the check and both succeed.
 */
export const userHoldings = (userId) => `user:${userId}:holdings`;

/**
 * Running total of every Note ever granted.
 *
 * This is the faucet side of the money supply invariant. Without a
 * durable count of what was handed out, `granted == cash + reserve +
 * burned` cannot be checked at all - there is nothing to compare
 * against. Incremented on registration and on the daily bonus.
 */
export const ECON_GRANTED = 'econ:granted';

/** Notes taken in by the curve. The reserve term of the invariant. */
export const ECON_RESERVE = 'econ:reserve';

/** Notes destroyed by the sell spread. The sink term. */
export const ECON_BURNED = 'econ:burned';

/** The durable ledger head. Phase 6. */
export const STREAM_TRADES = 'stream:trades';

/** Net worth leaderboard sorted set. Phase 10. */
export const LB_NETWORTH = 'lb:networth';

/** Per-user trade rate limit bucket. Phase 7. */
export const rateLimitTrade = (userId) => `rl:trade:${userId}`;

/** Per-IP auth rate limit window. Phase 7. */
export const rateLimitAuth = (ip) => `rl:auth:${ip}`;
