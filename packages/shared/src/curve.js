import { BPS, SELL_SPREAD_BPS } from './constants.js';

/**
 * The bonding curve.
 *
 *     price(s) = basePrice * (1 + s / k) ^ n
 *
 * `basePrice` is the price at zero supply, and is the only term that
 * drifts over time. `k` is the supply scale: how much supply it takes to
 * meaningfully move the price. `n` is the steepness exponent, chosen by
 * the issuer within a bounded band.
 *
 * There is no order book and no counterparty. The curve *is* the
 * counterparty: a buy pushes supply up the curve and the price with it,
 * a sell pushes both back down. This removes matching, partial fills,
 * and bid/ask management entirely while keeping prices genuinely
 * player-driven.
 *
 * Money is whole integer Notes. Prices are computed in floating point
 * and every Note amount that crosses a player boundary is rounded in the
 * direction that favours the system - up on what a player pays, down on
 * what a player receives. Rounding can therefore never mint a Note.
 */

/**
 * Spot price at a given supply. This is the marginal price of the next
 * unit, not the price of a whole order - an order of any size walks the
 * curve and pays the integral. Use it for display, never for execution.
 */
export function price(basePrice, supply, k, n) {
  assertCurve(basePrice, supply, k, n);
  return basePrice * Math.pow(1 + supply / k, n);
}

function assertCurve(basePrice, supply, k, n) {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new RangeError(`basePrice must be a positive finite number, got ${basePrice}`);
  }
  if (!Number.isFinite(supply) || supply < 0) {
    throw new RangeError(`supply must be a non-negative finite number, got ${supply}`);
  }
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`k must be a positive finite number, got ${k}`);
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`n must be a non-negative finite number, got ${n}`);
  }
}

export { assertCurve };
