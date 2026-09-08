import mongoose from 'mongoose';

/**
 * How much of one good one player owns.
 *
 * The compound unique index is what guarantees a player has exactly one
 * row per good. Without it, two concurrent buys could each insert a
 * fresh holding and the player would own the same good twice, with
 * neither row knowing about the other.
 *
 * `avgCost` is the weighted average of what was paid per unit, and it is
 * the only reason unrealised P/L can be shown at all - without a cost
 * basis, "you are up 12%" has nothing to be up *from*. It moves on buys
 * and is deliberately untouched by sells: selling half a position does
 * not change what the other half cost.
 */
const holdingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true, index: true },

    quantity: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: (props) => `quantity must be whole units, got ${props.value}`,
      },
    },

    /** Weighted average paid per unit. A float - it is a ratio, not money. */
    avgCost: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true },
);

holdingSchema.index({ userId: 1, goodId: 1 }, { unique: true });

export const Holding = mongoose.model('Holding', holdingSchema);
