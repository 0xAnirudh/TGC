import { describe, it, expect } from 'vitest';
import { Economy } from '../../sim/src/economy.js';
import { makeRandom } from '../../sim/src/random.js';
import { buyCost, maxTradeQty, STARTING_GRANT } from '@tgc/shared';

/**
 * Money supply conservation.
 *
 *     granted === cash + reserve + burned
 *
 * Notes enter only through grants and leave only through the spread
 * burn. Everything in between is movement, not creation. This must hold
 * to the exact Note at every instant, not approximately and not on
 * average - an economy that leaks a Note per thousand trades is an
 * economy with an exploit that has not been found yet.
 *
 * NFR-5 in the implementation plan is this test.
 */

const GOODS = [
  { id: 'iron', basePrice: 60, k: 20_000, n: 1 },
  { id: 'copper', basePrice: 120, k: 12_000, n: 2 },
  { id: 'saffron', basePrice: 500, k: 3_000, n: 3 },
];

function churn(seed, { players = 40, trades = 3_000 } = {}) {
  const economy = new Economy({ seed });
  for (const g of GOODS) economy.addGood(g.id, g);
  for (let i = 0; i < players; i += 1) economy.addPlayer(`p${i}`, STARTING_GRANT);

  const rng = makeRandom(seed);
  const checkpoints = [];

  for (let i = 0; i < trades; i += 1) {
    const playerId = `p${rng.int(0, players - 1)}`;
    const good = economy.goods.get(rng.pick(GOODS).id);
    const holding = economy.held(playerId, good.id);

    if (holding > 0 && rng.chance(0.45)) {
      economy.sell(playerId, good.id, rng.int(1, holding));
    } else {
      let qty = Math.min(rng.int(1, 500), maxTradeQty(good.supply));
      const cash = economy.players.get(playerId).cash;
      while (qty > 0 && buyCost(good.basePrice, good.supply, qty, good.k, good.n) > cash) {
        qty = Math.floor(qty / 2);
      }
      if (qty > 0) economy.buy(playerId, good.id, qty);
    }

    if (i % 100 === 0) {
      checkpoints.push(economy.checkInvariants());
    }
  }

  return { economy, checkpoints };
}

describe('money supply conservation', () => {
  it('holds at every checkpoint of a long random run', () => {
    const { checkpoints } = churn(42);
    for (const violations of checkpoints) expect(violations).toEqual([]);
  });

  it('balances to the exact Note across many seeds', () => {
    for (const seed of [1, 7, 42, 99, 1234, 65_535]) {
      const { economy } = churn(seed, { trades: 1_200 });
      const accounted = economy.totalCash() + economy.reserve + economy.burned;
      expect(accounted, `seed ${seed} leaked`).toBe(economy.granted);
    }
  });

  it('accounts for every Note the spread removed', () => {
    const { economy } = churn(42);
    const burnedFromTrades = economy.trades.reduce((sum, t) => sum + t.spread, 0);
    expect(economy.burned).toBe(burnedFromTrades);
    expect(economy.burned).toBeGreaterThan(0);
  });

  it('never lets cash or holdings go negative', () => {
    const { economy } = churn(1234);
    for (const p of economy.players.values()) {
      expect(p.cash).toBeGreaterThanOrEqual(0);
      for (const q of p.holdings.values()) expect(q).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every good fully held - holdings sum equals supply', () => {
    const { economy } = churn(99);
    for (const g of economy.goods.values()) {
      expect(economy.totalHeld(g.id)).toBe(g.supply);
    }
  });

  it('drains the reserve down to rounding dust when every position is unwound', () => {
    // The strongest form of the claim: if everyone sells everything, the
    // curve has paid back what it took in, and the Notes missing from
    // player hands are the ones the spread burned.
    //
    // "Paid back what it took in" is not "paid back to zero". Buys round
    // up and sells round down, so every trade leaves a sub-Note residue
    // behind in the reserve. That dust is bounded by the number of
    // trades - at most one Note each - and it can only ever be positive.
    // A negative reserve would mean the curve paid out more than it ever
    // collected, which is the failure this test is really watching for.
    const { economy } = churn(42, { trades: 1_500 });

    // Unwinding has to respect the per-trade size cap, so a large
    // position comes out in slices rather than one sell. Only count a
    // slice as sold once the trade actually succeeded.
    for (const p of economy.players.values()) {
      for (const [goodId] of [...p.holdings]) {
        let left = economy.held(p.id, goodId);
        while (left > 0) {
          const good = economy.goods.get(goodId);
          const step = Math.min(left, maxTradeQty(good.supply), good.supply);
          if (step <= 0 || !economy.sell(p.id, goodId, step).ok) break;
          left -= step;
        }
      }
    }

    for (const g of economy.goods.values()) expect(g.supply).toBe(0);

    expect(economy.reserve).toBeGreaterThanOrEqual(0);
    expect(economy.reserve).toBeLessThan(economy.trades.length);

    // The dust is not lost - it is still inside the invariant.
    expect(economy.totalCash() + economy.reserve + economy.burned).toBe(economy.granted);
    expect(economy.checkInvariants()).toEqual([]);
  });
});
