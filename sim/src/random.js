/**
 * Seeded PRNG (mulberry32).
 *
 * The simulation is the correctness argument for the whole economy, so
 * it has to be reproducible. A failing run must be re-runnable with the
 * same seed to find out what happened; Math.random() would make every
 * failure a one-off anecdote.
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** Integer in [min, max] inclusive. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}
