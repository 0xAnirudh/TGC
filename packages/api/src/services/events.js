import { Good } from '../models/Good.js';
import { Market } from '../models/Market.js';
import { MarketEvent } from '../models/MarketEvent.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice } from '../redis/keys.js';
import { publishPriceChange } from '../realtime/publish.js';
import { log } from '../log.js';
import { price, REGIONS } from '@tgc/shared';
import { MIN_BASE_PRICE_RATIO, MAX_BASE_PRICE_RATIO } from './drift.js';

/**
 * Market events.
 *
 * A price shock with a reason attached. Drift makes prices wander;
 * events make them jump, and give the jump a name.
 *
 * Like drift, an event moves `basePrice` and never `supply`. Supply is
 * what the ledger accounts for - an event that created units would be
 * creating them from nothing, and the rebuild would correctly erase
 * them (FINDING-007). And because it moves what things cost rather than
 * who owns what, an event cannot mint or burn a single Note. The money
 * supply invariant is untouched by construction.
 *
 * That is worth stating because "a random event changes prices" sounds
 * like exactly the kind of thing that would break an economy, and the
 * reason it does not is structural rather than careful.
 */

const EVENTS = [
  {
    kind: 'shortage',
    bps: [900, 2200],
    headline: (g) => `${g} shortage bites - supply lines strained`,
  },
  {
    kind: 'discovery',
    bps: [-2200, -900],
    headline: (g) => `Vast new ${g} seam found - price collapses`,
  },
  {
    kind: 'boom',
    bps: [1200, 3000],
    headline: (g) => `${g} demand surges on industrial orders`,
  },
  {
    kind: 'glut',
    bps: [-3000, -1200],
    headline: (g) => `Warehouses overflow with unsold ${g}`,
  },
  {
    kind: 'strike',
    bps: [600, 1600],
    headline: (g) => `${g} handlers walk out - deliveries halted`,
  },
  {
    kind: 'scandal',
    bps: [-1800, -700],
    headline: (g) => `${g} grading scandal - buyers pull back`,
  },
  {
    kind: 'tariff',
    bps: [400, 1100],
    headline: (g) => `New levy lands on imported ${g}`,
  },
  {
    kind: 'substitute',
    bps: [-1400, -500],
    headline: (g) => `Cheaper substitute for ${g} reaches the market`,
  },
];

/** How often a tick produces an event at all. */
export const EVENT_CHANCE = 0.35;

export async function maybeFireEvent({ random = Math.random, force = false } = {}) {
  if (!force && random() > EVENT_CHANCE) return null;

  const goods = await Good.find().lean();
  if (goods.length === 0) return null;

  const good = goods[Math.floor(random() * goods.length)];
  const template = EVENTS[Math.floor(random() * EVENTS.length)];
  const id = good._id.toString();

  // An event hits ONE market, not all four. That is what makes it worth
  // reacting to: a shortage in the harbour opens a gap against the
  // frontier, and somebody has to carry goods there to close it.
  const region = REGIONS[Math.floor(random() * REGIONS.length)];

  const redis = getRedis();
  const [supplyRaw, baseRaw] = await redis.mget(
    goodSupply(id, region.id),
    goodBasePrice(id, region.id),
  );
  if (supplyRaw === null || baseRaw === null) return null;

  const supply = Number(supplyRaw);
  const basePrice = Number(baseRaw);

  const [lo, hi] = template.bps;
  const impactBps = Math.round(lo + random() * (hi - lo));

  const market = await Market.findOne({ goodId: good._id, region: region.id }).lean();
  const launchPrice = market?.launchPrice ?? basePrice;

  // The same bounds drift respects. An event is a bigger jolt, not a
  // licence to send a price anywhere - a good that can 50x on one roll
  // is a lottery, not a market.
  const proposed = Math.round(basePrice * (1 + impactBps / 10_000));
  const nextBase = Math.max(
    Math.round(launchPrice * MIN_BASE_PRICE_RATIO),
    Math.min(Math.round(launchPrice * MAX_BASE_PRICE_RATIO), proposed),
  );

  if (nextBase === basePrice) return null;

  const priceBefore = price(basePrice, supply, good.k, good.n);
  const priceAfter = price(nextBase, supply, good.k, good.n);

  await redis.set(goodBasePrice(id, region.id), nextBase);
  await Market.updateOne(
    { goodId: good._id, region: region.id },
    { $set: { basePrice: nextBase } },
  );

  const event = await MarketEvent.create({
    goodId: good._id,
    goodName: good.name,
    region: region.id,
    regionName: region.name,
    kind: template.kind,
    headline: `${template.headline(good.name)} — ${region.name}`,
    impactBps,
    priceBefore: Math.round(priceBefore * 100) / 100,
    priceAfter: Math.round(priceAfter * 100) / 100,
  });

  // Push it to anyone watching, so a shock is something you see happen
  // rather than something you discover on your next refresh.
  await publishPriceChange({
    goodId: id,
    region: region.id,
    price: Math.round(priceAfter * 100) / 100,
    supply,
    side: 'event',
    quantity: 0,
  }).catch(() => {});

  log.info('market event', {
    good: good.name,
    region: region.id,
    kind: template.kind,
    impactBps,
    from: event.priceBefore,
    to: event.priceAfter,
  });

  return event;
}

export async function recentEvents(limit = 12) {
  return MarketEvent.find().sort({ at: -1 }).limit(limit).lean();
}
