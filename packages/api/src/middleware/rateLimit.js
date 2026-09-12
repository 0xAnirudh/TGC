import { getRedis } from '../redis/client.js';
import { rateLimitTrade, rateLimitAuth } from '../redis/keys.js';
import { ApiError } from '../util/errors.js';

/**
 * Rate limits.
 *
 * Trading is limited per account, not per IP: an account is the thing
 * that can actually move a market, and IPs are shared by everyone behind
 * one NAT.
 *
 * Auth is limited per IP, because there is no account yet to attribute a
 * login attempt to - that is the entire point of credential stuffing.
 */

export const TRADE_LIMIT = { capacity: 20, refillPerSec: 2 };

// Ten attempts, refilling over fifteen minutes. Slow enough to make
// guessing pointless, generous enough that someone who has genuinely
// forgotten their password is not locked out for the afternoon.
export const AUTH_LIMIT = { capacity: 10, refillPerSec: 10 / 900 };

function limiter({ keyFor, capacity, refillPerSec, code, message }) {
  return async (req, res, next) => {
    try {
      const [allowed, remaining, retryAfterMs] = await getRedis().ratelimit(
        keyFor(req),
        capacity,
        refillPerSec,
        1,
      );

      res.set('X-RateLimit-Limit', String(capacity));
      res.set('X-RateLimit-Remaining', String(Math.floor(Number(remaining))));

      if (allowed === 1) return next();

      // Seconds, rounded up, per the HTTP spec. A sub-second wait still
      // has to be reported as 1 rather than 0, or a client that trusts
      // the header retries immediately and is refused again.
      res.set('Retry-After', String(Math.max(1, Math.ceil(Number(retryAfterMs) / 1000))));
      next(ApiError.tooManyRequests(code, message));
    } catch (err) {
      next(err);
    }
  };
}

export const tradeRateLimit = limiter({
  keyFor: (req) => rateLimitTrade(req.auth.userId),
  ...TRADE_LIMIT,
  code: 'trade_rate_limited',
  message: 'You are trading too quickly. Slow down.',
});

export const authRateLimit = limiter({
  // req.ip honours trust proxy, which matters once this sits behind
  // Render or any load balancer - without it every request appears to
  // come from the proxy and one bucket throttles the whole world.
  keyFor: (req) => rateLimitAuth(req.ip),
  ...AUTH_LIMIT,
  code: 'auth_rate_limited',
  message: 'Too many attempts from this address. Try again shortly.',
});
