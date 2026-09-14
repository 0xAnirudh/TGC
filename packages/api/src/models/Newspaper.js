import mongoose from 'mongoose';

/**
 * The daily paper.
 *
 * Each headline stores its template name and the facts it was built
 * from, not only the rendered sentence. That separation is what keeps
 * the paper a record rather than prose: the facts stay machine-readable
 * and checkable, and the wording can be rewritten later without
 * reinterpreting history.
 *
 * It is also the seam an LLM would slot into if the idea is ever
 * revisited (section 26.4) - generated text would fill `text` while
 * `template` and `params` remain the deterministic account of what
 * actually happened.
 */
const newspaperSchema = new mongoose.Schema(
  {
    // YYYY-MM-DD. Unique, so regenerating a day cannot produce two papers.
    date: { type: String, required: true, unique: true, index: true },
    headlines: [
      {
        _id: false,
        template: { type: String, required: true },
        params: { type: mongoose.Schema.Types.Mixed, default: {} },
        text: { type: String, required: true },
      },
    ],
    tradeCount: { type: Number, default: 0 },
    volume: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Newspaper = mongoose.model('Newspaper', newspaperSchema);
