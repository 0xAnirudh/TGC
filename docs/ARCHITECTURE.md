# Architecture Decision Log

One entry per decision that a stranger reading the code would otherwise
have to guess at. Each records the alternative that was rejected and
why, because the reasoning is the part that goes stale silently.

Entries are appended as phases land. Nothing here is edited after the
fact except to mark a decision superseded, with a pointer to the entry
that replaced it.

---

## ADR-001 — The bonding curve is the counterparty

**Phase 0. Status: accepted.**

Prices come from `price(s) = basePrice * (1 + s/k)^n`, where `s` is the
good's supply. Buying pushes supply up the curve, selling pushes it back
down. There is no order book.

**Alternative considered: a real matching engine with an order book.**
Rejected. It would bring matching, partial fills, bid/ask management,
resting orders, and cancellation semantics - a large amount of machinery
whose payoff is realism the project does not need. The curve gives
genuinely player-driven prices with none of it, and the interesting
engineering problem (making concurrent execution atomic and durable) is
identical either way.

**Consequence:** a trade of any size walks the curve and pays the
definite integral over the supply it moves through. Quantity times spot
price is always wrong, and is only ever used for display.

**Consequence:** there is no liquidity constraint and no failed fill. A
buy either succeeds at the curve's price or is rejected for funds,
slippage, or size - never for want of a seller.

---

## ADR-002 — Money is whole integer Notes, rounded directionally

**Phase 0. Status: accepted.**

Every Note amount crossing a player boundary is an integer. Prices are
computed in floating point, then rounded in the direction that favours
the system: up on what a player pays, down on what a player receives.

**Alternative considered: floating-point balances.** Rejected outright.
NFR-5 requires the money supply to balance *exactly*, at all times.
Floating point cannot express that requirement, let alone satisfy it -
`0.1 + 0.2` is the whole argument. An economy that balances to within an
epsilon is an economy with an exploit nobody has found yet.

**Alternative considered: rounding to nearest.** Rejected. Nearest
rounding is symmetric, so roughly half of all trades round in the
player's favour. Each one of those mints a fraction of a Note out of
nothing. Directional rounding means rounding can only ever burn.

**Consequence:** see FINDING-002 below. The residue does not vanish; it
accumulates somewhere, and it was worth finding out where before the
server existed.

---

## ADR-003 — The curve reserve is an accumulator, not a computed integral

**Phase 0. Status: accepted.**

Notes paid into the curve by buys are tracked in an explicit `reserve`
counter, incremented on buy and decremented on sell. The reserve is
never recomputed from `reserveAt(supply)`.

**Alternative considered: derive the reserve from the curve integral on
demand.** Rejected. It is correct only while `basePrice` never changes.
Phase 8 introduces drift, which moves the curve out from under Notes
that were already collected - after a single drift tick the integral
stops equalling what the curve actually took in, and any invariant built
on it starts failing for a reason that has nothing to do with a bug.

**Consequence:** the money supply invariant survives drift unchanged.
`reserveFromCurve()` is retained purely as a cross-check for the
no-drift case, and as the thing FINDING-002 is measured against.

---

## ADR-004 — The sell spread is burned, not collected

**Phase 0. Status: accepted.**

2% of the gross value of every sell leaves circulation permanently. It
does not go to a treasury, a fee account, another player, or the
issuer.

**Alternative considered: pay the spread to a house account.** Rejected
for v1 - it adds an account whose balance has to be managed, spent, or
justified, and the interesting property (making churn unprofitable) does
not depend on where the Notes go, only that the player does not get them
back.

**Consequence:** this is what makes a round trip strictly lossy, and it
is the only sink in v1. Without it, price manipulation would be free and
the only thing standing between a bot and a walked price would be the
rate limiter.

**Superseded in part by (planned) v2:** issuer royalties redirect a
slice of the spread to the issuer instead of burning it. That is a
transfer, not a new faucet, so the invariant is unaffected - see
IMPLEMENTATION_PLAN.md section 26.7.

---

## ADR-005 — Per-trade size is capped as a share of supply, with a floor

**Phase 0. Status: accepted.**

A single trade may move at most 10% of a good's current supply, or 100
units, whichever is larger.

**Alternative considered: a flat unit cap.** Rejected. It is either
meaninglessly loose on a large good or crippling on a small one.

**Why the floor exists:** a pure percentage cap makes the first buy of
every newly issued good impossible, because 10% of zero is zero. The
floor is the bootstrap path.

---

## ADR-006 — The two stores have different failure postures

**Phase 1. Status: accepted.**

A Mongo outage is survivable; a Redis outage is an outage. The Mongo
client retries forever and the API keeps serving. The Redis client also
reconnects forever, but requests that need it fail loudly meanwhile.

**Why they differ:** Redis is the hot path, not a cache. It holds live
supply, live base prices, user cash, the ledger head, the leaderboard,
and the rate limit buckets. Mongo, from Phase 6, is a durable projection
of a Redis stream - losing it stops the ledger being written down, not
trades being executed.

**Alternative considered: fall back to Mongo when Redis is unavailable.**
Rejected. The rebuild path exists, but it replays the entire trade ledger
to reconstruct state. That is a recovery tool measured in minutes, not a
fallback a request can take. Serving a quote from a partially
reconstructed market would be worse than refusing to serve one.

**Consequence:** readiness returns 503 when either store is down, so a
load balancer drains the instance. Liveness deliberately does not check
either, so a shared store outage cannot trigger a restart loop across
every instance simultaneously.

---

## ADR-007 — Bind the port before connecting to the stores

**Phase 1. Status: accepted.**

`server.js` calls `listen()` first and connects to Mongo and Redis
afterwards, in the background.

**Alternative considered: connect, then listen.** This is the more
obvious ordering and it is worse. Because the Mongo client retries
indefinitely, a process that cannot reach Mongo would never finish
connecting, never bind, and therefore never answer a health check. The
orchestrator sees a container that died on boot; the operator gets a
restart loop and no signal about which store is actually missing.

**Consequence:** `/health` is answerable from the first moment and names
the missing store. Readiness still returns 503 until both are connected,
so nothing reaches the instance before it can serve.

---

## ADR-008 — Lua scripts declare their own key count

**Phase 1. Status: accepted.**

Every `.lua` file starts with a directive:

```
-- keys: 2
```

The loader reads it and passes it to ioredis `defineCommand`.

**Why it is in the file rather than the loader:** Redis Cluster routes a
command by its declared keys. A script that under-declares works
perfectly on a single node and breaks the moment the deployment grows -
a failure mode that does not appear in any local test. Keeping the
declaration in the same file as the `KEYS[]` uses it describes stops the
two drifting apart, and a test asserts every shipped script's
declaration matches its highest `KEYS[n]`.

**Consequence, learned the hard way:** `defineCommand` turns a script's
filename into a *method on the client*. It does not add a command
alongside the real ones - it replaces one. The first script in this
directory was called `ping.lua`, which overwrote `redis.ping()`; the
readiness check then invoked the script with no arguments and reported a
perfectly healthy Redis as down. The loader now throws on any name that
would shadow an existing client method, so this is a boot-time error
rather than a runtime mystery the first time someone adds `get.lua`.

Worth noting where this was caught: running the process against a real
Redis. No unit test could have found it, because none of them construct
a client.

**Alternative considered: hand-rolled EVALSHA with a NOSCRIPT retry.**
Rejected in favour of `defineCommand`, which already loads the script,
caches the SHA, calls EVALSHA, and falls back to EVAL and reloads on
NOSCRIPT - which is what happens after a Redis restart or a `SCRIPT
FLUSH`. Reimplementing that would put a hand-written retry in the one
place where getting it wrong means a trade silently fails.

---

## Phase 0 findings

The simulation is in `sim/`. Run it with `npm run sim`. Default run:
200 players, 8 goods spanning the parameter band, 10,000 random trade
attempts, invariants checked every 250 trades.

### FINDING-001 — Round trips are lossy across the whole parameter band

1,500 combinations of `basePrice`, `k`, `n`, supply and quantity were
checked. Buying and immediately selling back always loses, and so does
selling and immediately buying back.

Chunking does not help. Twenty small round trips lose *more* than one
large one of the same total size, because directional rounding rounds
against the player on every chunk instead of occasionally in their
favour.

This is the property the whole economy rests on, and it holds by
construction rather than by tuning: a round trip walks the same stretch
of curve in both directions, so the gross return equals the cost exactly
and the spread is the entire difference.

### FINDING-002 — Rounding dust accumulates in the reserve at ~0.5 Notes per trade

Unwinding every position in the economy does **not** return the reserve
to zero. It returns it to a small positive residue.

Buys round up and sells round down, so each executed trade leaves less
than one Note behind in the reserve. Measured over a default run, the
dust is **0.4958 Notes per executed trade** - which is the 0.5 you would
predict from a uniform rounding residue, and is the cleanest available
evidence that the rounding is behaving exactly as designed rather than
accidentally.

The dust is:
- **always positive.** A negative reserve would mean the curve paid out
  more than it ever collected. That is the actual failure mode this is
  watching for, and it is asserted in the test suite.
- **bounded by the trade count**, at most one Note per trade.
- **inside the invariant, not outside it.** The dust sits in `reserve`,
  which is one of the three terms of `granted == cash + reserve +
  burned`. Conservation is unaffected. Nothing leaks.

No action taken. Documented rather than "fixed" because the alternative -
sweeping the dust into the burn - would add a write to the hot path to
tidy a quantity that is already fully accounted for.

### FINDING-003 — Prices plateau rather than diverging

Over a default run every good rises (players start with cash and net
buying pressure is upward early) and then flattens as holders begin
selling into it. Closing prices land between roughly 2x and 5x opening,
with steeper goods (`n = 3`) moving furthest. Nothing ran away to
infinity and nothing collapsed to zero.

The exponent is what controls this. `n = 1` goods roughly doubled;
`n = 3` goods moved 3-4x on far less supply. That is the band issuers
will be allowed to choose from in Phase 11, and it is bounded for this
reason.

### FINDING-004 — The guards are load-bearing, so the simulation attacks them

An early version of the harness clamped every trade to a legal size
before submitting it and reported zero rejections across 10,000 trades -
which proved only that valid trades are valid.

One attempt in twelve is now deliberately reckless: it ignores the caps
and asks for far more than the player holds or can afford. A default run
now rejects roughly 550 trades on the size cap, 270 on holdings, and a
handful on funds, and the invariants hold across all of them.
