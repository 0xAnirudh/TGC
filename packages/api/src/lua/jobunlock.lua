-- keys: 1
--
-- Release a job lock, but only if we still hold it.
--
-- See joblock.lua. A plain DEL would let a process whose lock had
-- already expired delete the lock a different process now holds.

local key   = KEYS[1]
local token = ARGV[1]

if redis.call('GET', key) == token then
  return redis.call('DEL', key)
end
return 0
