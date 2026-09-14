import { Trade } from '../models/Trade.js';
import { Good } from '../models/Good.js';
import { User } from '../models/User.js';
import { PriceSnapshot } from '../models/PriceSnapshot.js';
import { Newspaper } from '../models/Newspaper.js';
import { log } from '../log.js';
import { REGIONS } from '@tgc/shared';

/**
 * The daily newspaper.
 *
 * Rule-based templates, no LLM - see IMPLEMENTATION_PLAN.md section
 * 26.4. Three facts about yesterday, stated plainly: the biggest riser,
 * the biggest faller, and the largest single trade.
 *
 * An LLM in a daily cron job would add an API key to manage, a network
 * failure mode, a cost line and non-determinism, to produce three
 * sentences a template produces reliably and testably.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const notes = (n) => Math.round(n).toLocaleString('en-US');

const TEMPLATES = {
  top_gainer: (p) => `${p.name} climbed ${p.changePct}% to ${notes(p.price)} Notes.`,
  top_loser: (p) => `${p.name} slid ${Math.abs(p.changePct)}% to ${notes(p.price)} Notes.`,
  biggest_trade: (p) =>
    `${p.username} moved ${notes(p.quantity)} units of ${p.name} for ${notes(p.notional)} Notes.`,
  quiet_day: () => `The market was quiet. No trades were recorded.`,
  volume: (p) => `${notes(p.tradeCount)} trades changed hands, worth ${notes(p.volume)} Notes.`,
};

function render(template, params) {
  return { template, params, text: TEMPLATES[template](params) };
}

export function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * Price movement per good over the window, from snapshots.
 *
 * Uses the first and last snapshot rather than comparing to a live
 * price, so the figure is reproducible: regenerating a past day gives
 * the same answer it gave at the time.
 */
async function movements(since, until) {
  const goods = await Good.find().lean();
  const out = [];

  for (const good of goods) {
    for (const region of REGIONS) {
      // Compared WITHIN one market. Taking the first and last snapshot
      // across all regions compares the harbour's opening price against
      // the frontier's closing one, which is not a movement - it is a
      // price gap, and it would report every good as a wild mover every
      // single day.
      const [first, last] = await Promise.all([
        PriceSnapshot.findOne({
          goodId: good._id,
          region: region.id,
          at: { $gte: since, $lt: until },
        })
          .sort({ at: 1 })
          .lean(),
        PriceSnapshot.findOne({
          goodId: good._id,
          region: region.id,
          at: { $gte: since, $lt: until },
        })
          .sort({ at: -1 })
          .lean(),
      ]);

      if (!first || !last || first.price === 0 || String(first._id) === String(last._id)) continue;

      out.push({
        name: `${good.name} in ${region.name}`,
        price: last.price,
        changePct: Math.round(((last.price - first.price) / first.price) * 10_000) / 100,
      });
    }
  }
  return out;
}

export async function generateNewspaper({ date = new Date() } = {}) {
  const key = dateKey(date);
  const until = new Date(date);
  const since = new Date(until.getTime() - DAY_MS);

  const trades = await Trade.find({ createdAt: { $gte: since, $lt: until } }).lean();
  const headlines = [];

  if (trades.length === 0) {
    headlines.push(render('quiet_day', {}));
  } else {
    const moves = await movements(since, until);

    const gainers = moves.filter((m) => m.changePct > 0).sort((a, b) => b.changePct - a.changePct);
    const losers = moves.filter((m) => m.changePct < 0).sort((a, b) => a.changePct - b.changePct);

    if (gainers[0]) headlines.push(render('top_gainer', gainers[0]));
    if (losers[0]) headlines.push(render('top_loser', losers[0]));

    const biggest = trades.reduce((a, b) => (b.notional > a.notional ? b : a));
    const [good, user] = await Promise.all([
      Good.findById(biggest.goodId).lean(),
      User.findById(biggest.userId).lean(),
    ]);

    if (good && user) {
      headlines.push(
        render('biggest_trade', {
          username: user.username,
          name: good.name,
          quantity: biggest.quantity,
          notional: biggest.notional,
        }),
      );
    }

    headlines.push(
      render('volume', {
        tradeCount: trades.length,
        volume: trades.reduce((sum, t) => sum + t.notional, 0),
      }),
    );
  }

  const doc = {
    date: key,
    headlines,
    tradeCount: trades.length,
    volume: trades.reduce((sum, t) => sum + t.notional, 0),
  };

  // Upsert on the date, so running the job twice for one day replaces
  // that day's paper rather than printing a second one.
  await Newspaper.updateOne({ date: key }, { $set: doc }, { upsert: true });
  log.info('newspaper generated', { date: key, headlines: headlines.length });

  return doc;
}

export async function latestNewspaper() {
  return Newspaper.findOne().sort({ date: -1 }).lean();
}

export async function newspaperFor(date) {
  return Newspaper.findOne({ date }).lean();
}
