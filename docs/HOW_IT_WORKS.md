# How It Works

A plain-language tour of this codebase, written for someone comfortable
with MERN, REST and JWT who has not used Redis for anything beyond
caching.

`ARCHITECTURE.md` records *why* each decision was made and what was
rejected. This file explains *what the thing actually does*. Read this
one first.

---

## 1. The game in one paragraph

Players get 100,000 Notes when they sign up. They buy and sell goods.
There are no other players on the other side of a trade - the price comes
from a formula, and buying pushes it up while selling pushes it down. You
make money by buying something before other people do. That is the whole
game.

---

## 2. The one idea you need: the bonding curve

Normally a market needs a buyer and a seller to agree on a price. That
means an order book, matching, partial fills - a lot of machinery.

This project skips all of it. The price is a function of how many units
exist:

```
price = basePrice × (1 + supply / k) ^ n
```

Three numbers define a good, and they never change once it is created:

| | |
|---|---|
| `basePrice` | what one unit costs when none exist |
| `k` | how much supply it takes to move the price. Small `k` = jumpy. |
| `n` | how sharply the price accelerates. `n=1` nearly straight, `n=3` steep. |

Copper is `basePrice=120, k=12000, n=2`. So:

- at supply 0: `120 × (1 + 0)² = 120`
- at supply 12,000: `120 × (1 + 1)² = 480`

**The part that trips everyone up.** If Copper shows a price of 480 and
you buy 500 units, you do **not** pay `480 × 500`. As you buy, the supply
rises, so the price rises *while your own order is filling*. You pay the
area under the curve between supply 12,000 and 12,500, which works out to
245,035 - an average of 490 per unit, not 480.

That is why a quote returns `avgPrice` and `priceAfter`, not just
`spotPrice`. Big orders move the price against you. That is a real market
behaviour, and here it falls out of the maths for free.

**Selling takes a 2% cut** (the spread), and those Notes are destroyed -
not paid to anyone. This is what stops you buying and instantly selling
for a profit. Buy 500 Copper for 245,035, sell it straight back, get
230,333. You lost 4,701 plus the curve movement. Every time. That is
proven for 1,500 different parameter combinations in
`tests/invariant/roundtrip.test.js`.

---

## 3. Why there are two databases

This is the part that looks like over-engineering and is not.

**MongoDB** is what you would expect: users, goods, the trade history.
Mongoose models, nothing surprising.

**Redis** holds four things that change constantly and must be read
fast: every good's current supply, every good's current base price, every
player's cash, and (later) the trade log.

Why not just use Mongo for all of it? Two reasons.

**Speed.** A quote is just arithmetic on two numbers. Going to Atlas for
them costs 50-200ms over the network. Redis is in memory and answers in
under a millisecond. The market has to feel live.

**The real reason - two people trading at once.** Say Copper has 1,000
units and two players buy 100 each at the same moment. With ordinary
Mongo code:

```
Player A reads supply  → 1000
Player B reads supply  → 1000     ← both read the same number
Player A writes supply → 1100
Player B writes supply → 1100     ← A's purchase just vanished
```

Supply should be 1,200. It is 1,100. 100 units were created from nothing,
and no error was raised anywhere. This is the bug the entire project is
built to not have, and Phase 5 is where it gets fixed properly.

**Which database wins?** While the system is running, **Redis is the
truth** for supply, prices and cash. Mongo is the durable record it is
rebuilt from if Redis is ever lost. That is why warming Redis on boot uses
`SET NX` (set only if missing): Redis holds the supply that trades
actually produced, Mongo's copy lags behind, so overwriting Redis from
Mongo at startup would silently undo trades.

---

## 4. Where the money goes

Every Note in the system is in exactly one of three places:

```
cash     held by players
reserve  paid into the curve when someone buys, paid back out when they sell
burned   taken by the 2% spread, gone forever
```

Notes only ever *enter* through a signup grant. So at every instant:

```
everything ever granted  ==  cash + reserve + burned
```

This is checked as a test, and it has to balance **to the exact Note** -
not approximately. An economy that leaks one Note per thousand trades is
an economy with an exploit nobody has found yet. It is also why every
amount is a whole integer: floating point literally cannot express "these
two numbers are equal" reliably, so `cash` is never a float anywhere.

---

## 5. What exists right now

| Where | What |
|---|---|
| `packages/shared/` | The curve maths. Pure functions, no database. Used by the simulation and the API both, so they cannot disagree. |
| `sim/` | Phase 0. Runs 10,000 random trades in memory with no server, and asserts the economy is sound before any infrastructure was written. |
| `packages/api/src/models/` | Mongoose schemas. Ordinary MERN. |
| `packages/api/src/routes/` | Express routes. Ordinary REST. |
| `packages/api/src/services/` | The logic the routes call. |
| `packages/api/src/redis/` | Redis connection, key names, and the Lua script loader. |
| `packages/api/src/lua/` | Scripts that run *inside* Redis. Only a smoke test so far; the real one lands in Phase 5. |
| `tests/invariant/` | The economy tests. If these fail, the game is broken. |

Endpoints so far, all ordinary REST with a JWT:

```
POST /auth/register     create an account, get 100,000 Notes and a token
POST /auth/login        get a token
GET  /me                your account         (needs token)
GET  /goods             list the market
GET  /goods/:id         one good in detail
GET  /goods/:id/quote   price a hypothetical trade
GET  /health            are both databases up?
```

---

## 6. What is still coming, and which part is the interesting one

- **Phase 4** - trading, written the obvious way, with the race condition
  from section 3 left in on purpose and documented.
- **Phase 5** - fixing it. The check-and-update becomes one Lua script
  that Redis runs start-to-finish with nothing else interleaved. About
  40 lines. This is the single most valuable thing in the project.
- **Phase 6** - making it survive a crash. Instead of writing to Redis
  and then to Mongo (where the second write can fail and leave them
  disagreeing), the trade is appended to a log inside Redis, and a small
  separate process copies entries from that log into Mongo. There is no
  second write that can fail, so there is nothing to undo.
- **Phases 7-15** - rate limiting, prices that drift on their own, live
  updates, a leaderboard, player-created goods, a daily newspaper, the
  frontend, load testing, deployment.

If someone asks what is technically interesting about this project, the
answer is sections 3 and 4 and Phases 5 and 6. The rest is competent
CRUD.
