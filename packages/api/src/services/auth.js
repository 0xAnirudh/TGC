import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { ApiError } from '../util/errors.js';
import { getRedis } from '../redis/client.js';
import { userCash, ECON_GRANTED } from '../redis/keys.js';
import { STARTING_GRANT } from '@tgc/shared';

export function issueToken(user) {
  return jwt.sign({ sub: user._id.toString(), username: user.username }, config.JWT_SECRET, {
    expiresIn: config.JWT_TTL,
  });
}

/**
 * Mirror a new account's cash into Redis and count the grant.
 *
 * Both writes go in one transaction so cash and the faucet total cannot
 * disagree. This is a dual write - Mongo first, then Redis - and it is
 * the same class of problem Phase 6 removes from the trade path. It is
 * tolerable here only because `startingGrant` on the User document is
 * the durable record: if this fails, Mongo is still correct and Redis is
 * repairable by replaying it, which is exactly what the Phase 3 warm and
 * the Phase 6 rebuild do.
 */
async function mirrorToRedis(user) {
  const redis = getRedis();
  await redis
    .multi()
    .set(userCash(user._id.toString()), user.cash)
    .incrby(ECON_GRANTED, user.startingGrant)
    .exec();
}

export async function register({ username, password }) {
  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);

  let user;
  try {
    user = await User.create({
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      cash: STARTING_GRANT,
      startingGrant: STARTING_GRANT,
    });
  } catch (err) {
    // Checking availability first and inserting second is a race: two
    // simultaneous registrations both see the name free and both
    // proceed. The unique index is the only thing that actually decides
    // it, so the duplicate-key error is the real check and this is where
    // it is handled.
    if (err.code === 11000) {
      throw ApiError.conflict('username_taken', 'That username is already taken');
    }
    throw err;
  }

  try {
    await mirrorToRedis(user);
  } catch (err) {
    log.error('failed to mirror new user to redis', {
      userId: user._id.toString(),
      err: err.message,
    });
  }

  return { user, token: issueToken(user) };
}
