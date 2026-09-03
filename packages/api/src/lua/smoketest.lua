-- keys: 1
--
-- A trivial script with no purpose beyond proving, at boot, that the
-- whole Lua path works end to end: the loader found the file, Redis
-- accepted it, the SHA cached, and EVALSHA round-tripped. Phase 5 puts
-- the actual trade execution through this same machinery, and a
-- scripting problem is far cheaper to discover here than there.
--
-- Named "smoketest" rather than "ping" on purpose. See the loader: a
-- script's filename becomes a method on the Redis client, so a script
-- called ping.lua replaces redis.ping() with itself.

redis.call('SET', KEYS[1], ARGV[1], 'EX', 10)
return redis.call('GET', KEYS[1])
