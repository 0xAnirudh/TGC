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

/** A player's cash. Becomes the source of truth in Phase 5. */
export const userCash = (userId) => `user:${userId}:cash`;

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
