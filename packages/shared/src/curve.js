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

/**
 * Antiderivative of the price function with respect to supply:
 *
 *     F(s) = basePrice * k / (n + 1) * (1 + s / k) ^ (n + 1)
 *
 * The cost of moving supply from a to b is exactly F(b) - F(a). Having a
 * closed form matters: execution must be a handful of arithmetic ops
 * inside a Lua script, not a numeric integration loop.
 */
function integral(basePrice, supply, k, n) {
  return ((basePrice * k) / (n + 1)) * Math.pow(1 + supply / k, n + 1);
}

/**
 * Notes required to buy `qty` units when current supply is `supply`.
 *
 * Rounded up, so the player never pays less than the curve says.
 */
export function buyCost(basePrice, supply, qty, k, n) {
  assertCurve(basePrice, supply, k, n);
  assertQty(qty);
  const raw =
    integral(basePrice, supply + qty, k, n) - integral(basePrice, supply, k, n);
  return Math.ceil(raw);
}

/**
 * Notes a sale of `qty` units is worth before the spread is taken.
 *
 * Rounded down, so the player never receives more than the curve says.
 * Selling walks the curve backwards from `supply` to `supply - qty`, so
 * the seller is paid the same integral the last buyer paid in - minus
 * whatever drift has happened to basePrice since.
 */
export function grossSellValue(basePrice, supply, qty, k, n) {
  assertCurve(basePrice, supply, k, n);
  assertQty(qty);
  if (qty > supply) {
    throw new RangeError(`cannot sell ${qty} units into a supply of ${supply}`);
  }
  const raw =
    integral(basePrice, supply, k, n) - integral(basePrice, supply - qty, k, n);
  return Math.floor(raw);
}

/**
 * Notes the curve has taken in to reach `supply` from zero.
 *
 * This is the reserve the curve would owe if every holder sold at once
 * and basePrice had never drifted. The running system does not compute
 * the reserve this way - it tracks it as an explicit accumulator, because
 * drift moves the curve out from under the Notes already paid in. This
 * function is the cross-check that the two agree when drift is off.
 */
export function reserveAt(basePrice, supply, k, n) {
  assertCurve(basePrice, supply, k, n);
  return integral(basePrice, supply, k, n) - integral(basePrice, 0, k, n);
}

function assertQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new RangeError(`qty must be a positive integer, got ${qty}`);
  }
}
