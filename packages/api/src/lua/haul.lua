-- keys: 3
--
-- One action in a run, applied atomically.
--
-- KEYS                       ARGV
--   1 run:{id}                 1 action: buy | sell | travel | repay | upgrade
--   2 run:{id}:cargo           2 goodId (buy/sell) or townId (travel)
--   3 run:{id}:flow            3 qty / amount
--                              4 unitPrice for today, computed by the server
--                              5 impactScale
--                              6 capacityStep
--                              7 debtRateBps
--                              8 runDays
--                              9 capacityCost (upgrade only)
--
-- Returns { 'ok', day, cash, debt, capacity, town, moved } or
--         { 'error', code, ... }
--
-- WHY THIS IS A SCRIPT AND NOT FIVE REDIS CALLS.
--
-- Every action reads the run, decides against it, and writes it back. A
-- double-clicked buy issues two of those at once, and read-decide-write
-- run twice over the same starting cash spends it twice - the player
-- ends with two carts of goods and one cart's worth of money gone.
--
-- Redis runs a script start to finish with nothing interleaved, so the
-- second click sees the balance the first one left behind.
--
-- The PRICE is computed by the server and passed in rather than derived
-- here. It is a pure function of the run's seed, the day and the town,
-- so the client cannot influence it, and keeping the generator in one
-- language means the replay that verifies a finished run cannot drift
-- from the code that ran it.

local run_key   = KEYS[1]
local cargo_key = KEYS[2]
local flow_key  = KEYS[3]

local action        = ARGV[1]
local target        = ARGV[2]
local amount        = tonumber(ARGV[3])
local unit_price    = tonumber(ARGV[4])
local impact_scale  = tonumber(ARGV[5])
local capacity_step = tonumber(ARGV[6])
local debt_rate_bps = tonumber(ARGV[7])
local run_days      = tonumber(ARGV[8])
local upgrade_cost  = tonumber(ARGV[9])

local function fmt(x)
  return string.format('%.0f', x)
end

local state = redis.call('HMGET', run_key, 'day', 'cash', 'debt', 'town', 'capacity', 'status', 'seq')
if state[1] == false then
  return { 'error', 'no_run' }
end

local day      = tonumber(state[1])
local cash     = tonumber(state[2])
local debt     = tonumber(state[3])
local town     = state[4]
local capacity = tonumber(state[5])
local status   = state[6]
local seq      = tonumber(state[7] or '0')

if status ~= 'active' then
  return { 'error', 'run_over', status }
end

-- Units currently in the cart, across every good.
local function carried()
  local all = redis.call('HVALS', cargo_key)
  local total = 0
  for i = 1, #all do
    total = total + tonumber(all[i])
  end
  return total
end

-- How much of this good has already been bought here today. Buying
-- pushes the price up; selling pushes it back down, so one number
-- tracks both directions.
local function flow_of(good)
  local f = redis.call('HGET', flow_key, town .. ':' .. good)
  return tonumber(f or '0')
end

-- Integral of unit_price * (1 + flow/scale) across the quantity. The
-- same shape the server uses, so a quote and a fill agree.
local function cost_of(a, b)
  return unit_price * ((b - a) + (b * b - a * a) / (2 * impact_scale))
end

if action == 'buy' then
  local qty = amount
  if qty < 1 then return { 'error', 'bad_qty' } end

  local held = carried()
  if held + qty > capacity then
    return { 'error', 'no_room', fmt(capacity - held) }
  end

  local flow = flow_of(target)
  local cost = math.ceil(cost_of(flow, flow + qty))
  if cost > cash then
    return { 'error', 'too_dear', fmt(cost), fmt(cash) }
  end

  redis.call('HSET', run_key, 'cash', fmt(cash - cost), 'seq', fmt(seq + 1))
  redis.call('HINCRBY', cargo_key, target, qty)
  redis.call('HINCRBY', flow_key, town .. ':' .. target, qty)

  return { 'ok', fmt(day), fmt(cash - cost), fmt(debt), fmt(capacity), town, fmt(cost) }
end

if action == 'sell' then
  local qty = amount
  if qty < 1 then return { 'error', 'bad_qty' } end

  local held = tonumber(redis.call('HGET', cargo_key, target) or '0')
  if qty > held then
    return { 'error', 'not_carried', fmt(held) }
  end

  -- Selling unwinds the same curve. Flow can go negative, which is the
  -- correct way for a town to pay less for the tenth cartload than the
  -- first.
  local flow = flow_of(target)
  local proceeds = math.floor(cost_of(flow - qty, flow))
  if proceeds < 0 then proceeds = 0 end

  redis.call('HSET', run_key, 'cash', fmt(cash + proceeds), 'seq', fmt(seq + 1))
  redis.call('HINCRBY', cargo_key, target, -qty)
  redis.call('HINCRBY', flow_key, town .. ':' .. target, -qty)

  return { 'ok', fmt(day), fmt(cash + proceeds), fmt(debt), fmt(capacity), town, fmt(proceeds) }
end

if action == 'travel' then
  if day >= run_days then
    return { 'error', 'run_over', 'days' }
  end

  -- The debt grows on the day change, whatever the player did with the
  -- day. That is the clock: standing still costs exactly as much as
  -- moving.
  local next_debt = math.ceil((debt * (10000 + debt_rate_bps)) / 10000)

  redis.call('HSET', run_key, 'day', fmt(day + 1), 'town', target, 'debt', fmt(next_debt), 'seq', fmt(seq + 1))
  -- A new day is a new set of prices, so yesterday's impact is gone.
  redis.call('DEL', flow_key)

  return { 'ok', fmt(day + 1), fmt(cash), fmt(next_debt), fmt(capacity), target, '0' }
end

if action == 'repay' then
  local pay = amount
  if pay > cash then pay = cash end
  if pay > debt then pay = debt end
  if pay < 1 then
    return { 'error', 'nothing_to_repay' }
  end

  redis.call('HSET', run_key, 'cash', fmt(cash - pay), 'debt', fmt(debt - pay), 'seq', fmt(seq + 1))
  return { 'ok', fmt(day), fmt(cash - pay), fmt(debt - pay), fmt(capacity), town, fmt(pay) }
end

if action == 'upgrade' then
  if upgrade_cost > cash then
    return { 'error', 'too_dear', fmt(upgrade_cost), fmt(cash) }
  end

  redis.call('HSET', run_key,
    'cash', fmt(cash - upgrade_cost),
    'capacity', fmt(capacity + capacity_step),
    'seq', fmt(seq + 1))

  return { 'ok', fmt(day), fmt(cash - upgrade_cost), fmt(debt), fmt(capacity + capacity_step), town, fmt(upgrade_cost) }
end

return { 'error', 'unknown_action', action }
