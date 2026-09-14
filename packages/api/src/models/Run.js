import mongoose from 'mongoose';
import { RUN_DAYS } from '@tgc/shared';

/**
 * One attempt at the game.
 *
 * The seed is the important field. Every price in the run is a pure
 * function of it, so a finished run can be replayed from its action log
 * and its score recomputed - which is what makes the leaderboard
 * something other than a list of numbers clients reported about
 * themselves.
 *
 * The seed is generated server-side and never sent to the client while
 * the run is live. Knowing it would let a player compute tomorrow's
 * prices in every town, which is the one thing the game is built to
 * withhold.
 */
const runSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    seed: { type: String, required: true },

    day: { type: Number, default: 1, min: 1, max: RUN_DAYS },
    town: { type: String, required: true },
    cash: { type: Number, required: true },
    debt: { type: Number, required: true },
    capacity: { type: Number, required: true },

    /** goodId -> units. Small enough to live on the document. */
    cargo: { type: Map, of: Number, default: () => new Map() },

    status: {
      type: String,
      enum: ['active', 'finished', 'abandoned'],
      default: 'active',
      index: true,
    },

    /** Set when the run ends. Cash after the cart is sold and debt settled. */
    score: { type: Number, default: null },
    /** Whether the debt was cleared, or it ate the run. */
    ruined: { type: Boolean, default: false },

    /** Bumped on every action, so the replay knows how many to expect. */
    seq: { type: Number, default: 0 },

    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The leaderboard reads exactly this.
runSchema.index({ status: 1, score: -1 });
// One active run per player, enforced rather than assumed.
runSchema.index({ userId: 1, status: 1 });

export const Run = mongoose.model('Run', runSchema);

/**
 * The action log.
 *
 * Append-only, one row per thing the player did. Replaying these in
 * order against the seed reproduces the run exactly - that is both the
 * anti-cheat story and the reason a run can be audited after the fact.
 */
const runActionSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'Run', required: true, index: true },
    seq: { type: Number, required: true },
    day: { type: Number, required: true },
    town: { type: String, required: true },

    type: {
      type: String,
      required: true,
      enum: ['buy', 'sell', 'travel', 'repay', 'upgrade', 'event'],
    },
    good: { type: String, default: null },
    qty: { type: Number, default: 0 },

    /** Notes that moved. Positive is into the player's hand. */
    amount: { type: Number, default: 0 },

    /** State after the action, so a replay can assert rather than assume. */
    cashAfter: { type: Number, required: true },
    debtAfter: { type: Number, required: true },

    /** For events: which one fired, and what it did. */
    note: { type: String, default: null },

    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

runActionSchema.index({ runId: 1, seq: 1 }, { unique: true });

export const RunAction = mongoose.model('RunAction', runActionSchema);
