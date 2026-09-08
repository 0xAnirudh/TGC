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
});
