-- keys: 6
--
-- Atomic trade execution.
--
-- This script is the point of the entire project. Redis runs a Lua
-- script from first line to last with nothing else interleaved - no
-- other command from any other client runs in the middle of it. So every
-- step below happens as one indivisible operation:
--
--   1. read supply and base price
--   2. compute the execution price from the curve
--   3. check it against the caller's slippage bound
--   4. check cash (buy) or holdings (sell)
--   5. mutate supply
--   6. mutate cash and holdings
--   7. move the reserve and burn counters
--
-- The Phase 4 version did exactly this in JavaScript, where the gap
-- between step 1 and step 5 let another request read the same supply.
-- Measured: eight concurrent buys of 100 units moved supply by 500
-- instead of 800, creating 300 units from nothing. See ADR-013.
--
-- Here there is no gap. Not a smaller gap - no gap.
--
-- KEYS                          ARGV
--   1 mkt:{good}:supply           1 side ('buy' | 'sell')
--   2 mkt:{good}:basePrice        2 qty
--   3 user:{id}:cash              3 goodId (field in the holdings hash)
--   4 user:{id}:holdings          4 k     (curve supply scale)
--   5 econ:reserve                5 n     (curve steepness)
--   6 econ:burned                 6 spreadBps
--                                 7 limit (max cost on a buy,
--                                          min return on a sell)
--                                 8 capBps
--                                 9 bootstrapQty
--
-- Returns { 'ok', supplyAfter, notional, spread, cashAfter }
--      or { 'error', code, ... }
--
-- Every number is returned as a string, formatted with '%.0f' rather
-- than tostring(). Two separate reasons:
--
--   Redis converts Lua numbers to integers on the way out, which would
--   silently truncate anything fractional.
--
--   tostring() on a Lua number switches to scientific notation past
--   about 1e14 and keeps only 14 significant digits, so a cost of
--   353041482706872 comes back as "3.5304148270687e+14" - off by 72
--   Notes. That was found by diffing this script against the JavaScript
--   curve across 6,993 parameter combinations; 36 of them disagreed,
--   every one of them above 1e14, every one a formatting loss rather
--   than a maths difference. '%.0f' prints the integer in full.

local supply_key   = KEYS[1]
local base_key     = KEYS[2]
local cash_key     = KEYS[3]
local holdings_key = KEYS[4]
local reserve_key  = KEYS[5]
local burned_key   = KEYS[6]

local side       = ARGV[1]
local qty        = tonumber(ARGV[2])
local good_id    = ARGV[3]
local k          = tonumber(ARGV[4])
local n          = tonumber(ARGV[5])
local spread_bps = tonumber(ARGV[6])
local limit      = tonumber(ARGV[7])
local cap_bps    = tonumber(ARGV[8])
local bootstrap  = tonumber(ARGV[9])

local BPS = 10000

local supply = tonumber(redis.call('GET', supply_key))
local base   = tonumber(redis.call('GET', base_key))

if supply == nil or base == nil then
  return { 'error', 'market_not_found' }
end

-- Helpers are defined here, above every use. Lua scopes a `local
-- function` from its definition downward only, so a helper declared
-- lower in the file is simply not visible above it - and because the
-- first use was on a rejection path, every happy-path test passed while
-- the size-cap rejection died with "nonexistent global variable 'fmt'".

-- Antiderivative of price(s) = base * (1 + s/k)^n.
-- The cost of moving supply from a to b is exactly integral(b) - integral(a).
local function integral(s)
  return (base * k / (n + 1)) * math.pow(1 + s / k, n + 1)
end

-- Print an integer-valued double in full, never in scientific notation.
local function fmt(x)
  return string.format('%.0f', x)
end

-- Cash absent is not the same as cash zero. A missing key means this
-- player was never loaded into Redis, and treating that as a zero
-- balance would report "insufficient funds" to someone who is not short
-- of funds. The caller seeds it from Mongo and retries.
local cash_raw = redis.call('GET', cash_key)
if cash_raw == false then
  return { 'error', 'cash_not_loaded' }
end
local cash = tonumber(cash_raw)

-- Per-trade size cap, with the floor that lets a brand new good be
-- bootstrapped - ten percent of zero supply is zero. See ADR-005.
local cap = math.max(bootstrap, math.floor(supply * cap_bps / BPS))
if qty > cap then
  return { 'error', 'trade_too_large', fmt(cap) }
end

if side == 'buy' then
  -- Rounded up: the buyer never pays less than the curve says, so
  -- rounding can only ever burn a fraction of a Note, never mint one.
  local cost = math.ceil(integral(supply + qty) - integral(supply))

  if cost > limit then
    return { 'error', 'slippage', fmt(cost), fmt(limit) }
  end
  if cost > cash then
    return { 'error', 'insufficient_funds', fmt(cost), fmt(cash) }
  end

  redis.call('SET', supply_key, supply + qty)
  redis.call('DECRBY', cash_key, cost)
  redis.call('HINCRBY', holdings_key, good_id, qty)
  redis.call('INCRBY', reserve_key, cost)


  return { 'ok', fmt(supply + qty), fmt(cost), '0', fmt(cash - cost) }
end

-- sell
local held = tonumber(redis.call('HGET', holdings_key, good_id)) or 0
if held < qty then
  return { 'error', 'insufficient_holdings', fmt(qty), fmt(held) }
end
if qty > supply then
  return { 'error', 'insufficient_supply' }
end

-- Rounded down, for the same reason the buy rounds up.
local gross  = math.floor(integral(supply) - integral(supply - qty))
local net    = math.floor(gross * (BPS - spread_bps) / BPS)
local spread = gross - net

if net < limit then
  return { 'error', 'slippage', fmt(net), fmt(limit) }
end

redis.call('SET', supply_key, supply - qty)
redis.call('INCRBY', cash_key, net)
redis.call('HINCRBY', holdings_key, good_id, -qty)
redis.call('DECRBY', reserve_key, gross)
redis.call('INCRBY', burned_key, spread)


return { 'ok', fmt(supply - qty), fmt(net), fmt(spread), fmt(cash + net) }
