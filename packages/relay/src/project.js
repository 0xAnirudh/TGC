import mongoose from 'mongoose';
import { Trade } from '@tgc/api/src/models/Trade.js';
import { User } from '@tgc/api/src/models/User.js';
import { Holding } from '@tgc/api/src/models/Holding.js';
import { Market } from '@tgc/api/src/models/Market.js';

/**
 * Turn one stream entry into Mongo rows.
 *
 * Every write here is idempotent, because delivery is at-least-once: if
 * the worker dies between writing and acknowledging, Redis hands the
 * same entry back. So this must be safe to run twice with no second
 * effect.
 *
 * The ledger row is an upsert keyed on the stream id. The balances are
 * *absolute assignments* rather than increments - `cash` is set to the
 * value the trade produced, not decremented by the amount - which is
 * what makes replaying an entry harmless. An increment applied twice
 * would be wrong; an assignment applied twice is the same assignment.
 *
 * Holdings are the exception, because the stream entry does not carry
 * the resulting quantity. They are recomputed from the trade rows for
 * that user and good, which is slower but cannot drift.
 */
export async function projectEntry(streamId, fields) {
  const userId = new mongoose.Types.ObjectId(fields.userId);
  const goodId = new mongoose.Types.ObjectId(fields.goodId);
  const qty = Number(fields.qty);
  const notional = Number(fields.notional);
  const spread = Number(fields.spread);
  const supplyAfter = Number(fields.supplyAfter);

  // Insert, and let the unique index on streamId tell us whether this
  // entry has been seen before.
  //
  // The obvious alternative - findOneAndUpdate with upsert, then read
  // whether it matched - is how this was first written, using Mongoose's
  // `rawResult` option to get at `lastErrorObject.updatedExisting`. That
  // option no longer exists in Mongoose 9: it is silently ignored, the
  // metadata comes back null, and every delivery therefore looked like a
  // first delivery. The counters below would have been incremented again
  // on every redelivery - precisely the double-counting the stream id
  // exists to prevent.
  //
  // A plain insert plus a duplicate-key catch has no such dependency on
  // a driver option. The index decides, the same way it decides
  // usernames (ADR-009).
  let firstDelivery = true;
  try {
    await Trade.create({
      streamId,
      userId,
      goodId,
      side: fields.side,
      quantity: qty,
      supplyBefore: Number(fields.supplyBefore),
      supplyAfter,
      basePrice: Number(fields.basePrice),
      notional,
      spread,
      avgPrice: notional / qty,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    firstDelivery = false;
  }

  await User.updateOne({ _id: userId }, { $set: { cash: Number(fields.cashAfter) } });
  await Market.updateOne({ goodId }, { $set: { supply: supplyAfter } });
  if (firstDelivery) {
    await User.updateOne({ _id: userId }, { $inc: { tradeCount: 1 } });
    await Market.updateOne({ goodId }, { $inc: { vol24h: qty } });
  }

  await rebuildHolding(userId, goodId);
  return { firstDelivery };
}

/**
 * Recompute one holding from the trade rows.
 *
 * Quantity and weighted average cost both come out of the ledger rather
 * than being incremented in place, so a duplicated or out-of-order
 * delivery cannot leave a holding wrong. The cost basis follows the
 * usual rule: buys move the average, sells do not.
 */
async function rebuildHolding(userId, goodId) {
  const trades = await Trade.find({ userId, goodId }).sort({ streamId: 1 }).lean();

  let quantity = 0;
  let avgCost = 0;

  for (const t of trades) {
    if (t.side === 'buy') {
      const totalCost = avgCost * quantity + t.notional;
      quantity += t.quantity;
      avgCost = quantity > 0 ? totalCost / quantity : 0;
    } else {
      quantity -= t.quantity;
      if (quantity <= 0) {
        quantity = 0;
        avgCost = 0;
      }
    }
  }

  await Holding.updateOne({ userId, goodId }, { $set: { quantity, avgCost } }, { upsert: true });
}
