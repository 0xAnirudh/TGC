import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { ApiError } from '../util/errors.js';

/**
 * Verify the bearer token and attach its claims.
 *
 * Deliberately does not load the user from Mongo. Most authenticated
 * routes - trading above all - need nothing but the user id, and a Mongo
 * round trip on every request would put a database read in front of a
 * hot path that is otherwise served entirely from Redis. Routes that
 * genuinely need the document ask for it with `requireUser`.
 *
 * The cost of that choice: a token stays valid until it expires even if
 * the account is deleted, because nothing checks. With a 7 day TTL and
 * no deletion flow in v1 that is acceptable; a revocation list in Redis
 * is the fix if it stops being.
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization');

  if (!header) {
    return next(ApiError.unauthorized('missing_token', 'Authorization header is required'));
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('malformed_token', 'Authorization must be "Bearer <token>"'));
  }

  try {
    const claims = jwt.verify(token, config.JWT_SECRET);
    req.auth = { userId: claims.sub, username: claims.username };
    next();
  } catch (err) {
    // Expiry is told apart from every other failure because the client
    // can act on it - refresh or re-login. A bad signature is not
    // something a client can fix, and saying more about why would help
    // whoever forged it more than it helps anyone honest.
    if (err.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('token_expired', 'Token has expired'));
    }
    next(ApiError.unauthorized('invalid_token', 'Token is not valid'));
  }
}

/**
 * Load the authenticated user's document. Use only on routes that need
 * more than the id.
 */
export async function requireUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      // A valid signature over an account that no longer exists.
      return next(ApiError.unauthorized('account_missing', 'Account no longer exists'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
