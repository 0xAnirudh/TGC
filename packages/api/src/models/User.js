import mongoose from 'mongoose';

/**
 * A player account.
 *
 * Money does not live here.
 *
 * A player has no persistent balance in The Haul - each run carries its
 * own cash, debt and cart, and ends. This document is identity only:
 * who you are, and whether your finished runs are public.
 */

const userSchema = new mongoose.Schema(
  {
    /** As the player typed it. Shown on profiles and leaderboards. */
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },

    /**
     * Lowercased, and the field uniqueness is actually enforced on.
     *
     * Two accounts called "Trader" and "trader" are the same account to
     * every human who reads a leaderboard, so treating them as distinct
     * is an impersonation vector. A case-insensitive collation index
     * would also work, but a stored lowercase column behaves the same on
     * every Mongo version and is obvious when reading a document.
     */
    usernameLower: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },

    passwordHash: { type: String, required: true },

    /** FR-1.6: full portfolio, or net worth only. */
    portfolioPublic: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      /**
       * The hash must never leave the process. Stripping it here rather
       * than remembering to omit it at each call site means a new route
       * that returns a user document cannot leak it by accident.
       */
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** Public shape - what anyone may see about another player. */
userSchema.methods.toPublic = function toPublic() {
  return {
    username: this.username,
    portfolioPublic: this.portfolioPublic,
    memberSince: this.createdAt,
  };
};

/** Private shape - what the account holder sees about themselves. */
userSchema.methods.toPrivate = function toPrivate() {
  return {
    id: this._id.toString(),
    username: this.username,
    portfolioPublic: this.portfolioPublic,
    memberSince: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
