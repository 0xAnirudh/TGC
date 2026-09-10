import { z } from 'zod';

export const quoteQuerySchema = z.object({
  side: z.enum(['buy', 'sell'], { message: "side must be 'buy' or 'sell'" }),
  qty: z.coerce
    .number()
    .int('qty must be a whole number of units')
    .positive('qty must be greater than zero')
    .max(1_000_000, 'qty is implausibly large'),
});

export const tradeBodySchema = z.object({
  goodId: z.string().min(1, 'goodId is required'),
  side: z.enum(['buy', 'sell'], { message: "side must be 'buy' or 'sell'" }),
  qty: z
    .number()
    .int('qty must be a whole number of units')
    .positive('qty must be greater than zero')
    .max(1_000_000, 'qty is implausibly large'),

  /**
   * How far the price may move against the caller, in basis points,
   * between this request being priced and the trade executing.
   *
   * Note what this is not: a price. A client that could name its own
   * price could name a stale low one and be filled at it. A tolerance
   * only ever lets the caller *refuse* a fill - the curve still decides
   * what the trade costs.
   *
   * Zero is allowed and means "execute only at exactly the price this
   * request was quoted at", which will fail under any concurrent
   * activity. The cap of 5000 (50%) exists so a fat-fingered tolerance
   * cannot become an open invitation.
   */
  slippageBps: z
    .number()
    .int('slippageBps must be a whole number')
    .min(0, 'slippageBps cannot be negative')
    .max(5_000, 'slippageBps above 5000 (50%) is not a tolerance, it is a blank cheque')
    .optional(),
});
