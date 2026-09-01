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
deliberately deferred to later versions.

| Phase | | |
|---|---|---|
| 0 | Economy simulation | in progress |
| 1 | Project scaffold | |
| 2 | Auth and users | |
| 3 | Goods and quotes | |
| 4 | Trading, sequential | |
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
npm install
npm run sim      # run the economy simulation
npm test         # run the test suite
```
