import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { ApiError } from '../util/errors.js';

/**
 * A hash of nothing in particular, compared against when a login names
 * an account that does not exist.
 *
 * Without it, a missing username returns in under a millisecond while a
 * real one takes as long as bcrypt does, and that difference is a
 * reliable oracle for enumerating which accounts exist. Doing the work
 * anyway makes both paths cost the same.
 */
let decoyHash = null;
async function getDecoyHash() {
  decoyHash ??= await bcrypt.hash('decoy-password-never-matches', config.BCRYPT_ROUNDS);
  return decoyHash;
}

export function issueToken(user) {
  return jwt.sign({ sub: user._id.toString(), username: user.username }, config.JWT_SECRET, {
    expiresIn: config.JWT_TTL,
  });
}

export async function register({ username, password }) {
  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);

  let user;
  try {
    user = await User.create({
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
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

  return { user, token: issueToken(user) };
}

export async function login({ username, password }) {
  const user = await User.findOne({ usernameLower: username.toLowerCase() });

  // Compare regardless of whether the account exists, so both paths take
  // the same time. The result of the decoy comparison is discarded.
  const hash = user ? user.passwordHash : await getDecoyHash();
  const matches = await bcrypt.compare(password, hash);

  if (!user || !matches) {
    // One message for both cases. Saying "no such user" versus "wrong
    // password" hands an attacker a free account-enumeration oracle.
    throw ApiError.unauthorized('invalid_credentials', 'Username or password is incorrect');
  }

  return { user, token: issueToken(user) };
}
