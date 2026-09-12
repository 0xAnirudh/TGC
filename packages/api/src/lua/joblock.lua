-- keys: 1
--
-- Acquire a job lock, or report who holds it.
--
-- Scheduled jobs must run exactly once per tick across every instance
-- (NFR-8). Several API or job processes all wake on the same cron
-- schedule, and without a lock every one of them would apply a drift
-- tick - so prices would move once per instance rather than once per
-- tick, and the drift bounds would be violated by exactly the number of
-- machines deployed.
--
-- SET NX PX is a single atomic operation, so only one caller can win.
-- The PX expiry is what makes it safe: a process that dies holding the
-- lock does not wedge the job forever.
--
-- The token matters on release. Without it, a process whose lock has
-- already expired - because it ran long - would delete a lock a *second*
-- process legitimately acquired, and then both would run. Release only
-- deletes the lock if the token still matches.

local key   = KEYS[1]
local token = ARGV[1]
local ttl   = tonumber(ARGV[2])

if redis.call('SET', key, token, 'NX', 'PX', ttl) then
  return 1
end
return 0
