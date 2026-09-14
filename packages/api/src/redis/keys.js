/**
 * Every Redis key the application uses, in one place.
 *
 * Built through functions rather than by concatenation at the call site,
 * so the complete set of keys a run occupies is knowable - which is what
 * lets a finished run be torn down cleanly and a stale one expire.
 */

/** Per-user trade rate limit bucket. */
export const rateLimitTrade = (userId) => `rl:trade:${userId}`;

/** Per-IP auth rate limit window. */
export const rateLimitAuth = (ip) => `rl:auth:${ip}`;

export * from './runKeys.js';
