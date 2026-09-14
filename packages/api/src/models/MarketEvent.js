import mongoose from 'mongoose';

/**
 * A shock to one good.
 *
 * Events are the only thing in the game that moves a price for a reason
 * a player did not cause. Without them, every movement traces back to
 * somebody's trade, and there is nothing to react to - only things to
 * do.
 *
 * Stored rather than applied and forgotten, so the newspaper can report
 * them and a profile can show that you were holding Cobalt the day the
 * mine collapsed.
 */
const marketEventSchema = new mongoose.Schema(
  {
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true, index: true },
    goodName: { type: String, required: true },

    kind: { type: String, required: true },
    headline: { type: String, required: true },

    /** How hard it hit, in basis points. Negative is a crash. */
    impactBps: { type: Number, required: true },

    priceBefore: { type: Number, required: true },
    priceAfter: { type: Number, required: true },

    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

marketEventSchema.index({ at: -1 });

export const MarketEvent = mongoose.model('MarketEvent', marketEventSchema);
