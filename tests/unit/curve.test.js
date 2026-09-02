import { describe, it, expect } from 'vitest';
import {
  price,
  buyCost,
  grossSellValue,
  sellReturn,
  sellBreakdown,
  reserveAt,
  BPS,
  SELL_SPREAD_BPS,
} from '@tgc/shared';

const G = { basePrice: 100, k: 10_000, n: 2 };

describe('price', () => {
  it('equals basePrice at zero supply', () => {
    expect(price(G.basePrice, 0, G.k, G.n)).toBe(G.basePrice);
  });

  it('is (1 + s/k)^n times basePrice', () => {
    // At s === k the bracket is exactly 2, so the price is basePrice * 2^n.
    expect(price(100, 10_000, 10_000, 2)).toBeCloseTo(400, 9);
    expect(price(100, 10_000, 10_000, 3)).toBeCloseTo(800, 9);
    expect(price(100, 10_000, 10_000, 1)).toBeCloseTo(200, 9);
  });

  it('rises monotonically with supply', () => {
    let last = 0;
    for (let s = 0; s <= 50_000; s += 500) {
      const p = price(G.basePrice, s, G.k, G.n);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
  });

  it('rejects nonsense inputs', () => {
    expect(() => price(0, 0, G.k, G.n)).toThrow(RangeError);
    expect(() => price(G.basePrice, -1, G.k, G.n)).toThrow(RangeError);
    expect(() => price(G.basePrice, 0, 0, G.n)).toThrow(RangeError);
    expect(() => price(G.basePrice, 0, G.k, -1)).toThrow(RangeError);
  });
});

describe('buyCost', () => {
  it('matches a numeric integration of the price function', () => {
    const supply = 4_000;
    const qty = 600;
    const steps = 200_000;
    let numeric = 0;
    for (let i = 0; i < steps; i += 1) {
      numeric += price(G.basePrice, supply + (qty * (i + 0.5)) / steps, G.k, G.n) * (qty / steps);
    }
    // buyCost rounds up, so it sits within one Note above the true integral.
    const cost = buyCost(G.basePrice, supply, qty, G.k, G.n);
    expect(cost - numeric).toBeGreaterThanOrEqual(0);
    expect(cost - numeric).toBeLessThan(1.001);
  });

  it('costs more than quantity times spot, because the order walks the curve', () => {
    const supply = 4_000;
    const qty = 600;
    const spot = price(G.basePrice, supply, G.k, G.n);
    expect(buyCost(G.basePrice, supply, qty, G.k, G.n)).toBeGreaterThan(spot * qty);
  });

  it('gets more expensive as supply rises', () => {
    const cheap = buyCost(G.basePrice, 1_000, 100, G.k, G.n);
    const dear = buyCost(G.basePrice, 40_000, 100, G.k, G.n);
    expect(dear).toBeGreaterThan(cheap);
  });

  it('rounds up, so a buyer never pays less than the curve says', () => {
    const cost = buyCost(G.basePrice, 333, 7, G.k, G.n);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('rejects non-positive and fractional quantities', () => {
    expect(() => buyCost(G.basePrice, 0, 0, G.k, G.n)).toThrow(RangeError);
    expect(() => buyCost(G.basePrice, 0, 1.5, G.k, G.n)).toThrow(RangeError);
  });
});

describe('grossSellValue', () => {
  it('walks the same stretch of curve a buy walked, so it recovers the cost', () => {
    const supply = 5_000;
    const qty = 400;
    const cost = buyCost(G.basePrice, supply, qty, G.k, G.n);
    const gross = grossSellValue(G.basePrice, supply + qty, qty, G.k, G.n);
    // Identical integrals, differing only by directional rounding.
    expect(cost - gross).toBeLessThanOrEqual(1);
    expect(cost - gross).toBeGreaterThanOrEqual(0);
  });

  it('refuses to sell more than exists', () => {
    expect(() => grossSellValue(G.basePrice, 100, 101, G.k, G.n)).toThrow(RangeError);
  });
});

describe('sellBreakdown', () => {
  it('splits the gross exactly, with nothing lost between the terms', () => {
    for (const supply of [500, 5_000, 50_000]) {
      for (const qty of [1, 7, 250, 500]) {
        const { gross, spread, net } = sellBreakdown(G.basePrice, supply, qty, G.k, G.n);
        expect(net + spread).toBe(gross);
        expect(Number.isInteger(net)).toBe(true);
        expect(Number.isInteger(spread)).toBe(true);
      }
    }
  });

  it('takes the configured spread', () => {
    const { gross, spread } = sellBreakdown(G.basePrice, 20_000, 500, G.k, G.n);
    expect(spread / gross).toBeCloseTo(SELL_SPREAD_BPS / BPS, 4);
  });

  it('sellReturn is the net leg of the breakdown', () => {
    const b = sellBreakdown(G.basePrice, 20_000, 500, G.k, G.n);
    expect(sellReturn(G.basePrice, 20_000, 500, G.k, G.n)).toBe(b.net);
  });
});

describe('reserveAt', () => {
  it('is zero at zero supply', () => {
    expect(reserveAt(G.basePrice, 0, G.k, G.n)).toBeCloseTo(0, 9);
  });

  it('equals the cost of buying the whole supply from nothing', () => {
    const supply = 12_345;
    // reserveAt is the raw integral; buyCost is the same integral rounded up.
    expect(Math.ceil(reserveAt(G.basePrice, supply, G.k, G.n))).toBe(
      buyCost(G.basePrice, 0, supply, G.k, G.n),
    );
  });
});
