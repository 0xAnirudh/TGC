import { User } from '../models/User.js';
import { Good } from '../models/Good.js';
import { getRedis } from '../redis/client.js';
import { goodSupply, goodBasePrice, userCash, userHoldings } from '../redis/keys.js';
import { executeTrade } from './trading.js';
import { log } from '../log.js';
import { price, maxTradeQty, STARTING_GRANT } from '@tgc/shared';

/**
 * NPC traders.
 *
 * The market being empty was the single biggest problem with the game.
 * One person trading against a curve is not a market - it is a
 * calculator with a chart. Prices only moved when you moved them, the
 * leaderboard never changed, and the newspaper had nothing to report.
 *
 * These bots fix that by trading on their own. They are deliberately
 * simple - five short rules, no learning, no optimisation - because a
 * bot that is clever is a bot nobody can reason about, and the point is
 * a market that behaves plausibly, not one that wins.
 *
 * They are ordinary Users and go through the ordinary trade path. Same
 * curve, same spread, same size cap, same slippage bound, same rejection
 * when they cannot afford something. That matters: it means every trade
 * they place is also a test of the real execution path, and they cannot
 * accidentally be given powers a player does not have.
 */

/**
 * How much of the per-trade cap a bot is willing to use.
 *
 * The first version left this at 1.0, so a bot could move ten percent of
 * a good's supply in a single trade, every few seconds. Cobalt went from
 * 180 to 4,115 - twenty-three times its launch price - in twenty-five
 * seconds. That is not a market, it is a stampede.
 *
 * Bots are here to keep a market alive, not to corner it. They nudge.
 */
const SIZE_SCALE = 0.09;

/**
 * Smallest trade a bot will bother with.
 *
 * The per-trade cap has a floor of 100 units so a brand new good can be
 * bootstrapped (ADR-005), and nine percent of that is nine units. At
 * that size fifteen bots moved a good's supply by twenty-three units in
 * a minute - technically alive, visibly nothing.
 *
 * A floor here keeps early trading visible without letting bots dominate
 * a good once it has real supply, where the percentage cap takes over.
 */
const MIN_BOT_QTY = 25;

const STRATEGIES = {
  /**
   * Buys what has been rising, sells what has been falling.
   * Amplifies moves and makes rallies overshoot slightly.
   */
  momentum: {
    name: 'momentum',
    count: 3,
    decide: ({ changePct, holding, upPct }) => {
      // Take profit first. Without this the buy rule is self-reinforcing
      // and a rising good only ever attracts more buying.
      if (holding > 0 && upPct > 15) return { side: 'sell', weight: 0.8 };
      if (changePct > 0.5) return { side: 'buy', weight: 0.7 };
      if (changePct < -0.5 && holding > 0) return { side: 'sell', weight: 0.7 };
      return null;
    },
  },

  /**
   * Does the opposite. Buys weakness, sells strength.
   * The counterweight - without one of these, momentum bots walk a price
   * to the ceiling and leave it there.
   */
  contrarian: {
    name: 'contrarian',
    count: 3,
    decide: ({ changePct, holding, upPct }) => {
      if (holding > 0 && upPct > 8) return { side: 'sell', weight: 0.9 };
      if (changePct < -0.4) return { side: 'buy', weight: 0.6 };
      if (changePct > 1.0 && holding > 0) return { side: 'sell', weight: 0.8 };
      return null;
    },
  },

  /**
   * Rare, large, and indiscriminate. Supplies the drama - a whale
   * entering is visible on a chart. Acts on roughly one tick in eight.
   */
  whale: {
    name: 'whale',
    count: 1,
    decide: ({ random, holding }) => {
      if (random() > 0.12) return null;
      if (holding > 0 && random() < 0.5) return { side: 'sell', weight: 1 };
      return { side: 'buy', weight: 1 };
    },
  },

  /**
   * Trades small amounts constantly for no reason at all.
   * Real markets have noise, and without it every movement looks
   * deliberate and the chart is a staircase.
   *
   * Deliberately balanced: as likely to sell as to buy, so the noise
   * does not add up to a direction.
   */
  jitter: {
    name: 'jitter',
    count: 5,
    decide: ({ random, holding }) => {
      if (random() > 0.4) return null;
      if (holding > 0 && random() < 0.5) return { side: 'sell', weight: 0.3 };
      return { side: 'buy', weight: 0.3 };
    },
  },

  /**
   * Waits for a good to fall well below where it started, then buys.
   * Puts a soft floor under crashes, so a shock is an opportunity rather
   * than a hole.
   */
  dipBuyer: {
    name: 'dipBuyer',
    count: 2,
    decide: ({ fromLaunchPct, holding, upPct }) => {
      if (holding > 0 && upPct > 20) return { side: 'sell', weight: 1 };
      if (fromLaunchPct < -15) return { side: 'buy', weight: 0.8 };
      return null;
    },
  },

  /**
   * Sells into anything that has run far above its launch price.
   *
   * The brake. Added after the first run, where nothing in the roster
   * had a reason to sell a good that had gone up twenty-three times -
   * every strategy was either buying or waiting.
   */
  fader: {
    name: 'fader',
    count: 2,
    decide: ({ fromLaunchPct, holding }) => {
      if (fromLaunchPct > 60 && holding > 0) return { side: 'sell', weight: 1 };
      if (fromLaunchPct > 120) return { side: 'sell', weight: 1 };
      return null;
    },
  },
};

const BOT_NAMES = [
  'Halloway',
  'Ferris',
  'Okonkwo',
  'Vasquez',
  'Lindqvist',
  'Nakamura',
  'Okafor',
  'Brandt',
  'Salvatore',
  'Achterberg',
  'Marchetti',
  'Dubois',
  'Ferreira',
  'Novak',
  'Whitlock',
];

/**
 * A bot's purse.
 *
 * Modest on purpose. Fifteen bots with six times a player's grant is
 * nine million Notes of buying pressure against eight goods, which is
 * what sent prices to twenty-three times their launch on the first run.
 * At 1.5x they are participants rather than the whole market.
 */
const BOT_GRANT = Math.round(STARTING_GRANT * 1.5);

/**
 * Create the bot roster if it does not exist.
 *
 * Their grants count against the faucet like anyone else's, because the
 * money supply invariant does not have an exception for computers.
 */
export async function ensureBots() {
  const existing = await User.countDocuments({ isBot: true });
  const wanted = Object.values(STRATEGIES).reduce((n, s) => n + s.count, 0);
  if (existing >= wanted) return { created: 0, total: existing };

  const redis = getRedis();
  let created = 0;
  let nameIndex = 0;

  for (const strategy of Object.values(STRATEGIES)) {
    for (let i = 0; i < strategy.count; i += 1) {
      const username =
        BOT_NAMES[nameIndex % BOT_NAMES.length] + (nameIndex >= BOT_NAMES.length ? nameIndex : '');
      nameIndex += 1;

      if (await User.findOne({ usernameLower: username.toLowerCase() })) continue;

      let bot;
      try {
        bot = await User.create({
          username,
          usernameLower: username.toLowerCase(),
          // Bots have no password that works. There is no hash that
          // bcrypt.compare will match, so nobody can log in as one.
          passwordHash: 'bot-account-no-login',
          cash: BOT_GRANT,
          startingGrant: BOT_GRANT,
          isBot: true,
          botStrategy: strategy.name,
        });
      } catch (err) {
        // One bad bot must not take the roster down with it. The first
        // version let a single validation error abort ensureBots
        // entirely, so no bots existed at all and the market sat silent
        // with the reason buried in a log line.
        log.error('could not create bot', { username, strategy: strategy.name, err: err.message });
        continue;
      }

      await redis
        .multi()
        .set(userCash(bot._id.toString()), BOT_GRANT)
        .incrby('econ:granted', BOT_GRANT)
        .exec();
      created += 1;
    }
  }

  log.info('bot roster ready', { created, total: await User.countDocuments({ isBot: true }) });
  return { created, total: await User.countDocuments({ isBot: true }) };
}

/**
 * One round of bot trading.
 *
 * Every bot looks at one randomly chosen good, applies its rule, and
 * either trades or does nothing. Most of them do nothing on most ticks,
 * which is what keeps the market from being a wall of noise.
 */
export async function botTick({ random = Math.random } = {}) {
  const bots = await User.find({ isBot: true }).lean();
  if (bots.length === 0) return { traded: 0, considered: 0 };

  const goods = await Good.find().lean();
  if (goods.length === 0) return { traded: 0, considered: 0 };

  const { Market } = await import('../models/Market.js');
  const markets = new Map((await Market.find().lean()).map((m) => [m.goodId.toString(), m]));

  const redis = getRedis();
  let traded = 0;
  const actions = [];

  for (const bot of bots) {
    const strategy = STRATEGIES[bot.botStrategy];
    if (!strategy) continue;

    const good = goods[Math.floor(random() * goods.length)];
    const id = good._id.toString();

    const [supplyRaw, baseRaw, cashRaw, heldRaw] = await Promise.all([
      redis.get(goodSupply(id)),
      redis.get(goodBasePrice(id)),
      redis.get(userCash(bot._id.toString())),
      redis.hget(userHoldings(bot._id.toString()), id),
    ]);
    if (supplyRaw === null || baseRaw === null) continue;

    const supply = Number(supplyRaw);
    const basePrice = Number(baseRaw);
    const cash = Number(cashRaw ?? bot.cash);
    const holding = Number(heldRaw ?? 0);

    const current = price(basePrice, supply, good.k, good.n);

    // Launch price is the market's original basePrice, which is what
    // "how far has this run" is measured against.
    const market = markets.get(id);
    const launchBase = market?.basePrice ?? basePrice;
    const launchPrice = price(launchBase, 0, good.k, good.n);

    const decision = strategy.decide({
      changePct: recentChange(id),
      fromLaunchPct: ((current - launchPrice) / launchPrice) * 100,
      // How far this bot is up on what it holds, so it has a reason to
      // take profit rather than only ever accumulating.
      upPct:
        holding > 0
          ? ((current - (entryPrices.get(`${bot._id}:${id}`) ?? current)) / current) * 100
          : 0,
      holding,
      cash,
      random,
    });
    if (!decision) continue;

    const cap = maxTradeQty(supply);
    let qty = Math.max(
      MIN_BOT_QTY,
      Math.floor(cap * SIZE_SCALE * decision.weight * (0.4 + random() * 0.6)),
    );
    // Never exceed the cap the real trade path enforces, or every bot
    // trade is rejected for size and the market goes quiet for a reason
    // nothing reports.
    qty = Math.min(qty, cap);

    if (decision.side === 'sell') {
      qty = Math.min(qty, holding, supply);
      if (qty < 1) continue;
    } else {
      // Never spend more than a fifth of the purse on one trade, so a
      // bot cannot bankrupt itself in a single move and go quiet.
      const affordable = Math.floor((cash * 0.2) / Math.max(1, current));
      qty = Math.min(qty, affordable);
      if (qty < 1) continue;
    }

    try {
      await executeTrade({
        userId: bot._id.toString(),
        goodId: id,
        side: decision.side,
        qty,
        // Bots accept a wide band. They are providing activity, not
        // trying to win, and a bot that refuses everything is a bot that
        // does nothing.
        slippageBps: 4_000,
      });
      traded += 1;
      actions.push(`${bot.username} ${decision.side} ${qty} ${good.name}`);
      noteTrade(id, decision.side);
      if (decision.side === 'buy') entryPrices.set(`${bot._id}:${id}`, current);
      else entryPrices.delete(`${bot._id}:${id}`);
    } catch {
      // Refused for funds, holdings, size or slippage - exactly as a
      // person would be. Nothing to do about it.
    }
  }

  if (traded > 0) log.debug('bot tick', { traded, actions: actions.slice(0, 4) });
  return { traded, considered: bots.length };
}

/**
 * A tiny in-memory memory of which way each good has been going.
 *
 * Momentum and contrarian bots need to know whether a price has been
 * rising or falling. Reading price history from Mongo on every bot for
 * every tick would be dozens of queries a minute for a number that only
 * has to be roughly right, so recent trade direction is tracked in
 * process instead.
 *
 * It resets on restart, which costs nothing - within a tick or two it
 * has filled up again.
 */
const recent = new Map();

/** Roughly what each bot paid, so it knows when it is up. In memory, like `recent`. */
const entryPrices = new Map();

function noteTrade(goodId, side) {
  const score = recent.get(goodId) ?? 0;
  const delta = side === 'buy' ? 1 : -1;
  // Exponential decay, so old trades stop mattering on their own.
  recent.set(goodId, score * 0.8 + delta);
}

function recentChange(goodId) {
  return recent.get(goodId) ?? 0;
}

export const BOT_STRATEGIES = STRATEGIES;
