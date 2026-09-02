import { describe, it, expect } from 'vitest';
import { buyCost, sellReturn, STARTING_GRANT } from '@tgc/shared';
import { Economy } from '../../sim/src/economy.js';
import { makeRandom } from '../../sim/src/random.js';

/**
 * The most important property in the system: you cannot make money by
 * trading against yourself.
 *
 * If an immediate round trip were ever profitable, the curve would be a
 * money printer and every other guarantee in the project - atomicity,
 * durability, conservation - would be protecting a broken economy very
 * carefully. This is the reason Phase 0 exists before any server code.
 */

const BASE_PRICES = [10, 45, 100, 500, 2_000];
const KS = [500, 3_000, 10_000, 25_000];
const NS = [1, 2, 3];
const SUPPLIES = [0, 1, 250, 5_000, 40_000];
const QTYS = [1, 3, 50, 400, 2_500];

describe('round trip is strictly lossy', () => {
  it('buy then immediately sell back, across the whole parameter band', () => {
    let checked = 0;
    for (const basePrice of BASE_PRICES) {
      for (const k of KS) {
        for (const n of NS) {
          for (const supply of SUPPLIES) {
            for (const qty of QTYS) {
              const cost = buyCost(basePrice, supply, qty, k, n);
              const back = sellReturn(basePrice, supply + qty, qty, k, n);
              expect(
                back,
                `profitable round trip: basePrice=${basePrice} k=${k} n=${n} ` +
                  `supply=${supply} qty=${qty} cost=${cost} back=${back}`,
              ).toBeLessThan(cost);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(
      BASE_PRICES.length * KS.length * NS.length * SUPPLIES.length * QTYS.length,
    );
  });

  it('sell then immediately buy back is also lossy', () => {
    // The mirror image. A holder who sells and changes their mind walks
    // the same stretch of curve in the other order and still pays the
    // spread once.
    for (const k of KS) {
      for (const n of NS) {
        const supply = 10_000;
        for (const qty of [1, 50, 400, 2_500]) {
          const received = sellReturn(100, supply, qty, k, n);
          const buyBack = buyCost(100, supply - qty, qty, k, n);
          expect(received).toBeLessThan(buyBack);
        }
      }
    }
  });

  it('splitting the round trip into chunks does not escape the spread', () => {
    // A player might hope that many small trades round in their favour
    // often enough to beat one large one. Directional rounding means
    // every chunk rounds against them instead.
    const k = 8_000;
    const n = 2;
    let supply = 12_000;
    const startSupply = supply;
    let spent = 0;

    for (let i = 0; i < 20; i += 1) {
      spent += buyCost(150, supply, 25, k, n);
      supply += 25;
    }
    let recovered = 0;
    for (let i = 0; i < 20; i += 1) {
      recovered += sellReturn(150, supply, 25, k, n);
      supply -= 25;
    }

    expect(supply).toBe(startSupply);
    expect(recovered).toBeLessThan(spent);
  });

  it('leaves a player poorer after any random sequence of round trips', () => {
    const economy = new Economy();
    economy.addGood('g', { basePrice: 120, k: 9_000, n: 2 });
    economy.addPlayer('solo', STARTING_GRANT);
    const rng = makeRandom(7);

    for (let i = 0; i < 200; i += 1) {
      const qty = rng.int(1, 80);
      if (!economy.buy('solo', 'g', qty).ok) continue;
      economy.sell('solo', 'g', qty);
    }

    expect(economy.held('solo', 'g')).toBe(0);
    expect(economy.goods.get('g').supply).toBe(0);
    expect(economy.players.get('solo').cash).toBeLessThan(STARTING_GRANT);
    expect(economy.checkInvariants()).toEqual([]);
  });
});
