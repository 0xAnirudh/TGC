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
| 5 | Atomicity (Redis Lua) | |
| 6 | Durability (stream, relay, rebuild) | |
| 7 | Rate limiting | |
| 8 | Drift and price history | |
| 9 | Real-time (WebSockets) | |
| 10 | Leaderboard and profiles | |
| 11 | Issuing goods | |
| 12 | Newspaper | |
| 13 | Frontend | |
| 14 | Load testing | |
| 15 | Deployment | |

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
docker compose up -d          # mongo + redis, or run them locally:
                              #   brew services start redis
                              #   (and point MONGO_URI at Atlas)
cp .env.example .env          # then fill in JWT_SECRET
npm install
npm run dev --workspace=@tgc/api

curl localhost:4000/health
```

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
