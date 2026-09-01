// Economic constants.
//
// These are the tuning knobs of the entire economy. Every one of them is
// exercised by the Phase 0 simulation before any server code depends on
// it. Changing one of these changes the game; changing one without
// re-running the simulation is how an economy quietly breaks.

/** Basis-points denominator. Every rate in the system is expressed in bps. */
export const BPS = 10_000;

/**
 * Spread taken on every sell, burned out of circulation.
 *
 * This is the single sink that makes churn unprofitable. Without it, a
 * player could buy and immediately sell for exactly what they paid, and
 * the only cost of manipulating a price would be opportunity cost.
 */
export const SELL_SPREAD_BPS = 200; // 2%

/** One-time grant handed to every new account. Notes are whole integers. */
export const STARTING_GRANT = 100_000;

/**
 * A single trade may not move more than this share of current supply.
 *
 * Without a cap, one large account can walk a thin good to an absurd
 * price in a single request, which is both bad play and a bad load
 * profile.
 */
export const MAX_TRADE_SUPPLY_BPS = 1_000; // 10%

/** Bounds on the issuer-chosen curve steepness exponent `n`. */
export const MIN_CURVE_N = 1;
export const MAX_CURVE_N = 3;

/** Floor on the supply scale `k`. Small k means a violently steep good. */
export const MIN_CURVE_K = 100;
