/**
 * Every Redis key the system uses, in one place.
 *
 * Keys are built through these functions and never by string
 * concatenation at the call site. The reason is Phase 6: the rebuild
 * path has to know the complete set of keys that make up market state in
 * order to reconstruct it, and a key format invented inline in some
 * route is a key the rebuild will silently miss.
 */

/**
 * Live supply and base price, PER REGION.
 *
 * Each region holds its own position on the curve, so the same good can
 * be cheap in one place and dear in another. See shared/regions.js for
 * why this is separate supply rather than a price multiplier - the short
 * version is that a multiplier lets arbitrage take more out of the curve
 * reserve than was paid in, which mints Notes.
 */
export const goodSupply = (goodId, region) => `mkt:${goodId}:${region}:supply`;
export const goodBasePrice = (goodId, region) => `mkt:${goodId}:${region}:basePrice`;

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
 * Where a player is, and when they arrive if they are in transit.
 *
 * Held in Redis because the trade path needs the location on every
 * request to know which region's prices apply, and that is not worth a
 * Mongo read. The User document keeps the durable copy.
 */
export const userLocation = (userId) => `user:${userId}:location`;
export const userArrivesAt = (userId) => `user:${userId}:arrivesAt`;

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

/** Net worth leaderboard sorted set. Phase 10. */
export const LB_NETWORTH = 'lb:networth';

/** Per-user trade rate limit bucket. Phase 7. */
export const rateLimitTrade = (userId) => `rl:trade:${userId}`;

/** Per-IP auth rate limit window. Phase 7. */
export const rateLimitAuth = (ip) => `rl:auth:${ip}`;
