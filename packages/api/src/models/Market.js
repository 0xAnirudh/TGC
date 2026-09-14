import mongoose from 'mongoose';
import { REGION_IDS } from '@tgc/shared';

/**
 * The live state of one good's market.
 *
 * One document per good PER REGION. The same good has four of these,
 * each with its own supply and base price, which is what makes a good
 * cheap in the harbour and dear on the frontier.
 *
 * This is the *durable* copy. The authoritative live copy lives in Redis
 * under mkt:{goodId}:supply and mkt:{goodId}:basePrice, because supply
 * has to be read and mutated inside a single atomic operation from Phase
 * 5 onward. This document is what Redis is warmed from on a cold start.
 */
const marketSchema = new mongoose.Schema(
  {
    goodId: { type: mongoose.Schema.Types.ObjectId, ref: 'Good', required: true, index: true },

    region: { type: String, required: true, enum: REGION_IDS, index: true },

    /** The price this region started at. What "how far has it run" measures against. */
    launchPrice: { type: Number, required: true, min: 1 },

    /**
     * Units this market opened holding, before anyone traded.
     *
     * Recorded rather than recomputed. The rebuild derives every supply
     * CHANGE from the trade ledger, but opening stock is the one part of
     * supply that no trade created - so it has to start from a figure
     * that was written down when the market was made.
     *
     * This is not the same as trusting `supply`. That field is mutable
     * and the rebuild still ignores it entirely; this one is set once at
     * creation and never touched again, like launchPrice.
     */
    openingStock: { type: Number, required: true, default: 0, min: 0 },

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

// One market per good per region, and the index is what enforces it.
marketSchema.index({ goodId: 1, region: 1 }, { unique: true });

export const Market = mongoose.model('Market', marketSchema);
