import mongoose from 'mongoose';
import { REGION_IDS, DEFAULT_REGION, BASE_CARGO } from '@tgc/shared';

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

    /** Which market this player is standing in. Trades use its prices. */
    location: { type: String, enum: REGION_IDS, default: DEFAULT_REGION, index: true },

    /** Set while travelling. Trading is refused until it passes. */
    arrivesAt: { type: Date, default: null },

    /**
     * How many units this player can carry, across all goods at once.
     *
     * The constraint that turns the game into a series of decisions.
     * Without it the right move is always "buy everything cheap, sell
     * everything dear" and there is nothing to choose; with it, cargo
     * space is the scarce resource and every purchase is a bet about
     * which good deserves the room.
     */
    cargoCapacity: { type: Number, default: BASE_CARGO, min: 0 },

    /**
     * Borrowed Notes, and what they have grown to.
     *
     * Debt is a faucet at the moment it is issued - the Notes are real
     * and enter circulation - so borrowing counts against ECON_GRANTED
     * and repayment counts back out. The interest is the interesting
     * part: it is charged against the debt, not minted, so a growing
     * balance costs the player without adding Notes to the world.
     */
    debt: { type: Number, default: 0, min: 0 },
    debtTakenAt: { type: Date, default: null },

    /**
     * Bot traders.
     *
     * They are ordinary Users - same cash, same holdings, same curve,
     * same rules - because the alternative is a parallel code path that
     * can drift away from the real one and stop being a fair test of it.
     * A bot that cannot afford a trade is refused exactly like a person.
     *
     * The flag exists so they can be told apart on the leaderboard and
     * excluded from anything that should only count humans.
     */
    isBot: { type: Boolean, default: false, index: true },

    /** Which algorithm drives this bot. Null for people. */
    botStrategy: {
      type: String,
      enum: ['momentum', 'contrarian', 'whale', 'jitter', 'dipBuyer', 'fader', null],
      default: null,
    },
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
    location: this.location,
    arrivesAt: this.arrivesAt,
    cargoCapacity: this.cargoCapacity,
    debt: this.debt,
  };
};

export const User = mongoose.model('User', userSchema);
