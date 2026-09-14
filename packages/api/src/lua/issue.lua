-- keys: 2
--
-- Charge the issuing fee and burn it.
--
-- KEYS            ARGV
--   1 user cash     1 fee
--   2 econ:burned
--
-- Returns { 'ok', cashAfter } or { 'error', code, ... }
--
-- Small, but it has to be atomic for the same reason a trade does: check
-- the balance and deduct it in two steps and two concurrent issue
-- requests can both see enough cash and both spend it.
--
-- The fee is burned rather than collected. Issuing is meant to cost
-- something, and a fee paid into a treasury would be a pot that has to
-- be managed, spent or justified. Burning makes it a pure sink, which is
-- also the only form that keeps the money supply invariant simple.

local cash_key   = KEYS[1]
local burned_key = KEYS[2]
local fee        = tonumber(ARGV[1])

local cash_raw = redis.call('GET', cash_key)
if cash_raw == false then
  return { 'error', 'cash_not_loaded' }
end

local cash = tonumber(cash_raw)
if cash < fee then
  return { 'error', 'insufficient_funds', string.format('%.0f', fee), string.format('%.0f', cash) }
end

redis.call('DECRBY', cash_key, fee)
redis.call('INCRBY', burned_key, fee)

return { 'ok', string.format('%.0f', cash - fee) }
