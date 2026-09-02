import { BPS, MAX_TRADE_SUPPLY_BPS } from './constants.js';

/**
 * Largest quantity a single trade may move.
 *
 * Capped as a share of current supply so no one account can walk a thin
 * good to an absurd price in one request. The floor exists so a good
 * with zero supply can still be bootstrapped - a pure percentage cap
 * would make the first buy of every new good impossible.
 */
export const BOOTSTRAP_TRADE_QTY = 100;

export function maxTradeQty(supply) {
  return Math.max(BOOTSTRAP_TRADE_QTY, Math.floor((supply * MAX_TRADE_SUPPLY_BPS) / BPS));
}
