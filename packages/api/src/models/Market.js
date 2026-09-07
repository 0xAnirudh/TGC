import mongoose from 'mongoose';

/**
 * The live state of one good's market.
 *
 * One document per good. v1 runs a single global market, so there is no
 * region dimension here - see IMPLEMENTATION_PLAN.md section 26.6 for
 * what v2 adds back.
 *
 * This is the *durable* copy. The authoritative live copy lives in Redis
 * under mkt:{goodId}:supply and mkt:{goodId}:basePrice, because supply
 * has to be read and mutated inside a single atomic operation from Phase
 * 5 onward. This document is what Redis is warmed from on a cold start.
 */
const marketSchema = new mongoose.Schema(
  {
    goodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Good',
      required: true,
      unique: true,
      index: true,
    },

    /** Price at zero supply. Moved by the drift job in Phase 8. */
    basePrice: { type: Number, required: true, min: 1 },

    /** Units in existence. Integer - you cannot own half a unit. */
    supply: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: (props) => `supply must be a whole number, got ${props.value}`,
      },
    },

    /** Rolling 24h traded volume, written by a job. Display only. */
    vol24h: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const Market = mongoose.model('Market', marketSchema);
