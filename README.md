# General Company

A player-driven virtual economy. Players trade goods whose prices move on
a bonding curve and issue their own goods into a single global market.

The engineering substance is a concurrent, transactional market engine
built on Redis and MongoDB:

- Trades execute atomically inside a Redis Lua script, so concurrent
  trades on the same good cannot interleave.
- The durable ledger is a Redis stream. A relay worker projects it into
  MongoDB, so Mongo is a projection rather than a second source of truth
  and there is no dual write to diverge.
- Market state is fully reconstructable from that ledger. Flushing Redis
  and rebuilding reproduces supply and balances exactly.
- The money supply is conserved by construction and asserted by test.

## Status

In development, built in phases. See
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full
build plan, the requirements analysis, and the record of what was
deliberately deferred to later versions, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the decision log.

**New here?** [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) explains what
the system does in plain language, for someone who knows MERN but has not
used Redis for more than caching.

| Phase | | |
|---|---|---|
| 0 | Economy simulation | done — `v0.1-simulation` |
| 1 | Project scaffold | done — verified against Atlas + Redis |
| 2 | Auth and users | done |
| 3 | Goods and quotes | done |
| 4 | Trading, sequential | done |
| 5 | Atomicity (Redis Lua) | done — `v0.5-atomic` |
| 6 | Durability (stream, relay, rebuild) | done |
| 7 | Rate limiting | done |
| 8 | Drift and price history | done |
| 9 | Real-time (WebSockets) | done |
| 10 | Leaderboard and profiles | done |
| 11 | Issuing goods | done |
| 12 | Newspaper | done |
| 13 | Frontend | done — **playable** |
| 14 | Load testing | done |
| 15 | Deployment | config ready — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |

## Layout

```
packages/shared/   curve math and economic constants
sim/               Phase 0 economy simulation (no server)
tests/unit/        pure-function tests
tests/invariant/   economic invariant tests
docs/              implementation plan, architecture decision log
```

## Running

```bash
# 1. stores
docker compose up -d                 # or: brew services start redis
                                     # (and point MONGO_URI at Atlas)

# 2. configure
cp .env.example .env                 # fill in MONGO_URI and JWT_SECRET
npm install
npm run seed --workspace=@tgc/api    # create the starting market

# 3. run all four processes, each in its own terminal
npm run dev --workspace=@tgc/api     # the API            :4000
npm run dev --workspace=@tgc/relay   # stream -> mongo projector
npm run dev --workspace=@tgc/jobs    # drift, leaderboard, newspaper
npm run dev --workspace=@tgc/web     # the frontend       :5173
```

Then open <http://localhost:5173>, create an account, and trade. You
start with 100,000 Notes.

**The API alone is enough to trade**, but without the relay nothing
reaches MongoDB, and without the job runner prices never drift, the
leaderboard stays empty and no newspaper is printed.

`GET /health` is readiness: it checks both stores and answers 503 while
either is down, naming which one. `GET /health/live` is liveness and
never touches a store.

Other commands:

```bash
npm run sim      # run the economy simulation
npm test         # run the test suite
npm run lint     # eslint
npm run format   # prettier
```

The simulation takes flags: `npm run sim -- --trades=50000 --seed=7
--players=500`. It is seeded, so a run that fails is a run you can
reproduce.

## Benchmarks

Measured with `npm run loadtest`, against the API on a local machine with
MongoDB on Atlas and Redis local. 40 accounts, 8 goods, 20 concurrent
users, 1,500 quotes and 600 trades.

| Path | p50 | p95 | p99 | Target |
|---|---|---|---|---|
| `GET /goods/:id/quote` | 2.94ms | **8.69ms** | 11.64ms | NFR-1: p95 < 10ms |
| `POST /trades` | 6.25ms | **12.35ms** | 14.06ms | NFR-2: p95 < 50ms |

The money-supply invariant balanced to the exact Note after the run.

Latency at other concurrency levels, same hardware:

| Concurrent users | quote p95 | trade p95 |
|---|---|---|
| 1 | 3.27ms | 3.28ms |
| 5 | 3.15ms | 4.51ms |
| 20 | 8.69ms | 12.35ms |

**Methodology, and one thing worth knowing.** The first version of this
load test fired every request at once with `Promise.all` and reported a
quote p95 of **12.8 seconds**. That number measured nothing but how long
1,500 requests take to queue through a single Node process - latency
under a stampede is queueing time, not service time. The test now holds
concurrency fixed at a set number of virtual users, which is what the
figures above describe.

It also found a real defect: quote p95 was 827ms against a p50 of 42ms,
and the entire tail was one Atlas round trip. Both the quote and trade
paths were calling `Good.findById` for the curve parameters, so NFR-1's
"no Mongo round trip on the hot path" was not actually true. `k` and `n`
never change after a good is created, so they are now cached in Redis -
which is what took quote p95 from 827ms to 8.69ms.

## Phase 0 result

The curve math is proven exploit-free before any infrastructure depends
on it. A default run of 10,000 trades across 200 players and 8 goods:

- round trips are lossy in all 1,500 parameter combinations tested, and
  chunking a round trip loses more rather than less
- the money supply balances to the exact Note - `granted == cash +
  reserve + burned` - at every checkpoint and across six seeds
- prices plateau between roughly 2x and 5x rather than diverging
- rounding dust accumulates in the curve reserve at 0.4958 Notes per
  trade, always positive, always inside the invariant

Details, including the reasoning behind each decision, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
