import mongoose from 'mongoose';
import { MIN_CURVE_N, MAX_CURVE_N, MIN_CURVE_K } from '@tgc/shared';

/**
 * A tradeable good.
 *
 * `k` and `n` are this good's curve shape and never change once it is
 * created. They are what make one good feel different from another:
 *
 *   price(supply) = basePrice * (1 + supply/k) ^ n
 *
 *   k  how much supply it takes to move the price. Small k = thin and
 *      jumpy, large k = deep and slow.
 *   n  how sharply the price accelerates. n=1 is nearly linear, n=3 is
 *      steep.
 *
 * Both are bounded. An issuer picking n=50 in Phase 11 would create a
 * good whose price goes vertical after a handful of trades, which is not
 * a market - it is a trap for whoever buys second.
 */
const goodSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 24 },

    /** Uniqueness on a lowercase copy, same reasoning as usernames. */
    nameLower: { type: String, required: true, unique: true, lowercase: true, index: true },

    /** A palette name the frontend maps to a colour. Not a hex code, so
     *  the UI owns its own palette and goods cannot set unreadable
     *  colours. */
    colorToken: { type: String, required: true, default: 'slate' },

    /** null for goods seeded with the world; set for player-issued ones
     *  in Phase 11. */
    issuerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    k: { type: Number, required: true, min: MIN_CURVE_K },
    n: { type: Number, required: true, min: MIN_CURVE_N, max: MAX_CURVE_N },
  },
  { timestamps: true },
);

goodSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    name: this.name,
    colorToken: this.colorToken,
    issuerId: this.issuerId ? this.issuerId.toString() : null,
    k: this.k,
    n: this.n,
  };
};

export const Good = mongoose.model('Good', goodSchema);
