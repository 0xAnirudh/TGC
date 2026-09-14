/**
 * THE HAUL
 *
 * A run is thirty days. You start owing money at a rate that compounds
 * from the first turn, so you are behind before you begin. Every town
 * reprices every good every day, and you only see the prices where you
 * are standing. Travelling costs a day. Your cart holds what it holds.
 *
 * On day thirty the cart is liquidated, the debt is settled, and what is
 * left is the score.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OLD MARKET, AND WHY IT REPLACED IT.
 *
 * The previous game was a simulation: a shared market that drifted a
 * percent or two an hour, with no end, no score, and nothing that could
 * go wrong. It was interesting to build and dull to play. Every design
 * decision here is aimed at the opposite:
 *
 *   a clock      thirty days, then a number. A run is about three
 *                minutes, and you play again to beat it.
 *   a reveal     prices are rerolled daily and hidden outside your town,
 *                so arriving somewhere is information, not confirmation.
 *   real swings  a good moves by multiples, not percents. Saffron at 40
 *                one day and 900 the next is the whole game.
 *   pressure     the debt compounds whether or not you do anything.
 *   jeopardy     things go wrong on the road.
 */

/** Length of a run, in days. */
export const RUN_DAYS = 30;

/** What you owe on day one, and what it grows by daily. */
export const OPENING_DEBT = 5_000;

/**
 * What the debt grows by each day.
 *
 * Tuned down from 12%, which was unplayable. Twelve percent compounds to
 * thirty times over a run - 5,000 becomes 150,000 - so clearing it meant
 * turning a 2,000 stake into seventy-five times itself. With goods that
 * move by two or three times rather than ten, that is not a hard target,
 * it is an impossible one, and a playtest ended ruined every time.
 *
 * Seven percent compounds to about seven and a half times. A player who
 * trades well and repays early beats it comfortably; one who ignores it
 * for a fortnight does not. That gap is where the tension lives.
 */
export const DEBT_RATE_BPS = 700;

/** Cash in hand on day one. Less than the debt, deliberately. */
export const OPENING_CASH = 2_000;

/** Units the cart holds, and what more room costs. */
export const OPENING_CAPACITY = 100;
export const MAX_CAPACITY = 900;
export const CAPACITY_STEP = 50;
export const capacityCost = (current) =>
  Math.round(900 * Math.pow(1.32, Math.max(0, (current - OPENING_CAPACITY) / CAPACITY_STEP)));

/**
 * The goods.
 *
 * `base` is what the good is worth on an average day in an average
 * town. `swing` is how violently it moves - the difference between a
 * staple you can rely on and a luxury that is either worthless or a
 * fortune. That spread is what makes a cargo decision interesting: Grain
 * is a wage, Saffron is a bet.
 */
export const GOODS = [
  { id: 'grain', name: 'Grain', base: 22, swing: 0.3, color: 'amber' },
  { id: 'iron', name: 'Iron', base: 58, swing: 0.34, color: 'slate' },
  { id: 'salt', name: 'Salt', base: 95, swing: 0.4, color: 'blue' },
  { id: 'copper', name: 'Copper', base: 180, swing: 0.46, color: 'orange' },
  { id: 'ink', name: 'Ink', base: 340, swing: 0.52, color: 'indigo' },
  { id: 'silk', name: 'Silk', base: 620, swing: 0.58, color: 'violet' },
  { id: 'amber', name: 'Amber', base: 1_150, swing: 0.64, color: 'yellow' },
  { id: 'saffron', name: 'Saffron', base: 2_400, swing: 0.72, color: 'rose' },
];

export const GOOD_BY_ID = Object.fromEntries(GOODS.map((g) => [g.id, g]));

/**
 * The towns.
 *
 * `affinity` tilts a good's price here: below 1 is a place that produces
 * it, above 1 a place that wants it. The tilt is gentle compared to the
 * daily roll - it gives each town a character without making the right
 * route obvious on day one.
 */
export const TOWNS = [
  {
    id: 'saltmarket',
    name: 'Saltmarket',
    blurb: 'Wharves and warehouses. Bulk arrives here and leaves cheap.',
    x: 86,
    y: 396,
    affinity: { grain: 0.7, salt: 0.6, iron: 0.85, saffron: 1.25 },
  },
  {
    id: 'blackreach',
    name: 'Blackreach',
    blurb: 'Furnaces and slag. Metal is cheap, everything else is not.',
    x: 190,
    y: 330,
    affinity: { iron: 0.55, copper: 0.65, silk: 1.3, saffron: 1.2 },
  },
  {
    id: 'ashford',
    name: 'Ashford Crossing',
    blurb: 'Every road meets here. Nothing is cheap, nothing is dear.',
    x: 168,
    y: 218,
    affinity: {},
  },
  {
    id: 'terraces',
    name: 'The Terraces',
    blurb: 'Old money. Pays absurdly for luxuries, sneers at staples.',
    x: 284,
    y: 176,
    affinity: { silk: 1.45, amber: 1.5, saffron: 1.4, grain: 0.75, iron: 0.9 },
  },
  {
    id: 'thornwyck',
    name: 'Thornwyck',
    blurb: 'Half-abandoned. Prices here make no sense at all.',
    x: 70,
    y: 170,
    affinity: {},
    // Thornwyck ignores affinity and doubles the daily swing instead:
    // the town where fortunes are made and lost.
    chaos: 1.55,
  },
  {
    id: 'coldwater',
    name: 'Coldwater',
    blurb: 'The far end of the road. Scarce, and it knows it.',
    x: 300,
    y: 58,
    affinity: { grain: 1.4, salt: 1.5, iron: 1.3, copper: 1.25, ink: 1.2 },
  },
];

export const TOWN_BY_ID = Object.fromEntries(TOWNS.map((t) => [t.id, t]));

/** Which towns connect to which. Travel is one day per leg. */
export const ROADS = {
  saltmarket: ['blackreach', 'thornwyck'],
  blackreach: ['saltmarket', 'ashford', 'thornwyck'],
  ashford: ['blackreach', 'terraces', 'thornwyck', 'coldwater'],
  terraces: ['ashford', 'coldwater'],
  thornwyck: ['saltmarket', 'blackreach', 'ashford'],
  coldwater: ['ashford', 'terraces'],
};

export const START_TOWN = 'saltmarket';

/* ------------------------------------------------------------------ *
 * Prices
 * ------------------------------------------------------------------ */

/**
 * A small, fast, deterministic hash.
 *
 * Prices have to be reproducible from the run's seed alone, because that
 * is what lets the server replay a finished run and recompute its score
 * rather than trusting the number a client reports. Math.random would
 * make a run unverifiable, and storing every price would make a run
 * enormous.
 *
 * FNV-1a, which is short enough to read and good enough for this.
 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  // Avalanche, borrowed from murmur3's finaliser.
  //
  // FNV-1a alone leaves visible structure in the low bits, and the low
  // bits are exactly what a division by 2^32 turns into the fraction
  // that sets a price. Measured over short sequential keys it put 8.6%
  // more values in some tenths of the range than others - a bias small
  // enough to never notice and large enough to make certain goods
  // quietly cheaper than intended. Four more operations flattens it to
  // about 3%.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return (h >>> 0) / 4294967296;
}

/**
 * A shock, or nothing.
 *
 * Tuned down hard from a first attempt. With multipliers of 0.22 and
 * 4.2 stacked on an exponential roll and a town affinity, Saffron
 * ranged from 31 to 172,000 and a single day offered a 28,000% trade.
 * A game where one lucky roll wins the run is not a game - the skill
 * stops mattering the moment the dice land.
 *
 * These produce a good that is usually within a factor of two of its
 * base and occasionally four or five times it. Enough to be worth
 * chasing, not enough to decide the run on its own.
 */
function shockFor(roll) {
  if (roll < 0.05) return { mult: 0.45, kind: 'glut' };
  if (roll < 0.12) return { mult: 0.68, kind: 'surplus' };
  if (roll > 0.96) return { mult: 2.5, kind: 'famine' };
  if (roll > 0.89) return { mult: 1.6, kind: 'shortage' };
  return null;
}

/**
 * What one good costs in one town on one day.
 *
 * The spread is exponential rather than linear, so a good is usually
 * near its base and occasionally nowhere near it. A linear roll gives a
 * flat, forgettable distribution; this one produces the days you
 * remember.
 */
export function priceFor(seed, day, townId, goodId) {
  const good = GOOD_BY_ID[goodId];
  const town = TOWN_BY_ID[townId];
  if (!good || !town) return 0;

  const roll = hash32(`${seed}|${day}|${townId}|${goodId}`);
  const shockRoll = hash32(`${seed}|${day}|${townId}|${goodId}|s`);

  const swing = good.swing * (town.chaos ?? 1);
  const affinity = town.chaos ? 1 : (town.affinity[goodId] ?? 1);

  let value = good.base * affinity * Math.exp((roll - 0.5) * swing * 2);

  const shock = shockFor(shockRoll);
  if (shock) value *= shock.mult;

  return { price: Math.max(1, Math.round(value)), shock: shock?.kind ?? null };
}

/** Every price in one town on one day. */
export function boardFor(seed, day, townId) {
  return GOODS.map((g) => {
    const { price, shock } = priceFor(seed, day, townId, g.id);
    return { id: g.id, name: g.name, color: g.color, base: g.base, price, shock };
  });
}

/* ------------------------------------------------------------------ *
 * Price impact
 * ------------------------------------------------------------------ */

/**
 * Buying in bulk moves the price against you, within the day.
 *
 * Without it, the right move on a good day is always "spend everything
 * on the cheapest thing", and cargo space is the only brake. With it,
 * clearing out a small town's stock costs more per unit than taking
 * half - so a big score needs more than one good day.
 *
 * Deliberately gentle: a full cart moves a price by roughly a fifth, not
 * by multiples. It is a tax on greed, not a wall.
 */
/**
 * How fast buying moves the price against you.
 *
 * Set so that filling a starting cart - a hundred units - costs about a
 * fifth more per unit than taking ten. At the first value tried it was
 * six percent, which is not a decision, it is a rounding error.
 */
export const IMPACT_SCALE = 260;

export function buyCostFor(unitPrice, alreadyBought, qty) {
  // Integral of price * (1 + bought/SCALE) over the quantity, rounded up
  // so the house never loses a fraction.
  const a = alreadyBought;
  const b = alreadyBought + qty;
  const raw = unitPrice * (b - a + (b * b - a * a) / (2 * IMPACT_SCALE));
  return Math.ceil(raw);
}

/** Selling in bulk pushes the price down the same way. */
export function sellReturnFor(unitPrice, alreadySold, qty) {
  const a = alreadySold;
  const b = alreadySold + qty;
  const raw = unitPrice * (b - a - (b * b - a * a) / (2 * IMPACT_SCALE));
  return Math.max(0, Math.floor(raw));
}

/** Debt after one more day. */
export const growDebt = (debt) => Math.ceil((debt * (10_000 + DEBT_RATE_BPS)) / 10_000);
