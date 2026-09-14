import mongoose from 'mongoose';

/**
 * An open short position.
 *
 * Shorting is a bet that a price will fall. You borrow units you do not
 * own, sell them immediately, and later buy them back to return them. If
 * the price fell, you keep the difference; if it rose, you pay it.
 *
 * WHY THIS NEEDS COLLATERAL. A long position can lose at most what you
 * paid - the price can fall to zero and no further. A short has no such
 * floor: the price can rise without limit, so the loss can exceed
 * everything the player owns. Without collateral held up front, a player
 * could open a short, watch it go against them, and simply walk away
 * from a debt the economy would then have to absorb - which would mint
 * Notes from nothing and break the money supply invariant.
 *
 * So opening a short locks collateral, and the position is force-closed
 * if the price rises far enough to threaten it. The player can lose
 * their collateral. They cannot lose more than it.
 */
const shortPositionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true, index: true },

    /** Where it was opened. A short is a promise to return units here. */
    region: { type: String, required: true, default: 'harbour' },

    /** Units borrowed and sold. */
    quantity: { type: Number, required: true, min: 1 },

    /** What the sale brought in, after spread. Held, not spendable. */
    proceeds: { type: Number, required: true, min: 0 },

    /** Notes locked up front against the position moving against them. */
    collateral: { type: Number, required: true, min: 0 },

    /** Price per unit when opened. What the outcome is measured against. */
    entryPrice: { type: Number, required: true },

    /**
     * The price at which this is force-closed.
     *
     * Set when the position opens so it never has to be recomputed, and
     * so a player can see it before committing.
     */
    liquidationPrice: { type: Number, required: true },

    status: {
      type: String,
      enum: ['open', 'closed', 'liquidated'],
      default: 'open',
      index: true,
    },

    /** Filled in on close. Negative is a loss. */
    realizedPL: { type: Number, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

shortPositionSchema.index({ userId: 1, status: 1 });
shortPositionSchema.index({ goodId: 1, status: 1 });

shortPositionSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    goodId: this.goodId.toString(),
    region: this.region,
    quantity: this.quantity,
    proceeds: this.proceeds,
    collateral: this.collateral,
    entryPrice: this.entryPrice,
    liquidationPrice: this.liquidationPrice,
    status: this.status,
    realizedPL: this.realizedPL,
    openedAt: this.createdAt,
    closedAt: this.closedAt,
  };
};

export const ShortPosition = mongoose.model('ShortPosition', shortPositionSchema);
