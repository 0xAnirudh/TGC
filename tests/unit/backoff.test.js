import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../../packages/api/src/util/backoff.js';

describe('backoffDelay', () => {
  const always = (v) => () => v;

  it('grows exponentially from the base', () => {
    const full = (attempt) => backoffDelay(attempt, { random: always(0.999999) });
    expect(full(0)).toBe(249);
    expect(full(1)).toBe(499);
    expect(full(2)).toBe(999);
    expect(full(3)).toBe(1_999);
  });

  it('never exceeds the ceiling', () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      expect(backoffDelay(attempt, { random: always(0.999999) })).toBeLessThan(30_000);
    }
  });

  it('does not overflow on a very long outage', () => {
    // A store down for hours must not produce a negative or absurd delay
    // through exponent overflow.
    const delay = backoffDelay(10_000, { random: always(0.5) });
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(30_000);
  });

  it('spreads retries across the window rather than clustering', () => {
    // The point of full jitter: many instances failing together must not
    // retry together.
    const samples = Array.from({ length: 2_000 }, () => backoffDelay(6));
    const ceiling = Math.min(30_000, 250 * 2 ** 6);
    const buckets = new Array(10).fill(0);
    for (const s of samples) buckets[Math.min(9, Math.floor((s / ceiling) * 10))] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(50);
  });

  it('rejects a nonsense attempt number', () => {
    expect(() => backoffDelay(-1)).toThrow(RangeError);
    expect(() => backoffDelay(1.5)).toThrow(RangeError);
  });
});
