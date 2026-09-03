import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at boot.
 *
 * Reading process.env directly all over the codebase means a missing
 * variable surfaces as `undefined` at whatever moment that code path
 * first runs - often in production, often as a confusing downstream
 * error. Parsing it here means a misconfigured process refuses to start
 * and says exactly which variable is wrong.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB_NAME: z.string().default('tgc'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_TTL: z.string().default('7d'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
  console.error(`\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
