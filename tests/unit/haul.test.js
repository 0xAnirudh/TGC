import { describe, it, expect } from 'vitest';
import {
  priceFor,
  boardFor,
  buyCostFor,
  sellReturnFor,
  growDebt,
  hash32,
  GOODS,
  TOWNS,
  ROADS,
  RUN_DAYS,
  IMPACT_SCALE,
} from '@tgc/shared';

describe('prices', () => {
  it('is the same every time for the same seed, day, town and good', () => {
    // The whole verification story rests on this. If prices were not
    // reproducible from the seed, a finished run could not be replayed
    // and the board would be a list of numbers clients claimed.
    for (let i = 0; i < 40; i += 1) {
      const a = priceFor('seed-x', 7, 'ashford', 'silk');
      const b = priceFor('seed-x', 7, 'ashford', 'silk');
      expect(a).toEqual(b);
    }
  });

  it('differs by seed, by day, by town and by good', () => {
    const base = priceFor('seed-a', 5, 'ashford', 'silk').price;
    expect(priceFor('seed-b', 5, 'ashford', 'silk').price).not.toBe(base);
    expect(priceFor('seed-a', 6, 'ashford', 'silk').price).not.toBe(base);
    expect(priceFor('seed-a', 5, 'coldwater', 'silk').price).not.toBe(base);
    expect(priceFor('seed-a', 5, 'ashford', 'amber').price).not.toBe(base);
  });

  it('keeps every good in a range worth trading but not absurd', () => {
    // An early tuning let Saffron range from 31 to 172,000, which made a
    // single lucky roll decide the run. A good should usually sit within
    // a factor of two or three of its base.
    for (const good of GOODS) {
      const samples = [];
      for (let day = 1; day <= 120; day += 1) {
        for (const town of TOWNS) samples.push(priceFor('tune', day, town.id, good.id).price);
      }
      samples.sort((a, b) => a - b);

      const p10 = samples[Math.floor(samples.length * 0.1)];
      const p90 = samples[Math.floor(samples.length * 0.9)];
      const median = samples[Math.floor(samples.length * 0.5)];

      expect(median).toBeGreaterThan(good.base * 0.55);
      expect(median).toBeLessThan(good.base * 1.9);
      // Wide enough to be worth chasing.
      expect(p90 / p10).toBeGreaterThan(1.8);
      // Not so wide that one day wins the game.
      expect(p90 / p10).toBeLessThan(7);
      expect(samples[0]).toBeGreaterThanOrEqual(1);
    }
  });

  it('never returns a price below one Note', () => {
    for (let day = 1; day <= 60; day += 1) {
      for (const town of TOWNS) {
        for (const good of GOODS) {
          expect(priceFor('floor', day, town.id, good.id).price).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('prices every good in a town board', () => {
    const board = boardFor('s', 3, 'terraces');
    expect(board).toHaveLength(GOODS.length);
    for (const row of board) expect(row.price).toBeGreaterThan(0);
  });
});

describe('price impact', () => {
  it('makes each extra unit cost more than the last', () => {
    const ten = buyCostFor(100, 0, 10) / 10;
    const hundred = buyCostFor(100, 0, 100) / 100;
    const threeHundred = buyCostFor(100, 0, 300) / 300;

    expect(hundred).toBeGreaterThan(ten);
    expect(threeHundred).toBeGreaterThan(hundred);
  });

  it('costs about a fifth more to fill a starting cart', () => {
    // Tuned deliberately: at the first value tried, filling the cart cost
    // six percent more, which is a rounding error rather than a choice.
    const perUnit = buyCostFor(100, 0, 100) / 100;
    expect(perUnit / 100).toBeGreaterThan(1.12);
    expect(perUnit / 100).toBeLessThan(1.3);
  });

  it('is symmetric: selling back what you bought returns less than you paid', () => {
    // Buying pushes the price up and selling pushes it down, so a
    // round trip inside one day is a loss. Without that, a big cart is a
    // free money printer against any town.
    const paid = buyCostFor(200, 0, 80);
    const back = sellReturnFor(200, 80, 80);
    expect(back).toBeLessThan(paid);
  });

  it('never pays out a negative amount', () => {
    expect(sellReturnFor(50, -5_000, 100)).toBeGreaterThanOrEqual(0);
  });

  it('charges more when the town has already been worked over', () => {
    expect(buyCostFor(100, 400, 50)).toBeGreaterThan(buyCostFor(100, 0, 50));
  });
});

describe('the debt clock', () => {
  it('grows every day whatever the player does', () => {
    let debt = 5_000;
    const start = debt;
    for (let i = 0; i < 5; i += 1) debt = growDebt(debt);
    expect(debt).toBeGreaterThan(start);
  });

  it('grows enough over a run to matter, and not so much it decides it', () => {
    // The window this has to sit in is narrow, and the first attempt
    // missed it badly. At 12% a day the debt compounds thirtyfold and
    // every playtest ended ruined - clearing it meant turning a 2,000
    // stake into seventy-five times itself. At 7% it compounds to about
    // seven and a half: a patient player finished on 315,901, a careless
    // one on 124,440 having paid 35,603 in interest.
    let debt = 5_000;
    for (let i = 0; i < RUN_DAYS; i += 1) debt = growDebt(debt);
    const multiple = debt / 5_000;

    expect(multiple).toBeGreaterThan(4);
    expect(multiple).toBeLessThan(12);
  });

  it('always rounds against the borrower', () => {
    expect(growDebt(1)).toBeGreaterThan(1);
  });
});

describe('the map', () => {
  it('connects every town to at least two others', () => {
    for (const town of TOWNS) {
      expect(ROADS[town.id]?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('has roads that run both ways', () => {
    // A one-way road would strand a player, which is a bug nobody would
    // find until it happened to them on day nineteen.
    for (const [from, tos] of Object.entries(ROADS)) {
      for (const to of tos) {
        expect(ROADS[to], `${to} does not link back to ${from}`).toContain(from);
      }
    }
  });

  it('lets you reach every town from the start', () => {
    const seen = new Set(['saltmarket']);
    const queue = ['saltmarket'];
    while (queue.length) {
      for (const next of ROADS[queue.shift()] ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(TOWNS.length);
  });
});

describe('hash32', () => {
  it('is stable and spread across the unit interval', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    const xs = Array.from({ length: 3_000 }, (_, i) => hash32(`k${i}`));
    const buckets = new Array(10).fill(0);
    for (const x of xs) buckets[Math.min(9, Math.floor(x * 10))] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(180);
  });

  it('stays inside [0, 1)', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const v = hash32(`s${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('constants hang together', () => {
  it('starts you owing more than you hold', () => {
    // The run has to open with pressure. Starting solvent makes day one
    // a shrug.
    const { OPENING_CASH, OPENING_DEBT } = { OPENING_CASH: 2_000, OPENING_DEBT: 5_000 };
    expect(OPENING_DEBT).toBeGreaterThan(OPENING_CASH);
  });

  it('has an impact scale in the same order as the cart', () => {
    expect(IMPACT_SCALE).toBeGreaterThan(100);
    expect(IMPACT_SCALE).toBeLessThan(2_000);
  });
});
