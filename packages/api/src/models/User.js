import mongoose from 'mongoose';

/**
 * A player account.
 *
 * `cash` is whole integer Notes, never a float. The money supply
 * invariant (NFR-5) requires the books to balance to the exact Note, and
 * a floating-point balance cannot express that requirement let alone
 * satisfy it - see ADR-002.
 *
 * From Phase 5 the authoritative copy of `cash` lives in Redis, because
 * it has to be mutated inside the same atomic block as supply. This
 * field remains as the durable record it is warmed from and rebuilt
 * into.
 */

const wholeNotes = {
  validator: Number.isInteger,
  message: (props) => `${props.path} must be whole Notes, got ${props.value}`,
};

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

    cash: { type: Number, required: true, min: 0, validate: wholeNotes },

    /** What this account was granted at registration. A faucet record. */
    startingGrant: { type: Number, required: true, validate: wholeNotes },

    tradeCount: { type: Number, default: 0, min: 0 },

    /** Written by the revaluation job in Phase 10, never on read. */
    netWorthCached: { type: Number, default: 0 },
    netWorthAt: { type: Date, default: null },

    /** FR-1.6: full portfolio, or net worth only. */
    portfolioPublic: { type: Boolean, default: true },

    lastBonusAt: { type: Date, default: null },
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
    netWorth: this.netWorthCached,
    portfolioPublic: this.portfolioPublic,
    memberSince: this.createdAt,
  };
};

/** Private shape - what the account holder sees about themselves. */
userSchema.methods.toPrivate = function toPrivate() {
  return {
    id: this._id.toString(),
    username: this.username,
    cash: this.cash,
    tradeCount: this.tradeCount,
    netWorth: this.netWorthCached,
    portfolioPublic: this.portfolioPublic,
    memberSince: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
