import mongoose from 'mongoose';

/**
 * A price reading for one good at one moment.
 *
 * Written by the drift job on every tick, and read by the history
 * endpoint to draw a chart. Deliberately stores `supply` and `basePrice`
 * as well as the price, because the price is derivable from those two
 * plus the curve - so a snapshot is enough to recompute what the market
 * looked like, not just what it cost.
 */
const priceSnapshotSchema = new mongoose.Schema(
  {
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true },
    region: { type: String, required: true, default: 'harbour' },
    price: { type: Number, required: true },
    supply: { type: Number, required: true },
    basePrice: { type: Number, required: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

// Every history query is "this good, this time range, in order".
priceSnapshotSchema.index({ goodId: 1, region: 1, at: -1 });

// Snapshots are the largest-growing collection in the system and nothing
// reads one older than a month, so Mongo expires them rather than a job
// having to remember to.
priceSnapshotSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const PriceSnapshot = mongoose.model('PriceSnapshot', priceSnapshotSchema);
