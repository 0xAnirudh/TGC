import { z } from 'zod';

/**
 * bcrypt hashes at most the first 72 *bytes* of a password and silently
 * ignores the rest. Two different 100-character passwords sharing a
 * 72-byte prefix therefore produce the same hash, and a user who
 * believes a very long passphrase is stronger would be wrong in a way
 * nothing tells them about.
 *
 * Rejecting explicitly is the honest option. The check is on byte
 * length, not character count, because a passphrase with any non-ASCII
 * character reaches 72 bytes well before 72 characters.
 */
const BCRYPT_MAX_BYTES = 72;

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= BCRYPT_MAX_BYTES, {
    message: `Password must be at most ${BCRYPT_MAX_BYTES} bytes (bcrypt ignores anything beyond that)`,
  });

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(20, 'Username must be at most 20 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain only letters, numbers and underscores');

export const registerSchema = z.object({ username, password });

// Deliberately not the registration schema. Tightening the username
// rules later must not lock existing accounts out of logging in, so
// login accepts whatever is stored and lets the lookup fail.
export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});
