-- keys: 1
--
-- Token bucket, consumed and refilled in one atomic step.
--
-- A bucket holds `capacity` tokens and refills at `refillPerSec`. A
-- request takes one token; if none are left it is refused. That shape
-- allows a short burst (up to the full capacity) while holding the
-- long-run average to the refill rate, which is what you actually want
-- from a trading API: a player clicking quickly is fine, a script
-- hammering it forever is not.
--
-- Why this is a script rather than INCR with an expiry:
--
--   A fixed window lets a caller fire a full window's worth at the very
--   end of one window and again at the start of the next - twice the
--   intended rate, at the worst possible moment.
--
--   Read-then-write in JavaScript reintroduces exactly the race Phase 5
--   removed from trading. Two requests both read one token left and both
--   spend it.
--
-- Time comes from Redis rather than the caller. The API is horizontally
-- scaled (NFR-7), and if each instance supplied its own clock, skew
-- between them would show up as buckets refilling at different rates
-- depending on which instance answered. One server, one clock.

local key            = KEYS[1]
local capacity       = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local cost           = tonumber(ARGV[3])

-- TIME returns { seconds, microseconds }.
local t = redis.call('TIME')
local now_ms = (tonumber(t[1]) * 1000) + (tonumber(t[2]) / 1000)

local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts     = tonumber(stored[2])

-- An unseen caller starts with a full bucket.
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now_ms
end

-- Refill for the time that has passed, never past the cap.
local elapsed_sec = math.max(0, now_ms - ts) / 1000
tokens = math.min(capacity, tokens + (elapsed_sec * refill_per_sec))

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)

-- Expire once the bucket would have refilled completely. Keeping it
-- longer stores nothing useful, and an idle caller's bucket is
-- indistinguishable from a fresh one anyway.
local full_refill_ms = math.ceil((capacity / refill_per_sec) * 1000)
redis.call('PEXPIRE', key, full_refill_ms + 1000)

-- Milliseconds until the next token is available. Zero when allowed.
local retry_after_ms = 0
if allowed == 0 then
  retry_after_ms = math.ceil(((cost - tokens) / refill_per_sec) * 1000)
end

return { allowed, string.format('%.4f', tokens), retry_after_ms }
