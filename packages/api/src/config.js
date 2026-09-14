import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Load .env from the repository root, not from the current directory.
 *
 * There is one .env for the whole monorepo, but the working directory
 * depends on how a process was started: `npm run dev --workspace=@tgc/api`
 * runs in packages/api, the seed script the same, vitest at the root.
 * Plain `dotenv/config` reads ./.env relative to cwd, so two of those
 * three find nothing and the process exits complaining that MONGO_URI is
 * missing when it is sitting right there.
 *
 * Resolving from this file's own location makes it cwd-independent.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config({ path: join(REPO_ROOT, '.env'), quiet: true });

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

  /**
   * bcrypt work factor.
   *
   * 12 is the production setting. Tests override it to 4 because at 12 a
   * single hash costs roughly a quarter second, and a suite that
   * registers a few dozen users would spend most of its runtime waiting
   * on a deliberately slow function. Lowering it in tests weakens
   * nothing real - it is the same code path, just cheaper - but it must
   * never be lowered outside them, so production refuses anything under
   * 10 below.
   */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Job cadence, as cron expressions.
   *
   * Configurable because a hosted Redis free tier is billed per command,
   * and the idle cost of these jobs is what actually consumes it. At the
   * development cadence - drift every minute, revaluation every two -
   * the system issues roughly 47 commands a minute doing nothing at all,
   * which is about 68,000 a day. Upstash's free tier allows 500,000 a
   * month, so the defaults would exhaust a month in a week before a
   * single trade was placed.
   *
   * Production slows both down. See docs/DEPLOYMENT.md for the maths.
   */
  DRIFT_CRON: z.string().default('* * * * *'),

  /**
   * How often bots trade and events fire, in seconds.
   *
   * Seconds rather than cron, because cron cannot express anything
   * faster than a minute and a minute is far too slow. The market
   * felt dead at the old cadence: prices moved once a minute and
   * nothing else ever happened, so there was nothing to watch and
   * nothing to react to.
   *
   * Hosted Redis is billed per command, so production runs these
   * slower - see docs/DEPLOYMENT.md.
   */
  BOT_INTERVAL_SEC: z.coerce.number().int().min(2).max(600).default(6),
  EVENT_INTERVAL_SEC: z.coerce.number().int().min(5).max(3_600).default(45),

  /** Drift, also in seconds. Same reasoning. */
  DRIFT_INTERVAL_SEC: z.coerce.number().int().min(2).max(600).default(10),
  REVALUE_CRON: z.string().default('*/2 * * * *'),
  NEWSPAPER_CRON: z.string().default('0 * * * *'),

  /**
   * How long the relay blocks waiting for new stream entries.
   *
   * Every expiry is one command. At 5 seconds that is 12 a minute
   * forever; at 30 it is 2. The cost of the longer block is up to 30
   * seconds of extra latency before a trade reaches Mongo, which matters
   * to nothing on the read path - the live state is in Redis.
   */
  RELAY_BLOCK_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),

  /**
   * Run the relay and job runner inside the API process.
   *
   * They are separate processes by design and separate processes in
   * development. This exists because Render's free tier has no
   * background workers - they start at $7/month each - so a free
   * deployment has to co-locate them. Nothing about the code changes;
   * only where it runs.
   */
  EMBED_WORKERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Invalid environment configuration:\n${issues.join('\n')}`);
  console.error(`\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.BCRYPT_ROUNDS < 10) {
  console.error(
    `BCRYPT_ROUNDS is ${parsed.data.BCRYPT_ROUNDS} in production. ` +
      `Anything under 10 makes stolen hashes cheap to crack offline.`,
  );
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
