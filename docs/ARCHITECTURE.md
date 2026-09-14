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

## ADR-009 — Uniqueness is decided by the index, not by a prior check

**Phase 2. Status: accepted.**

Registration inserts and catches the duplicate-key error. It does not
query for availability first.

**Why:** checking then inserting is a race with no winner. Two
simultaneous registrations both query, both see the name free, and both
proceed. The unique index is the only thing in the system that actually
decides, so the duplicate-key error is the real check and handling it is
not error handling - it is the control flow.

**Consequence:** the same reasoning applies to every uniqueness
constraint added later. Where correctness depends on it, the index
decides.

---

## ADR-010 — Passwords over 72 bytes are rejected, not truncated

**Phase 2. Status: accepted.**

bcrypt hashes at most the first 72 bytes of its input and silently
ignores the rest.

**Alternative considered: accept and let bcrypt truncate.** Rejected.
Two different passphrases sharing a 72-byte prefix would hash
identically, so a user who chose a long passphrase believing it stronger
would be wrong, and nothing would tell them. Silently weakening a
credential is worse than refusing it.

**Alternative considered: pre-hash with SHA-256, then bcrypt the digest.**
This is the usual way to lift the limit and it works, but it adds a
construction that has to be explained and kept consistent forever for a
limit no realistic password approaches. Rejected as unnecessary here.

**Detail that matters:** the check counts *bytes*, not characters. A
passphrase with any non-ASCII character - an emoji is 4 bytes - reaches
72 bytes long before 72 characters, so a character-count check would
still silently truncate.

---

## ADR-011 — Failed logins are indistinguishable from each other

**Phase 2. Status: accepted.**

An unknown username and a wrong password return the same status, the
same error code, and the same message. When the username does not exist,
the password is still compared against a decoy hash.

**Why both halves are needed:** returning the same body is not enough on
its own. Without the decoy comparison, a missing account returns in
under a millisecond while a real one takes as long as bcrypt does, and
that timing gap is a reliable oracle for enumerating accounts. The body
closes one channel; the decoy closes the other.

**Consequence:** login is deliberately no faster for a nonexistent user.
That is the point, not an inefficiency to optimise away later.

---

## ADR-012 — `authenticate` does not load the user

**Phase 2. Status: accepted.**

The middleware verifies the token and attaches its claims. Routes that
need the user document ask for it explicitly with `requireUser`.

**Why:** trading is the hot path and needs nothing but the user id.
Loading the document on every authenticated request would put a Mongo
read in front of an operation otherwise served entirely from Redis, for
data most routes discard.

**Trade-off accepted:** nothing checks whether the account still exists,
so a token remains valid until it expires even if the user is deleted.
With a 7 day TTL and no deletion flow in v1, this is acceptable. If it
stops being - a ban mechanism, say - the fix is a revocation set in
Redis checked on the same round trip the request already makes, not a
Mongo read.

---

## ADR-013 — The sequential trade path ships with a known race

**Phase 4. Status: accepted, and deliberately temporary. Superseded by
ADR-014 in Phase 5.**

`services/trading.js` reads supply, computes a price, checks the
balance, and writes the result back. Between the read and the write
there is a gap, and another request can read the same supply inside it.

**This is not hypothetical. It is measured.** Eight concurrent buys of
100 units each, against a good at supply 10,000:

```
trades accepted by the API : 8 of 8
correct final supply       : 10,800
actual final supply        : 10,500
units created from nothing : 300
```

Every one of the eight players was charged. Every request returned 201.
Three hundred units entered existence with no corresponding payment, and
nothing anywhere raised an error. The same gap exists on the cash check:
two concurrent buys can both read a balance of 500, both decide 400 is
affordable, and both spend it, leaving the account at -300.

**Why ship it at all.** The fix is a Redis Lua script, and a Lua script
is considerably harder to read than the code it replaces. Writing the
obvious version first means Phase 5 arrives as a targeted repair to a
problem that has been named, reproduced and measured - rather than as
complexity introduced up front on the assurance that it will be needed.

The commit history is part of the argument this project makes. It should
show the race being identified before it was fixed, not a Lua script
appearing fully formed with a comment claiming it was necessary.

**How it gets fixed:** every step above - read supply, price it, check
the balance, mutate supply, mutate cash - moves inside one Lua script.
Redis runs a script start to finish with nothing interleaved, so the gap
the race lives in stops existing. Phase 5.

**A test asserts the bug**, in `tests/integration/trading.test.js`. In
Phase 5 that test is rewritten to assert the fix, and the diff between
the two versions is the clearest statement of what the phase achieved.

---

## ADR-014 — Trade execution is one Lua script

**Phase 5. Status: accepted. Supersedes ADR-013.**

Everything that has to be indivisible - read supply, price the trade,
check the slippage bound, check cash or holdings, mutate supply, mutate
cash and holdings, move the reserve and burn counters - happens inside
`packages/api/src/lua/trade.lua`. Redis executes a script from first line
to last with no other command interleaved, so the read-then-write gap
ADR-013 measured does not exist.

**The before and after, same measurement both times:**

| | Phase 4 (JavaScript) | Phase 5 (Lua) |
|---|---|---|
| concurrent buys | 8 | 500 |
| accepted | 8 | 500 |
| supply drift | **300 units created** | 0 |
| holdings vs supply | not checked | 0 |
| leaked Notes | not checked | 0 |
| throughput | — | 17,719 trades/sec |

**Alternatives considered.**

*WATCH/MULTI/EXEC optimistic locking.* Redis supports it and it is
correct. Rejected because under contention - which is exactly the hot
good everyone is trading - it degrades into a retry loop, and the retry
budget becomes a latency tail on the most active good in the game. Lua
has no contention to lose to.

*Mongo transactions.* Would move the hot path onto Atlas and give up the
sub-millisecond read that NFR-1 depends on, to solve a problem Redis
solves without a round trip.

*A per-good mutex in Node.* Works for one process. The API is stateless
and horizontally scaled by NFR-7, so a mutex inside one instance protects
nothing once a second instance exists.

**Consequence:** cash and holdings had to move into Redis. A sell must
check holdings inside the same block that moves supply; checking them in
Mongo first would rebuild the gap the script exists to close. Mongo keeps
both as a durable projection.

**What is still not atomic.** The Mongo write after the script can fail
on its own, leaving Redis correct and Mongo behind. That is the dual
write Phase 6 removes.

---

## ADR-015 — The client sends a slippage bound, never a price

**Phase 5. Status: accepted.**

`POST /trades` accepts `slippageBps`. The route prices the trade at
current supply, widens it by the tolerance, and passes the script a hard
limit it will not execute beyond.

**Why not accept a price.** A client that names its own price can name a
stale low one and be filled at it. The curve must decide the price; the
client may only decline the result.

**Why a tolerance rather than the quoted total.** Either works, and
passing the quoted figure back would also be safe, since a client
inflating it only widens its own acceptance. A tolerance is simply less
to carry: no quote has to be echoed, and `curl` can place a trade without
first fetching one.

**What the bound actually protects.** Supply can move between the route
pricing the trade and the script executing it. That window is small and
real, and it is precisely where another player's trade lands. Zero
tolerance is permitted and means "only at exactly the price I was
quoted", which fails under any concurrent activity - correctly.

The cap is 5000 bps. Past fifty percent a tolerance has stopped being a
tolerance.

---

## FINDING-005 — Two implementations of one curve need a test between them

**Phase 5.**

The curve now exists twice: in JavaScript for quotes, portfolio
valuation and the simulation, and in Lua for execution. If they ever
disagree, a quote promises one price while the trade charges another -
and worse, the Phase 6 rebuild replays the ledger through the JavaScript
version and reconstructs a market that never existed.

`tests/invariant/lua-parity.test.js` diffs them across 6,993 parameter
combinations. It found a real defect on its first run: Lua's `tostring()`
switches to scientific notation past about 1e14 and keeps only 14
significant digits, so a cost of 353,041,482,706,872 came back as
`3.5304148270687e+14` - short by 72 Notes. 36 combinations disagreed,
every one above 1e14, every one a formatting loss rather than a
difference in the arithmetic. `string.format('%.0f', x)` fixed all 36.

Whether a good could realistically reach 1e14 is beside the point. The
lesson is that the second implementation was wrong within an hour of
existing, in a way no amount of reading it would have shown.

---

## FINDING-006 — Lua scope is downward only, and the tests nearly missed it

**Phase 5.**

`local function fmt` was declared partway down `trade.lua`, below the
size-cap check that called it. Lua binds a `local function` from its
definition downward only, so at the point of the call it did not exist
and the script aborted with "attempted to access nonexistent global
variable 'fmt'".

Every happy-path test passed. The only path that touched the helper
before its definition was a *rejection* path, which the success cases
never reach - so the bug surfaced as a 500 on one oversized-trade test
and nowhere else.

Helpers are now defined immediately after the arguments are parsed,
above every use. The wider point: in a script where the error paths and
the success paths use different code, testing the rejections is not
optional thoroughness.

---

## ADR-016 — Mongo is a projection of a Redis stream

**Phase 6. Status: accepted. Completes ADR-014.**

`trade.lua` appends the trade to `stream:trades` inside the same atomic
block that moves supply and cash. The API writes nothing to Mongo. A
relay worker consumes the stream with a consumer group and projects
entries into Mongo.

**What this replaces.** ADR-014 left a second write: execute in Redis,
then write the ledger row from JavaScript. Redis could succeed and Mongo
fail, leaving the market moved and the ledger silent. Recovering from
that means a compensating reversal, which is itself a write that can
fail.

**Why this is different from doing the dual write carefully.** There is
no second write. The trade is durable the moment the script returns,
because the script appended it. Mongo falling over stops the projection,
not the trade - entries accumulate in the stream and land when it comes
back. There is nothing to compensate because nothing can be half-done.

**Trade-off accepted:** anything read from Mongo lags the live state by
however long the relay takes. In practice that is milliseconds. It shows
up in the API as a holding's cost basis not existing the instant a trade
returns, which is why the portfolio tests drive the relay by hand.

**Trade-off accepted:** Redis durability now bounds worst-case loss, as
`appendfsync everysec` means up to a second of trades on an unclean
shutdown. That is the documented cost of keeping the hot path in memory,
and the rebuild path is what makes it survivable rather than fatal.

---

## ADR-017 — Blocking reads get their own connection

**Phase 6. Status: accepted.**

The relay's `XREADGROUP ... BLOCK` runs on a duplicated connection. The
single-shot variant used by tests takes no `BLOCK` argument at all.

**Why, learned expensively.** A blocking command monopolises its
connection: the server stops answering anything else on that socket
until the command returns. The first version blocked on the API's shared
client, and a `BLOCK 1` - one millisecond - took sixty seconds, because
the reply queued behind auto-pipelined traffic on a socket that had
stopped answering. Every test that drove the relay timed out.

**Consequence:** any future blocking command - `BLPOP`, `WAIT`, a
blocking stream read anywhere else - needs the same treatment. Sharing
the API client with a command that waits by design is never correct.

---

## FINDING-007 — Only what the ledger created can be rebuilt

**Phase 6.**

The rebuild starts every good at zero supply and derives the rest from
the trades. It does not read `Market.supply` from Mongo, because
trusting the cached copy would make the reconstruction circular.

The first version of the rebuild test injected 60,000 units directly
into Redis to set up a market, traded on top of that, and then failed
because the rebuild produced 260 rather than 60,260. **The rebuild was
right and the test was cheating.** No trade created those 60,000 units,
so the ledger correctly does not contain them.

This is a standing constraint, not a curiosity:

- Supply may only ever change through something the ledger records.
- Phase 11's issuance must therefore create a good at zero supply. An
  initial allocation to the issuer would be supply with no ledger entry,
  and the rebuild would silently erase it - which is a second, quieter
  reason the issuer gets no free allocation, on top of the economic one
  in Phase 11.
- The same applies to any future admin tooling that wants to "just set"
  a number.

---

## FINDING-008 — A driver option that no longer exists fails silently

**Phase 6.**

The projection detected redelivery using Mongoose's `rawResult` option
on `findOneAndUpdate`, reading `lastErrorObject.updatedExisting`. That
option was removed in Mongoose 9. It is not an error - it is ignored,
the metadata comes back `null`, and `!null?.updatedExisting` evaluates
to `true`.

So every delivery looked like a first delivery. The ledger row was still
deduplicated by its unique index, so the visible symptom was nothing at
all - but `tradeCount` and `vol24h` would have been incremented again on
every retry, which is precisely the double-counting the stream id exists
to prevent.

Replaced with a plain insert and a duplicate-key catch. The index
decides, the same way it decides usernames (ADR-009), and no driver
option has to keep existing for the logic to hold.

The test now asserts the counters, not just the row count. Asserting
that a duplicate produced one ledger row passed throughout; it was
checking the half that was never broken.

---

## FINDING-009 — A load test that stampedes measures queueing, not latency

**Phase 14.**

The first version of `loadtest/run.mjs` issued every request at once with
`Promise.all` and reported a quote p95 of **12.8 seconds** against an
NFR-1 target of 10 milliseconds.

Nothing was wrong with the system. The test was measuring how long 1,500
requests take to queue through a single Node process. Latency under a
stampede is queueing time; service time is what the requirement is about,
and the two are unrelated once the queue is deep.

The runner now holds concurrency fixed at a set number of virtual users -
each takes the next request only when its previous one finishes - which
is what every real load tool does and why they all talk about VUs rather
than total requests.

Published figures state the concurrency level they were taken at, for the
same reason.

---

## FINDING-010 — The hot path was not actually Redis-only

**Phase 14.**

With honest concurrency, quote p95 came back at **827ms against a p50 of
42ms**. A tail twenty times the median is not load - it is one slow
dependency being hit sometimes.

It was MongoDB. Both `GET /goods/:id/quote` and `POST /trades` were
calling `Good.findById` to fetch `k` and `n`, so every request on the
supposedly Redis-only hot path made a round trip to Atlas. ADR-001 and
the Phase 3 notes both claim quotes touch no database. That claim had
been false since Phase 3 and nothing noticed, because local tests are
fast enough not to care and correctness tests do not measure time.

`k`, `n`, `name` and `colorToken` are fixed when a good is created and
never change, so they are now cached in a Redis hash. There is no
invalidation logic because there is nothing that invalidates.

| | before | after |
|---|---|---|
| quote p50 | 42ms | 2.94ms |
| quote p95 | 827ms | 8.69ms |
| trade p95 | 827ms | 12.35ms |

**The lesson worth keeping:** a performance claim written in a
documentation file is not a constraint on anything. This one survived
eleven phases of review because nothing executed it. The load test is the
first thing in the project that could tell the difference between the
architecture and the code.

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
