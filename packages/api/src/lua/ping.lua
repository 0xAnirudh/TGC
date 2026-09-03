-- keys: 1
--
-- A trivial script with no purpose beyond proving, at boot, that the
-- whole Lua path works end to end: the loader found the file, Redis
-- accepted it, the SHA cached, and EVALSHA round-tripped. Phase 5 puts
-- the actual trade execution through this same machinery, and a
-- scripting problem is far cheaper to discover here than there.

redis.call('SET', KEYS[1], ARGV[1], 'EX', 10)
return redis.call('GET', KEYS[1])
