import mongoose from 'mongoose';

/**
 * One executed trade. Immutable.
 *
 * This is the ledger. From Phase 6 it stops being written directly and
 * becomes a projection of a Redis stream, and the entire market can be
 * rebuilt by replaying these rows in order - which is both the disaster
 * recovery path and the proof that the books are honest.
 *
 * Because of that, the fields here are not a log for humans to read.
 * They are everything needed to reconstruct state: who, which good,
 * which direction, how many, and exactly how many Notes moved.
 */
const tradeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true, index: true },

    side: { type: String, required: true, enum: ['buy', 'sell'] },
    quantity: { type: Number, required: true, min: 1 },

    /** Supply before this trade. Replay needs it to verify, not guess. */
    supplyBefore: { type: Number, required: true, min: 0 },
    supplyAfter: { type: Number, required: true, min: 0 },

    /** basePrice at execution, so replay is not at the mercy of drift. */
    basePrice: { type: Number, required: true },

    /** Notes that actually changed hands. Paid on a buy, received on a sell. */
    notional: { type: Number, required: true, min: 0 },

    /** Burned on a sell, always 0 on a buy. */
    spread: { type: Number, required: true, min: 0, default: 0 },

    /** Average per unit. Display only - never used to recompute anything. */
    avgPrice: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The market page and the newspaper both want "recent trades in this
// good", which is this index.
tradeSchema.index({ goodId: 1, createdAt: -1 });
tradeSchema.index({ userId: 1, createdAt: -1 });

tradeSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    goodId: this.goodId.toString(),
    side: this.side,
    quantity: this.quantity,
    notional: this.notional,
    spread: this.spread,
    avgPrice: this.avgPrice,
    at: this.createdAt,
  };
};

export const Trade = mongoose.model('Trade', tradeSchema);
