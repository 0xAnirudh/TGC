/**
 * The four markets.
 *
 * Every good trades in all four, and each one has its OWN supply and its
 * own position on the curve. That is the whole point: a good that has
 * been bought heavily in one place is expensive there and still cheap
 * somewhere else, and the gap between them is what there is to do.
 *
 * WHY SEPARATE SUPPLY RATHER THAN A PRICE MULTIPLIER PER REGION.
 *
 * A multiplier is the obvious shortcut - keep one supply, mark prices up
 * 30% here and down 20% there - and it breaks the economy. Buying at
 * 0.8x and selling at 1.3x takes more out of the curve reserve than was
 * paid into it, so the reserve drains toward negative and the difference
 * is Notes created from nothing. The money supply invariant would fail,
 * and it would fail in a way that looks like profitable play.
 *
 * With separate supply there is no such gap. Buying in one region adds
 * to that region's curve and its reserve; selling in another subtracts
 * from that one. The reserve is always exactly the sum of every region's
 * curve integral, and arbitrage profit comes from the person who bought
 * the price up - which is where profit is supposed to come from.
 */

/**
 * OPENING STOCK, AND WHY EVERY MARKET NEEDS IT.
 *
 * A bonding curve pays for a sale out of what it took in. Selling
 * returns units to the curve and the curve hands back Notes - so a
 * market at zero supply has taken in nothing and can pay out nothing,
 * and a sell there is refused.
 *
 * That made the entire point of regions impossible. You could buy in the
 * harbour, pay the fare, arrive at the frontier and find you could not
 * sell a single unit, because the frontier had never bought any. The
 * arbitrage loop did not work, and it did not work by construction
 * rather than by accident.
 *
 * So every market opens already holding stock, as though the world had
 * been trading before anyone arrived. Those units were paid for, so the
 * Notes backing them are real and the seed puts them into both the curve
 * reserve and the faucet total - otherwise the money supply invariant
 * would show the reserve holding Notes nobody ever granted.
 *
 * EVERY REGION OPENS WITH THE SAME STOCK, AND IT IS A FRACTION OF k.
 *
 * Both halves of that were learned the hard way.
 *
 * A flat number of units means nothing without the curve it sits on.
 * Six thousand units of Iron (k = 20,000) is a third of the way up a
 * gentle curve; six thousand units of Saffron (k = 3,000, n = 3) is
 * twenty-seven times its base price. Seeding a flat 6,000 everywhere put
 * Saffron at 11,097 in the harbour against a launch price of 500.
 *
 * Varying stock by region seemed like a nice second source of price
 * difference, and it inverted the geography. A market further along its
 * curve is DEARER, so giving the harbour the most stock made the cheap
 * region the expensive one - fighting the price bias that was supposed
 * to define it.
 *
 * So stock is uniform and proportional: every market opens the same
 * fraction of the way up its own curve, and priceBias alone decides
 * which places are dear. One knob, one effect.
 */
export const OPENING_STOCK_FRACTION = 0.35;

/** Opening units for one good in one market. */
export const openingStockFor = (k) => Math.round(k * OPENING_STOCK_FRACTION);

export const REGIONS = [
  {
    id: 'harbour',
    name: 'Saltmarket Harbour',
    blurb: 'Everything arrives here first. Cheap, crowded, unglamorous.',
    // Where this region's prices start relative to a good's base price.
    // The harbour is the source, so it is the cheap one.
    priceBias: 0.82,
    travelCost: 400,
  },
  {
    id: 'foundry',
    name: 'Blackreach Foundry',
    blurb: 'Industry town. Pays well for metal, indifferent to luxuries.',
    priceBias: 1.0,
    travelCost: 700,
  },
  {
    id: 'terraces',
    name: 'The Gilded Terraces',
    blurb: 'Old money. Silk and saffron move here; nobody wants grain.',
    priceBias: 1.28,
    travelCost: 1_100,
  },
  {
    id: 'frontier',
    name: 'Coldwater Frontier',
    blurb: 'Far from everything. Scarce, expensive, and slow to restock.',
    priceBias: 1.45,
    travelCost: 1_600,
  },
];

export const REGION_IDS = REGIONS.map((r) => r.id);
export const DEFAULT_REGION = 'harbour';

export const regionById = (id) => REGIONS.find((r) => r.id === id) ?? null;
export const isRegion = (id) => REGION_IDS.includes(id);

/**
 * What it costs to travel between two places.
 *
 * Distance is how far apart they sit in the list, so the harbour to the
 * frontier is the long haul and neighbours are cheap. Travel has to cost
 * something or arbitrage is free money with extra steps.
 */
export function travelCost(fromId, toId) {
  if (fromId === toId) return 0;
  const from = REGION_IDS.indexOf(fromId);
  const to = REGION_IDS.indexOf(toId);
  if (from < 0 || to < 0) return 0;

  const distance = Math.abs(from - to);
  const base = regionById(toId).travelCost;
  return Math.round(base * (0.5 + distance * 0.5));
}

/** Seconds in transit. Long enough that a price gap can close on you. */
export function travelSeconds(fromId, toId) {
  if (fromId === toId) return 0;
  const distance = Math.abs(REGION_IDS.indexOf(fromId) - REGION_IDS.indexOf(toId));
  return 20 + distance * 15;
}

/**
 * How much a player can carry, in units, across all goods.
 *
 * This is the constraint that makes the game a series of decisions
 * rather than an optimisation. Without it, the correct move is always
 * "buy everything cheap, sell everything dear", and there is nothing to
 * choose. With it, cargo space is the scarce resource and every purchase
 * is a bet about which good is worth the room.
 */
export const BASE_CARGO = 500;
export const MAX_CARGO = 5_000;

/** Cost to add another 250 units of hold. Rises as it grows. */
export function cargoUpgradeCost(current) {
  const steps = Math.max(0, Math.round((current - BASE_CARGO) / 250));
  return Math.round(6_000 * Math.pow(1.45, steps));
}
export const CARGO_STEP = 250;
