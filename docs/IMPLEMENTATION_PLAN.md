# General Company — Implementation Plan (v1)

A player-driven virtual economy. Players trade goods whose prices move on
a bonding curve and issue their own goods into a single global market.
The engineering substance is a concurrent, transactional market engine
built on Redis and MongoDB.

This document is the build plan: requirements, architecture, phases, and
commit-level granularity. Keep it at `/docs/IMPLEMENTATION_PLAN.md` and
update it as decisions change.

**Scope note.** This is the **v1** plan. It is a deliberate descope of a
larger design. Contracts, firms, world events, achievements, LLM-written
headlines, multi-region markets with shipping, and issuer royalties are
**not built in v1** — they are game-complexity features that do not add
backend engineering value proportional to their cost. Every one of them
is preserved, with its original design reasoning, in
§26 Deferred to Later Versions. Nothing in the core engineering — the
bonding curve, atomic Lua execution, stream-based durability, the money
supply invariant, rate limiting, drift, WebSockets — is reduced.

---

## Table of Contents

1. Requirements Analysis
2. Success Criteria
3. Tech Stack
4. Architecture Overview
5. Data Model
6. Repo Structure
7. Git Workflow and Commit Conventions
8. Phase 0 — Economy Simulation (no server)
9. Phase 1 — Project Scaffold
10. Phase 2 — Auth and Users
11. Phase 3 — Goods and Quotes (read-only market)
12. Phase 4 — Trading, Sequential
13. Phase 5 — Atomicity (Redis Lua)
14. Phase 6 — Durability (stream, relay, rebuild)
15. Phase 7 — Rate Limiting
16. Phase 8 — Drift and Price History
17. Phase 9 — Real-Time (WebSockets)
18. Phase 10 — Leaderboard and Profiles
19. Phase 11 — Issuing Goods
20. Phase 12 — Newspaper (rule-based)
21. Phase 13 — Frontend
22. Phase 14 — Load Testing and Hardening
23. Phase 15 — Deployment
24. Testing Strategy
25. Definition of Done
26. Deferred to Later Versions

---

## 1. Requirements Analysis

Requirements marked **v2+** are retained here deliberately. They describe
the full intended system. They are not built in v1. See §26 for why each
was deferred and what it would take to build it.

### 1.1 Problem Statement

Build a multiplayer virtual economy where prices are driven entirely by
player action, the market is correct under concurrent load, and no player
can extract value through an exploit rather than through play.

The hard requirements are not gameplay features. They are:
- Trades must be atomic under concurrency. Two simultaneous buys on the
  same good must produce the same result as two sequential buys.
- The money supply must be conserved. Notes may only enter through
  defined faucets and leave through defined sinks.
- The system must be recoverable. If hot state is lost, it must be
  reconstructable from a durable ledger.
- Read latency on the hot path must stay low enough that the market feels
  live.

Descoping the game does not weaken any of these four. That is the test a
cut had to pass to be made.

### 1.2 Actors

| Actor | Description |
|---|---|
| Guest | Unauthenticated. Can view the market, leaderboard, newspaper, public profiles. |
| Player | Authenticated. Can trade. |
| Issuer | Player past the net-worth and activity threshold. Can issue goods. |
| System | Scheduled jobs: drift, leaderboard revaluation, newspaper generation. |

**v2+:** Players can also ship, post and fulfill contracts, and join
firms. The System actor also runs shipment arrival, contract expiry, and
world events.

### 1.3 Functional Requirements

**FR-1 Accounts**
- FR-1.1 Register with username and password
- FR-1.2 Log in, receive a JWT
- FR-1.3 Receive a one-time starting grant of Notes on registration
- FR-1.4 View own portfolio: cash, holdings, net worth, unrealized P/L
- FR-1.5 Public profile with net worth and rank
- FR-1.6 Toggle portfolio visibility between full and net-worth-only
- FR-1.7 **v2+** — Specialty and achievements on the public profile

**FR-2 Market**
- FR-2.1 List all goods with current price, 24h change, and volume
- FR-2.2 View a single good: price history chart, issuer, supply
- FR-2.3 Request a non-binding quote for a given good, side, and quantity
- FR-2.4 Prices derive solely from supply via the bonding curve; the
  client never submits a price
- FR-2.5 **v2+** — All of the above resolved per region, with independent
  supply and base price in each

**FR-3 Trading**
- FR-3.1 Buy a quantity of a good
- FR-3.2 Sell a quantity of a good
- FR-3.3 Every trade carries a client-supplied max slippage; trades
  executing beyond it are rejected
- FR-3.4 Sells incur a spread (2%), burned from circulation
- FR-3.5 Per-trade size capped at a percentage of current supply
- FR-3.6 Every executed trade is recorded immutably

**FR-4 Regions and Shipping — v2+, none of this is in v1**
- FR-4.1 **v2+** Four regions, each with independent supply and base
  price per good
- FR-4.2 **v2+** Dispatch a quantity of a held good from one region to
  another
- FR-4.3 **v2+** Shipments take real time based on route distance
- FR-4.4 **v2+** Goods in transit cannot be sold
- FR-4.5 **v2+** Arrival incurs a destination tariff, burned from
  circulation
- FR-4.6 **v2+** Arrivals are processed by a scheduled job, not on read

v1 runs a **single global market** per good. There is one supply and one
base price per good, no region dimension anywhere in the schema, the
Redis keys, or the API.

**FR-5 Issuing**
- FR-5.1 Gated by net worth, account age, and trade count
- FR-5.2 Charges a flat issuing fee, burned
- FR-5.3 Issuer chooses name, color token, and curve steepness within a
  band
- FR-5.4 Issuer receives no free allocation
- FR-5.5 **v2+** — Issuer earns a royalty on all trades of their good,
  paid from the spread
- FR-5.6 **v2+** — Issuer's own purchases in the first 48h are locked
  from selling for 7 days
- FR-5.7 **v2+** — Issuer chooses a launch region

**FR-6 Contracts — v2+, none of this is in v1**
- FR-6.1 **v2+** Post a contract: good, quantity, destination, payment,
  expiry
- FR-6.2 **v2+** Payment held in escrow at posting
- FR-6.3 **v2+** Another player accepts, then fulfills by delivering
- FR-6.4 **v2+** Fulfillment verified server-side before escrow release
- FR-6.5 **v2+** Expired contracts return escrow to poster minus a
  posting fee

**FR-7 Firms — v2+, none of this is in v1**
- FR-7.1 **v2+** Create a firm, become founder
- FR-7.2 **v2+** Join, leave, manage members with roles
- FR-7.3 **v2+** Shared treasury with contribution and withdrawal
  permissions
- FR-7.4 **v2+** Firm leaderboard

**FR-8 Retention Systems**
- FR-8.1 A single net worth leaderboard
- FR-8.2 The leaderboard is computed on schedule, never on page load
- FR-8.3 Daily newspaper generated by **rule-based templates** from the
  last 24h of structured market events
- FR-8.4 Daily login bonus, scaled by account age and activity
- FR-8.5 **v2+** — Additional boards: 24h gain absolute and percent,
  issuers, shippers, contractors, firms
- FR-8.6 **v2+** — World events that modify drift, tariffs, or shipping
  times
- FR-8.7 **v2+** — Achievements and titles
- FR-8.8 **Someday, if ever** — LLM-generated headlines

**FR-9 Real-Time**
- FR-9.1 Live price updates pushed to clients watching a good
- FR-9.2 Market event stream
- FR-9.3 Personal events: rank changed
- FR-9.4 **v2+** — Personal events for shipment arrived, contract
  accepted, royalty earned

### 1.4 Non-Functional Requirements

None of these are relaxed for v1. They are the point of the project.

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Quote latency | p95 under 10ms |
| NFR-2 | Trade execution latency | p95 under 50ms end to end |
| NFR-3 | Price broadcast latency | under 100ms from execution to client |
| NFR-4 | Concurrent trade correctness | No supply drift, no negative balances, no double-spend under sustained concurrent load |
| NFR-5 | Money supply conservation | `total Notes = grants + bonuses − spread − issuing fees`, exactly, at all times |
| NFR-6 | Recoverability | Full market state reconstructable from the durable trade ledger alone |
| NFR-7 | Horizontal scalability | API stateless; multiple instances behind a load balancer with correct WebSocket fan-out |
| NFR-8 | Job exclusivity | Scheduled jobs run exactly once per tick across all instances |
| NFR-9 | Abuse resistance | Per-user trade rate limits, per-IP auth rate limits |

**v2+ change to NFR-5:** the invariant gains tariffs and escrow as terms:
`total Notes = grants + bonuses − spread − fees − tariffs`, with escrowed
Notes counted as still in circulation. Royalties are a transfer inside
the spread, not a new term — see §26.

### 1.5 Out of Scope (for every version)

- Real money, payments, or anything of monetary value
- Mobile native apps
- Email verification and password reset (add later if the project goes
  public)
- Admin moderation tooling beyond basic seeding scripts
- Internationalization

### 1.6 Key Constraints and Assumptions

- Single developer, part-time, alongside coursework
- Free-tier infrastructure (MongoDB Atlas, Upstash Redis, Render/Railway)
- Target scale for load testing: hundreds of concurrent users, thousands
  of trades per minute. Not millions.
- Redis durability: the chosen `appendfsync` setting bounds worst-case
  data loss. This is a documented trade-off, not an oversight.
- **The UI is deliberately plain.** Unstyled-adjacent, functional, no
  design system. The frontend exists to exercise and demonstrate the
  backend, not to be a portfolio design piece.

### 1.7 Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Curve math has an exploitable inverse | Economy breaks, infinite money | Phase 0 proves round-trips are strictly lossy before any server code exists |
| Dual-write between Redis and Mongo diverges | Ledger and market disagree | Phase 6 removes the dual-write: Lua writes to a Redis stream, a relay projects it to Mongo |
| Redis crash loses hot state | Trades lost | Stream replay from last Mongo checkpoint; documented fsync trade-off |
| Scope creep | Project never ships | This descope is the mitigation. Phases 0-7 are the project. 8+ are additive and independently shippable. Deferred features are written down in §26 and are not to be pulled forward. |
| Bots exploit rate limit gaps | Market manipulation | Phase 7 token bucket, plus spread making churn unprofitable by construction |
| Single global market is less interesting to play | Fewer players, less organic volume | Accepted for v1. The engineering claims do not depend on player count — the load test generates the concurrency. Regions return in v2 to add the arbitrage loop. |

---

## 2. Success Criteria

The project is a success when all of these hold:

1. Thousands of concurrent trades execute with zero supply drift and zero
   balance violations.
2. The money-supply invariant holds exactly after a concurrent load test.
3. Redis can be flushed entirely and full market state rebuilt from the
   Mongo trade ledger, producing byte-identical supply and balances.
4. Trade p95 latency is under 50ms under load, with published numbers.
5. A new player can register, trade, and see their rank without reading
   any documentation.
6. The README explains every architectural decision with its alternative
   and the reason for the choice — including the decisions recorded in
   §26 about what was deliberately not built.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ | Existing fluency; good async I/O fit for a read-heavy market |
| API framework | Express | Familiar, minimal, no magic to explain away |
| Durable store | MongoDB + Mongoose | Document-shaped domain; existing production experience |
| Hot state + atomicity | Redis 7+ (`ioredis`) | Lua scripting for atomic critical sections; sorted sets for the leaderboard; streams for the ledger; pub/sub for fan-out |
| Trade atomicity | Redis Lua (`EVAL`) | Redis executes Lua atomically — the entire check-and-mutate is one indivisible operation |
| Durable ledger | Redis Streams → relay worker → Mongo | Removes the dual-write; Mongo becomes a projection, not a parallel source of truth |
| Auth | JWT (`jsonwebtoken`) + `bcrypt` | Stateless auth keeps API instances horizontally scalable |
| Scheduled jobs | `node-cron` + Redis lock | Simple; the Redis lock enforces exactly-once across instances |
| Real-time | Socket.IO + Redis adapter | Existing experience; the adapter handles multi-instance fan-out |
| Validation | `zod` | Schema validation at the API boundary, typed and explicit |
| Testing | Vitest + Supertest | Fast, good ESM support |
| Load testing | k6 | Scriptable, produces the latency numbers the README needs |
| Frontend | React + Vite, plain CSS | Existing stack, minus the styling layer. v1 UI is basic on purpose. |
| Charts | Recharts | Simple line charts, no configuration overhead |
| Containers | Docker + Docker Compose | One-command local Mongo + Redis + API + worker |
| Deployment | Render/Railway + Atlas + Upstash | Free tier, real public URL |

**Deliberate non-choices, worth being able to defend:**

- **No order book / matching engine.** The bonding curve is the
  counterparty. This removes matching, partial fills, and bid/ask
  management entirely while keeping prices dynamic.
- **No BullMQ.** Job needs here are cron-shaped (drift ticks,
  revaluation, newspaper), not queue-shaped. A Redis lock plus
  `node-cron` is simpler and sufficient. Revisit if per-item retry
  semantics become necessary — v2's shipment arrivals and contract expiry
  are the first thing that might justify it.
- **No vector DB, no Kafka, no microservices.** Nothing in the
  requirements justifies them.
- **No Tailwind or component library in v1.** The UI is a handful of
  plain screens. Pulling in a design system to style eight pages would be
  more setup than markup.
- **No LLM anywhere.** The newspaper is rule-based templates. An LLM call
  in the daily job would add an API key, a failure mode, a latency
  budget, and a cost line to produce a sentence a template already
  produces deterministically.

---

## 4. Architecture Overview

```
                       React client
                            |
                REST (auth, market, trades)
             WebSocket (prices, events, personal)
                            |
                  Express API (stateless, N instances)
                            |
        ┌───────────────────┴───────────────────┐
        |                                       |
     Redis                                  MongoDB
  - live supply per good                 - users, goods, markets
  - live basePrice per good              - holdings
  - user cash                            - trades (projection)
  - Lua trade script                     - price snapshots
  - trade stream (ledger head)           - newspapers
  - leaderboard sorted set
  - rate limit buckets
  - pub/sub for WS fan-out
        |
        └──► Relay worker ──► writes trade stream entries to Mongo
        └──► Job runner  ──► drift, leaderboard, newspaper
                              (Redis-locked)
```

### 4.1 The write path (the core of the whole system)

A trade executes entirely inside one Lua script:

```
1. read supply, basePrice for the good
2. compute execution price from the curve
3. check slippage against client tolerance
4. check user cash (buy) or holdings (sell)
5. mutate supply
6. mutate user cash and holdings
7. XADD the trade to the ledger stream
```

All seven steps are atomic. Nothing interleaves. The script returns the
executed price and new supply, or a rejection code.

A separate **relay worker** consumes the stream with a consumer group and
writes each entry to Mongo. Each trade carries a server-generated ID, so
the Mongo write is idempotent and at-least-once delivery is safe. If
Mongo is down, entries accumulate in the stream and retry.

**Why this instead of Redis-then-Mongo dual write:** with a dual write,
Redis can succeed and Mongo can fail, leaving market state and ledger
disagreeing, requiring a compensating reversal that can itself fail. With
the stream, there is no second write that can fail independently. Mongo
is a **durable projection** of the stream, not a parallel source of
truth. There is nothing to compensate.

**Trade-off accepted:** user cash lives in Redis, so Redis durability
config bounds worst-case loss. Choose `appendfsync always` (slower,
safer) or `everysec` (faster, up to 1s of trades at risk on crash) and
document the choice. Recovery replays the stream from the last Mongo
checkpoint.

**What the descope changed here:** nothing. The Lua script reads
`mkt:{goodId}:supply` instead of `mkt:{goodId}:{region}:supply`. That is
the entire difference. Step 2 in v2 also pays a royalty out of the spread
in the same atomic block — see §26.

### 4.2 The read path

Quotes and market listings read supply and basePrice directly from Redis.
No Mongo round trip on the hot path. Mongo is queried only for history,
profiles, and anything not latency-critical.

### 4.3 Rebuild path

On cold start with empty Redis: read the Mongo trade ledger in order,
replay supply and balance mutations, write resulting state to Redis. This
is both the disaster-recovery path and the correctness proof (see Phase
6).

---

## 5. Data Model

v1 collections. Fields marked `// v2:` are the footnotes on what a later
version adds back — they are not implemented now.

**User**
```
_id, username, passwordHash, cash, createdAt,
tradeCount, netWorthCached, lastBonusAt, portfolioPublic
// v2: firmId, firmRole, royaltyIncome, achievements[], title
```

**Good**
```
_id, name, colorToken, issuerId, k, n, createdAt
// v2: royaltyRate, launchRegion
```
No `royaltyRate` in v1 — issuing charges a flat fee and pays the issuer
nothing afterward.

**Market** — one document per good, not per good per region
```
_id, goodId (unique), basePrice, supply, vol24h
```
This is the v1 collapse of `RegionalMarket`.
`// v2: this becomes RegionalMarket { goodId, region, basePrice, supply,`
`//      vol24h } with a compound unique index on { goodId, region }, and`
`//      one document per good per region. Redis keys gain the region`
`//      segment: mkt:{goodId}:{region}:supply.`

**Holding**
```
_id, userId, goodId, quantity, avgCost
compound unique index on { userId, goodId }
// v2: region, with the index becoming { userId, goodId, region }
// v2: lockedUntil, for the issuer early-purchase lock
```

**Trade** — immutable ledger shape
```
_id (server-generated, used as the idempotency key),
userId, goodId, side, quantity, price, notional,
spread, streamId, createdAt
// v2: region, royaltyPaid, royaltyTo
```

**PriceSnapshot**
```
_id, goodId, price, supply, resolution, at
// v2: region
```

**Newspaper**
```
_id, date, headlines[] { template, params, text }
```

**Not in v1 at all:** `Shipment`, `Contract`, `Firm`, `WorldEvent`,
`Achievement`. See §26 for the shape each would take when built.

**Redis key scheme (v1)**
```
mkt:{goodId}:supply          live supply
mkt:{goodId}:basePrice       live base price
user:{userId}:cash           live cash
stream:trades                the durable ledger head
lb:networth                  sorted set, net worth leaderboard
rl:trade:{userId}            token bucket
rl:auth:{ip}                 fixed window
lock:job:{name}              job exclusivity lock
```

---

## 6. Repo Structure

```
general-company/
├── docker-compose.yml
├── README.md
├── docs/
│   ├── IMPLEMENTATION_PLAN.md      (this file)
│   ├── DESIGN.md                   (game design doc)
│   └── ARCHITECTURE.md             (diagrams, decision log)
├── packages/
│   ├── shared/                     (curve math, constants, types)
│   │   └── src/
│   │       ├── curve.js
│   │       └── constants.js
│   ├── api/
│   │   └── src/
│   │       ├── models/             (mongoose schemas)
│   │       ├── routes/
│   │       ├── middleware/         (auth, rateLimit, validate)
│   │       ├── services/
│   │       ├── lua/                (trade.lua, ratelimit.lua)
│   │       ├── redis/              (client, script loader, keys)
│   │       └── app.js
│   ├── relay/                      (stream → Mongo projector)
│   ├── jobs/                       (cron runner: drift, leaderboard,
│   │                                newspaper)
│   └── web/                        (React + Vite frontend)
├── sim/                            (Phase 0 economy simulation)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── invariant/
└── loadtest/                       (k6 scripts)
```

Monorepo via npm workspaces. `shared` holds the curve math so the
simulation, API, and relay all use one implementation and cannot drift
apart.

---

## 7. Git Workflow and Commit Conventions

**Branching:** `main` is always working. Each phase gets a branch
(`phase/06-durability`), merged with a PR when its exit criteria pass.
Solo PRs to yourself are worth it: the PR description becomes a written
record of what the phase did and why, which is exactly what you will want
when writing the README later.

**Commit format:** Conventional Commits.

```
feat(api): add POST /trades with sequential execution
fix(relay): make Mongo projection idempotent on retry
test(invariant): assert money supply conservation under load
docs(architecture): record Redis-stream decision and its trade-off
chore(deps): add ioredis
refactor(shared): extract curve integral into pure function
perf(api): coalesce price broadcasts into 250ms batches
```

**Rules:**
- One logical change per commit. If the message needs "and", split it.
- Every phase ends with a `docs:` commit updating the README and decision
  log. Documentation lands with the work, not months later.
- Tag each phase completion: `v0.1-simulation`, `v0.5-atomic`,
  `v0.7-hardened`, `v1.0`.
- Never commit secrets. `.env.example` is committed; `.env` is not.

**Why this matters here specifically:** the commit history is part of the
deliverable. Someone skimming the repo should see the system being built
in a defensible order — economy proven first, then correctness, then
durability, then features. That ordering is itself the argument that you
understood the problem.

---

## 8. Phase 0 — Economy Simulation (no server)

**Goal:** prove the curve math is exploit-free before any infrastructure
exists. If this is wrong, everything built on it inherits the flaw.

**Deliverable:** a standalone script in `/sim` that simulates thousands of
random trades against an in-memory market and asserts economic
invariants.

**Tasks:**
- Implement `price(supply)`, `buyCost(supply, qty)`, `sellReturn(supply,
  qty)` in `packages/shared/src/curve.js`
- Apply the 2% sell spread
- Write a simulation harness: N simulated players, random trades over
  many iterations
- Assert: immediate round-trip is always net negative
- Assert: total Notes equals starting grants minus accumulated spread,
  exactly
- Assert: prices stay within sane bounds across long runs
- Chart or tabulate price evolution to eyeball whether it feels like a
  market

**Commits:**
```
feat(shared): implement bonding curve price function
feat(shared): implement buy cost and sell return integrals
feat(shared): apply sell spread
feat(sim): add random-trade simulation harness
test(sim): assert round-trip is strictly lossy
test(sim): assert money supply conservation
docs(sim): record curve parameters and simulation findings
```

**Exit criteria:** run the simulation with 10,000 random trades. Round
trips always lose. Money supply balances to the exact Note. Prices do not
diverge to infinity or collapse to zero.

**Do not proceed until this is boring and correct.**

Tag: `v0.1-simulation`

---

## 9. Phase 1 — Project Scaffold

**Goal:** an empty but running system with both stores connected.

**Tasks:**
- Initialize npm workspaces monorepo
- Express app with `GET /health` reporting Mongo and Redis connectivity
- Mongoose connection with retry
- `ioredis` client with a Lua script loader
- `docker-compose.yml` for Mongo + Redis
- ESLint, Prettier, Vitest configured
- `.env.example` documenting every variable

**Commits:**
```
chore: initialize monorepo with npm workspaces
chore(api): scaffold express app
feat(api): add mongo connection with retry
feat(api): add redis client and lua script loader
feat(api): add GET /health reporting store connectivity
chore: add docker-compose for mongo and redis
chore: configure eslint, prettier, vitest
docs: add .env.example and local setup instructions
```

**Exit criteria:** `docker-compose up`, then `npm run dev`, then
`GET /health` returns both stores connected.

---

## 10. Phase 2 — Auth and Users

**Goal:** real accounts with real balances.

**Tasks:**
- `User` model: username, passwordHash, cash, createdAt, tradeCount,
  netWorthCached, flags
- `POST /auth/register` — bcrypt hash, grant starting Notes, write cash to
  both Mongo and Redis
- `POST /auth/login` — issue JWT
- `authenticate` middleware
- `GET /me`
- `zod` validation on both auth routes

**Commits:**
```
feat(api): add User model
feat(api): add POST /auth/register with starting grant
feat(api): add POST /auth/login issuing JWT
feat(api): add authenticate middleware
feat(api): add GET /me
feat(api): add zod validation on auth routes
test(api): cover register, login, and auth failure paths
```

**Exit criteria:** register, log in, call `GET /me` with the token, see
the starting grant. Reject duplicate usernames, wrong passwords, and
malformed tokens.

---

## 11. Phase 3 — Goods and Quotes (read-only market)

**Goal:** a visible market. Prices exist and respond to supply. No
trading yet.

**Tasks:**
- `Good` model: name, colorToken, issuerId, k, n
- `Market` model: goodId (unique), basePrice, supply, vol24h — one
  document per good, single global market
- Seed script creating several goods
- Redis key scheme: `mkt:{goodId}:supply`, `mkt:{goodId}:basePrice`
- Warm Redis from Mongo on startup
- `GET /goods` — list with current price
- `GET /goods/:id` — detail
- `GET /goods/:id/quote?side=&qty=` — non-binding quote from Redis, no
  Mongo hit

**Commits:**
```
feat(api): add Good and Market models
feat(api): add market seed script
feat(api): define redis key scheme for market state
feat(api): warm redis market state from mongo on boot
feat(api): add GET /goods listing current prices
feat(api): add GET /goods/:id detail
feat(api): add GET /goods/:id/quote computed from redis
test(api): assert quote matches curve math for known supply
docs(architecture): record single-global-market decision for v1
```

**Exit criteria:** seed the market, fetch a quote, manually change supply
in Redis, fetch again, watch the price move as the curve predicts.

---

## 12. Phase 4 — Trading, Sequential

**Goal:** working trades in plain, readable, non-atomic code. This phase
exists so that Phase 5's rewrite is a targeted fix to an understood
problem rather than premature complexity.

**Tasks:**
- `Holding` model with compound unique index on `{userId, goodId}`
- `Trade` model (immutable ledger shape)
- `POST /trades` — read supply, compute price, check cash or holdings,
  mutate, record
- Enforce per-trade size cap
- Apply sell spread
- `GET /portfolio` — holdings, cash, net worth, unrealized P/L

**Commits:**
```
feat(api): add Holding model
feat(api): add Trade model
feat(api): add POST /trades with sequential execution
feat(api): enforce per-trade size cap
feat(api): apply sell spread to trade execution
feat(api): add GET /portfolio with net worth and P/L
test(api): cover buy, sell, insufficient funds, insufficient holdings
docs(architecture): note the known race condition in sequential trading
```

**Exit criteria:** buy and sell work end to end. Balances, holdings, and
supply all move correctly in single-threaded use.

**Deliberately document the flaw:** write the known race condition into
`ARCHITECTURE.md` now. That commit becomes evidence you identified the
problem before fixing it.

---

## 13. Phase 5 — Atomicity (Redis Lua)

**Goal:** make concurrent trades correct.

**Tasks:**
- Move user cash into Redis (`user:{id}:cash`)
- Write `trade.lua`: read supply and price, check slippage, check
  balance, mutate supply, mutate cash, return result
- Load and cache the script by SHA on boot
- Add `maxSlippage` to the trade request schema
- Rewrite `POST /trades` to call the script
- Holdings mutation follows the script result
- Concurrency test: fire hundreds of simultaneous trades at one good,
  assert final supply equals the sum of quantities and no balance went
  negative

**Commits:**
```
feat(api): move user cash into redis
feat(api): add trade.lua implementing atomic trade execution
feat(api): load lua scripts by SHA at boot
feat(api): add maxSlippage to trade request schema
refactor(api): execute trades via lua script
test(integration): assert no supply drift under concurrent trades
test(integration): assert no negative balances under concurrent trades
test(integration): assert slippage rejection under price movement
docs(architecture): record the atomicity decision and what it fixed
```

**Exit criteria:** 500 concurrent trades on one good produce exactly the
expected final supply. Zero negative balances. Slippage rejections fire
when the price moves past tolerance.

Tag: `v0.5-atomic`

---

## 14. Phase 6 — Durability (stream, relay, rebuild)

**Goal:** eliminate the dual-write. Make Mongo a projection of a Redis
stream rather than a second source of truth.

This is the phase that turns the claim from "concurrent" to
"transactional," and it is the strongest thing in the project.

**Tasks:**
- Extend `trade.lua` to `XADD` the trade to `stream:trades` inside the
  same atomic block
- Generate a trade ID inside the script so projection is idempotent
- Build the relay worker: consumer group reads the stream, writes to
  Mongo `trades`, acknowledges
- Idempotent upsert keyed on trade ID, so at-least-once delivery is safe
- Checkpoint the last projected stream ID
- Build the rebuild command: flush Redis, replay the Mongo ledger,
  reconstruct supply and balances
- Rebuild test: snapshot Redis state, flush it, rebuild, assert identical

**Commits:**
```
feat(api): emit trade to redis stream inside trade.lua
feat(api): generate server-side trade id for idempotent projection
feat(relay): add stream consumer group worker
feat(relay): project stream entries to mongo idempotently
feat(relay): checkpoint last projected stream id
feat(api): add rebuild command replaying ledger into redis
test(invariant): assert rebuilt state matches pre-flush state exactly
test(relay): assert duplicate delivery does not double-write
docs(architecture): record the stream-based durability decision and its fsync trade-off
```

**Exit criteria:** run a few thousand trades. Snapshot every Redis key.
`FLUSHALL`. Run rebuild. Assert every key matches the snapshot exactly.
Kill Mongo mid-load, confirm the stream backs up, restart Mongo, confirm
the relay catches up with no loss and no duplicates.

---

## 15. Phase 7 — Rate Limiting

**Goal:** abuse resistance.

**Tasks:**
- `ratelimit.lua`: token bucket, atomic consume-and-refill
- Per-user trade limit middleware
- Per-IP fixed-window limit on auth routes
- Rate limit headers on responses (`X-RateLimit-Remaining`, `Retry-After`)

**Commits:**
```
feat(api): add ratelimit.lua implementing atomic token bucket
feat(api): add per-user trade rate limit middleware
feat(api): add per-IP auth rate limit
feat(api): return rate limit headers
test(integration): assert burst is capped and refill restores capacity
```

**Exit criteria:** a script firing trades as fast as possible gets
throttled at the configured rate. Auth endpoints resist credential
stuffing.

Tag: `v0.7-hardened`

**Phases 0-7 are the project.** Atomic, durable, rate-limited, provably
conservative of money, and rebuildable from the ledger. Everything beyond
this point is additive and independently shippable. If you stop here, you
have a defensible, complete system — it is just not yet a game anyone
would log into twice.

---

## 16. Phase 8 — Drift and Price History

**Goal:** prices that move when nobody is trading, and a chart to see it.

**Tasks:**
- Drift job on a Redis-locked cron tick
- Bounded random walk on `basePrice` per good
- Volume-biased drift direction
- `PriceSnapshot` writes per tick
- Snapshot rollup: minute resolution 24h, hourly 30d, daily beyond
- `GET /goods/:id/history?range=`

**Commits:**
```
feat(jobs): add redis-locked cron runner
feat(jobs): add price drift tick with bounded random walk
feat(jobs): bias drift by recent volume
feat(api): add PriceSnapshot model and per-tick writes
feat(jobs): add snapshot rollup for older history
feat(api): add GET /goods/:id/history
test(jobs): assert drift stays within per-tick and per-day bounds
test(jobs): assert the redis lock makes the tick exactly-once
```

**Exit criteria:** leave the server running with no trades; prices move
within bounds and the history endpoint returns a usable series. Run two
job runners at once and confirm each tick executes exactly once.

---

## 17. Phase 9 — Real-Time (WebSockets)

**Goal:** the market feels live.

**Tasks:**
- Socket.IO server with JWT handshake auth
- Redis adapter for multi-instance fan-out
- Subscription model: clients subscribe to goods
- Coalesced broadcasts: buffer changed prices, flush every 250ms
- Personal channel: rank changed

**Commits:**
```
feat(api): add socket.io server with JWT handshake auth
feat(api): add redis adapter for multi-instance fan-out
feat(api): add price subscription by good
perf(api): coalesce price broadcasts into 250ms batches
feat(api): add personal event channel
test(integration): assert broadcasts reach clients across two instances
```

**Exit criteria:** two API instances, one Redis. A trade executed against
instance A reaches a client subscribed on instance B in under 100ms.

---

## 18. Phase 10 — Leaderboard and Profiles

**Goal:** a reason to care about your net worth.

One board: net worth. The gain-percent, issuer, shipper, contractor, and
firm boards are v2 — see §26.

**Tasks:**
- Revaluation job: recompute every player's net worth, write to the
  `lb:networth` sorted set
- `GET /leaderboard` — reads the sorted set, never recomputes on request
- `GET /players/:username` public profile
- Portfolio visibility toggle
- Daily login bonus, scaled by account age and activity

**Commits:**
```
feat(jobs): add portfolio revaluation job writing to a sorted set
feat(api): add GET /leaderboard reading from the sorted set
feat(api): add GET /players/:username public profile
feat(api): add portfolio visibility toggle
feat(api): add daily login bonus
test(jobs): assert net worth includes cash and holdings at current price
test(invariant): assert the login bonus is counted as a faucet
```

**Exit criteria:** the leaderboard reflects net worth after the
revaluation tick and costs one Redis call to serve. The money supply
invariant still balances with bonuses as a faucet.

---

## 19. Phase 11 — Issuing Goods

**Goal:** player-created goods. Flat fee, no royalty, no lock.

**Tasks:**
- `POST /goods` gated by net worth, account age, trade count
- Flat issuing fee, burned
- Curve steepness within an allowed band
- Issuer receives no free allocation
- Issued goods appear on the market immediately and trade like any other

**Commits:**
```
feat(api): add POST /goods with issuance gating
feat(api): burn issuing fee on good creation
feat(api): validate curve steepness within allowed band
feat(api): warm redis market state for newly issued goods
test(integration): assert issuance is rejected below the gate thresholds
test(integration): assert the issuer receives no free allocation
test(invariant): assert money supply conservation including issuing fees
docs(architecture): record why the issuer gets no allocation and no royalty in v1
```

**Exit criteria:** a qualifying player issues a good, the fee is burned,
the good is immediately tradeable by everyone including the issuer at the
same prices, and the money supply invariant balances with issuing fees as
a new sink.

**Why the issuer gets no free allocation:** a free allocation is a mint.
It creates value out of nothing and hands it to one player, who can then
sell it into demand generated by other players' buys. Every good would be
an exit-liquidity trap, and the money supply invariant would need a term
for value that was never granted or earned. Charging a fee instead makes
issuance a cost, not an arbitrage.

---

## 20. Phase 12 — Newspaper (rule-based)

**Goal:** a daily artifact that makes yesterday's market legible.

Rule-based templates only. No LLM. No world events.

**Tasks:**
- Event extraction job: scan the last 24h for top gainer, top loser, and
  biggest single trade
- Rule-based headline templates rendering those three events
- `Newspaper` model, daily generation on the locked cron
- `GET /newspaper` — latest, and by date

**Commits:**
```
feat(jobs): add daily market event extraction
feat(jobs): add rule-based headline templates
feat(api): add Newspaper model and daily generation
feat(api): add GET /newspaper
test(jobs): assert headlines render for a seeded 24h of trades
test(jobs): assert generation is idempotent for a given date
```

**Exit criteria:** seed a day of trades, run the job, read a newspaper
with a correct top gainer, top loser, and biggest trade. Running the job
twice for the same date does not produce two newspapers.

---

## 21. Phase 13 — Frontend

**Goal:** a plain, working client. Deliberately basic.

**The UI is intentionally minimal:** plain HTML elements, a single
stylesheet, no component library, no design system, no animation. Default
fonts, a monospace stack for numbers, and enough layout to be readable.
Its job is to exercise the backend and let a stranger use the system
without reading docs — not to look designed.

**Screens:**
- Login / register
- Market list — every good, current price, 24h change
- Good detail — price history chart, supply, issuer, trade panel
- Trade panel — quantity in, live quote out, slippage field, buy/sell
- Portfolio — cash, holdings, net worth, unrealized P/L
- Leaderboard — one table
- Newspaper — three headlines
- Public profile — net worth, rank
- Issue a good — a form, shown only when the player qualifies

**Commits:** one per screen, following the same convention.

```
chore(web): scaffold vite react app with a single stylesheet
feat(web): add login and register screens
feat(web): add market list
feat(web): add good detail with price history chart
feat(web): add trade panel with live quote and slippage control
feat(web): add portfolio screen
feat(web): add leaderboard screen
feat(web): add newspaper screen
feat(web): add public profile screen
feat(web): add issue-a-good form
feat(web): subscribe to live price updates over socket.io
```

**Exit criteria:** a new user can register, find a good, read its chart,
buy it, watch the price move live, and see their rank — without being
told how.

---

## 22. Phase 14 — Load Testing and Hardening

**Tasks:**
- k6 scenarios: sustained mixed trading, hot-good contention burst, quote
  read storm
- Measure p50, p95, p99 for quote and trade
- Run the full invariant suite after each load scenario
- Run the rebuild test after load
- Multi-instance test: two API instances, one Redis, one Mongo
- Publish results in the README with methodology and environment

**Commits:**
```
chore(loadtest): add k6 sustained trading scenario
chore(loadtest): add hot-good contention scenario
chore(loadtest): add quote read storm scenario
test(invariant): run full invariant suite after load
docs: publish benchmark results with methodology
docs: document known limits and failure modes
```

**Exit criteria:** NFR-1 through NFR-6 are demonstrated with published
numbers, not asserted.

---

## 23. Phase 15 — Deployment

**Tasks:**
- Production Dockerfiles for api, relay, jobs
- Deploy API to Render/Railway, Mongo to Atlas, Redis to Upstash
- Configure Redis persistence and document the fsync choice
- Deploy frontend
- Seed production market
- Uptime monitoring

**Commits:**
```
chore: add production dockerfiles
chore: add deployment configuration
docs: document production redis persistence settings
docs: add live demo link and seeded market notes
```

Tag: `v1.0`

---

## 24. Testing Strategy

**Unit** — curve math, drift bounds, backoff, issuance gate predicates.
Pure functions, no I/O.

**Integration** — real Mongo and Redis via Docker. Full request paths:
register, quote, trade, issue.

**Concurrency** — the important ones:
- Simultaneous trades on one good produce correct final supply
- No negative balances under concurrent spend
- Slippage rejects correctly under price movement

**Invariant** — run after every load scenario:
- `total Notes = grants + bonuses − spread − issuing fees`, exactly
- Sum of all holdings equals total supply per good
- No negative balances or holdings anywhere
- Rebuild from ledger reproduces Redis state byte-for-byte

**Load** — k6, numbers published, methodology documented.

---

## 25. Definition of Done

A phase is done when:
1. Its exit criteria pass
2. Tests for it are written and green
3. The README and decision log reflect it
4. The branch is merged to `main` and `main` still works
5. The phase tag is pushed

The project is done when the six success criteria in §2 hold and the
README lets a stranger understand every architectural decision without
you in the room — including the decision to defer everything in §26.

---

## 26. Deferred to Later Versions

Nothing here was abandoned. Each entry records what was cut, why it was
cut from v1, and which version it is planned for. The original design
reasoning is carried over verbatim in substance so that building it later
is picking up a shelved plan rather than redesigning from scratch.

### 26.1 Contracts and escrow — v2

**What was cut:** posting a contract (good, quantity, destination,
payment, expiry), escrow at posting, accept, server-verified fulfillment,
expiry with refund minus a posting fee, and the expiry job. The
`Contract` collection.

**Why cut for v1:** contracts are an additive player-to-player system.
The market is complete and correct without them. They add a stateful
multi-step lifecycle and a second kind of money-at-rest to the invariant,
which is game complexity, not new backend learning — the atomicity
lesson is already fully taught by the trade path.

**Design reasoning to carry forward:**
- **Payment must be escrowed at posting, not at fulfillment.** If the
  poster keeps the money until delivery, a contract is an unfunded
  promise: the fulfiller does the work, ships the goods, and the poster
  can be broke by the time delivery lands. Escrow at posting is what
  makes the contract a real obligation.
- **Fulfillment must be verified server-side before escrow releases.**
  The client asserting "I delivered" is the entire attack surface of the
  feature. The server checks the holdings movement itself.
- **Escrow cannot be double-claimed.** Accept and fulfill must be atomic
  against the escrow state, or two accepters race and one contract pays
  twice. This is the same Lua-atomicity argument as the trade path, which
  is why it is cheap to build once Phase 5 exists.
- **Expiry refunds minus a posting fee.** A free-to-post, free-to-expire
  contract is a spam vector — post a thousand attractive contracts,
  expire them all, cost nothing, and pollute the board. The fee is the
  cost of occupying board space.
- **Invariant change:** escrowed Notes are still in circulation and must
  be counted in the money supply total, not treated as burned.

**Planned for:** v2, after regions return — contracts are most
interesting when the payment is for *delivery to a region*, which is what
makes them different from just buying on the market.

### 26.2 Firms — v2

**What was cut:** the `Firm` collection, create/join/leave, member roles,
a shared treasury with contribution and withdrawal permissions, and the
firm leaderboard.

**Why cut for v1:** firms are a social layer on top of a working economy.
They add permission modeling and a shared-balance concurrency problem
without teaching anything the single-user cash path has not already
taught.

**Design reasoning to carry forward:**
- **A shared treasury needs permission tiers, not just membership.** If
  every member can withdraw, one defector drains the treasury and the
  feature is a griefing tool. Founder / officer / member with explicit
  withdrawal permissions is the minimum viable model.
- **The treasury is a second cash balance and must obey the same rules as
  a user's.** It lives in Redis, mutates inside Lua, and counts toward
  the money supply total. A firm treasury is not a special case — it is
  another account.
- **Joining and leaving must not move money implicitly.** Contributions
  are explicit transfers. Otherwise leaving becomes an exploit vector.

**Planned for:** v2.

### 26.3 World events — v2

**What was cut:** the world event scheduler and the `WorldEvent`
collection; events that modify drift, tariffs, or shipping times for a
window.

**Why cut for v1:** world events are a modifier layer over systems v1
mostly does not have (tariffs, shipping). What remains — modifying drift
— is cosmetic variance on a random walk that already has variance.

**Design reasoning to carry forward:**
- Events exist to break the monotony of an economy where the only inputs
  are player trades and a bounded random walk. They give the newspaper
  something to report that players did not cause.
- Event modifiers must be **bounded and time-boxed**, applied as
  multipliers read at tick time rather than written into base state, so
  an event can expire cleanly without a compensating write.
- Events must never mint or burn Notes directly. They change rates, not
  balances, so the money supply invariant is untouched by design.

**Planned for:** v2, alongside the shipping and tariff systems the
modifiers act on.

### 26.4 LLM-generated newspaper headlines — someday, if ever

**What was cut:** optional LLM headline generation with template
fallback. v1 and v2 use rule-based templates only.

**Why cut:** an LLM call in a daily cron job adds an API key to manage, a
network failure mode, a cost line, and non-determinism to a feature whose
entire job is to state three facts about yesterday. The template produces
the same information reliably and is testable.

**Design reasoning to carry forward:** if it is ever revisited, the
architecture already anticipated the right shape — **generate with the
LLM, fall back to the template on any failure**, never the reverse. The
`Newspaper` model already stores `{ template, params, text }` per
headline, so an LLM version writes into `text` while `template` and
`params` remain the deterministic record of what actually happened.

**Planned for:** someday. Explicitly not v2.

### 26.5 Achievements and titles — v3

**What was cut:** achievement definitions, award checks, display on
profiles, and titles.

**Why cut for v1:** a pure retention mechanic. It is a predicate
evaluated on a schedule and a list rendered on a page. No backend
learning value, and every achievement is a small ongoing design decision.

**Design reasoning to carry forward:** achievements should be **pure
predicates over the trade ledger and profile state**, evaluated by the
revaluation job, never awarded inline during a trade. Awarding inline
puts game logic in the atomic hot path for no reason and makes the Lua
script a place where features accumulate.

**Planned for:** v3.

### 26.6 Regions and shipping — simplified for v1, returns in v2

**What was simplified:** v1 collapses four regions to a **single global
market**. One supply and one base price per good. No `Shipment` model, no
routes, no tariffs, no in-transit state, no arrival job. `RegionalMarket`
becomes a single `Market` document per good.

**Why simplified for v1:** the region dimension multiplies every market
read, key, index, and test by four while the core engineering claims —
atomicity, durability, conservation — are identical in one market or
four. Shipping adds a whole scheduled-job subsystem and a third holding
state (in-transit) to net worth. Reduced scope to lower complexity, not
because the design was wrong.

**Design reasoning to carry forward:**
- **Regions create arbitrage, and arbitrage is what makes a second player
  worth having.** In a single global market, the only thing to do is bet
  on the curve. With regions, price gaps open between markets, and a
  player who notices one can buy low in region A and sell high in region
  B — a strategy that requires paying attention rather than guessing.
  This is the single strongest reason to build v2.
- **Shipments take real time on purpose.** Instant transfer would make
  arbitrage risk-free and instantly self-closing. Travel time is what
  makes it a bet: the gap can close while the goods are in transit.
- **Goods in transit cannot be sold.** Otherwise the risk above
  evaporates — a player would ship and sell simultaneously and capture
  the spread with no exposure.
- **Arrivals are processed by a scheduled job, not lazily on read.**
  Lazy arrival means a player's holdings depend on when someone looked at
  them, which is unobservable, untestable, and wrong when two readers
  race.
- **Tariffs are a burn, not a transfer.** They are a money sink that
  makes arbitrage cost something, and they enter the invariant as a
  subtraction.

**What v2 adds back to the data model:** `Market` → `RegionalMarket`
with `{ goodId, region }` compound unique index; `region` on `Holding`
(index becomes `{ userId, goodId, region }`), `Trade`, and
`PriceSnapshot`; a new `Shipment` collection
`{ userId, goodId, from, to, quantity, dispatchedAt, arrivesAt,
tariffRate, status }`; region and route configuration; in-transit value
in net worth. Redis keys gain a region segment.

**Planned for:** v2. This is the first thing to build after v1 ships.

### 26.7 Issuance royalties and the issuer lock — simplified for v1, returns in v2

**What was simplified:** v1 issuance is **flat fee only**. No royalty
accrual, no `royaltyRate` on `Good`, no issuer early-purchase lock, no
royalty income on profiles, no issuer leaderboard.

**Why simplified for v1:** the royalty threads a payout through the
atomic trade path and adds a term to every invariant test, and the lock
adds time-based holding state. The flat fee alone already demonstrates
the sink and the gating. Reduced scope to lower complexity.

**Design reasoning to carry forward:**
- **The royalty must be paid from the spread, never minted.** The spread
  is already being taken out of circulation on every sell. Redirecting a
  slice of it to the issuer turns a burn into a transfer, which keeps the
  money supply invariant intact with no new faucet. Minting the royalty
  instead would make every issued good an inflation source and the
  invariant unprovable.
- **The issuer gets no free allocation.** (Stated in Phase 11 and true in
  v1 — repeated here because it is the reason the royalty exists at all.)
  A free allocation is a mint handed to one player who can sell it into
  demand other players created. The royalty is the *correct* way to
  reward an issuer: it pays out only when the good actually trades, and
  it comes from money already leaving circulation.
- **The 48h purchase lock with a 7 day hold exists to stop the issuer
  front-running their own launch.** Without it, the issuer buys the
  entire cheap early curve themselves, announces the good, and sells into
  the players who arrive. The lock means anything the issuer buys in the
  launch window is illiquid long enough that they cannot profit from the
  information asymmetry of having created the good.
- The lock needs a `lockedUntil` on `Holding` and a check in the sell
  path — one more branch in the Lua script.

**What v2 adds back to the data model:** `royaltyRate` on `Good`;
`royaltyPaid` and `royaltyTo` on `Trade`; `lockedUntil` on `Holding`;
`royaltyIncome` on `User`.

**Planned for:** v2.

### 26.8 Additional leaderboards — simplified for v1, return in v2

**What was simplified:** v1 has exactly one board — **net worth**. Cut
for now: 24h gain absolute, 24h gain percent, issuers, shippers,
contractors, and firms.

**Why simplified for v1:** each extra board is another sorted set
maintained by the revaluation job. The first board teaches the pattern —
precompute on a schedule, serve from a sorted set, never compute on page
load. The sixth board teaches nothing the first did not, and three of
them rank activities v1 does not have.

**Design reasoning to carry forward:**
- **Boards are computed on a schedule and never on page load.** Net worth
  requires valuing every holding at the current curve price; doing that
  per request is a read amplification that scales with player count on
  the hot path. The sorted set makes the read O(log N) and the write a
  background job's problem.
- **Gain-percent boards need a snapshot baseline**, not a live diff —
  they compare against a stored net worth from 24h ago, which means the
  revaluation job must retain a rolling history, not just the latest
  value.
- The shipper, contractor, issuer, and firm boards are blocked on their
  features existing (§26.6, §26.1, §26.7, §26.2) and land with them.

**Planned for:** v2, alongside the features they rank.

---

## Appendix — Version Roadmap at a Glance

| Version | Adds |
|---|---|
| **v1** (this plan) | Bonding curve, single global market, atomic Lua trades, stream durability + rebuild, rate limiting, drift, price history, WebSockets, net worth leaderboard, flat-fee issuance, rule-based newspaper, basic UI |
| **v2** | Regions + shipping + tariffs, contracts + escrow, firms + treasury, world events, issuer royalties + launch lock, the remaining leaderboards |
| **v3** | Achievements and titles |
| **Someday** | LLM headline generation with template fallback |
