# The Haul

A trading game. Thirty days, six towns, and a debt that grows while you
sleep.

You open owing **5,000 Notes** against **2,000** in hand, at 7% a day
compounding. Every town reprices every good every day, and you only see
prices where you are standing. Travelling costs a day. The cart holds a
hundred units. On the last day the cart is sold, the debt is settled,
and whatever is left is your score.

Then you go again. A run takes about three minutes.

```bash
npm install
npm run dev        # api on :4000, web on :5173
```

Needs MongoDB and Redis. Copy `.env.example` to `.env` and fill in
`MONGO_URI`, `REDIS_URL` and `JWT_SECRET`.

---

## What is interesting about it

**Prices are a pure function of the run's seed.** Nothing is stored and
nothing is random at request time - a price is derived from the seed, the
day and the town. So a finished run can be **replayed from its action log
and its score recomputed**, which is what makes the leaderboard something
other than a list of numbers clients reported about themselves.

The seed is generated server-side and never sent to a live run. Knowing
it would mean computing every future price in every town, which is the
one thing the game exists to withhold.

**Every action goes through a single Redis Lua script.** Read the run,
decide against it, write it back - done in JavaScript, a double-clicked
buy reads the same opening balance twice and spends it twice. Redis runs
a script start to finish with nothing interleaved, so the second click
sees what the first one left.

**Buying in bulk moves the price against you.** Filling a cart costs
about a fifth more per unit than a token purchase, so a big score needs
more than one good day.

---

## Layout

```
packages/shared/src/haul.js   the world: towns, goods, prices, debt
packages/api/src/lua/haul.lua one action, applied atomically
packages/api/src/services/    run lifecycle and road events
packages/web/src/haul/        the game screen
tests/                        89 tests
```

```bash
npm test           # everything
npm run lint
```

---

## Tuning, and what the playtests said

Numbers in a game like this are the design, and the first guesses were
wrong twice over.

**The first price spread was absurd.** Saffron ranged from 31 to 172,000
and day five offered a 28,000% trade. One lucky roll decided the run and
skill stopped mattering. Swings and shocks came down until a good sits
within two or three times its base and rarely five.

**The first debt was unbeatable.** 12% a day compounds to thirty times
over a run - 5,000 becomes 150,000 - so clearing it meant turning a 2,000
stake into seventy-five times itself. Every playtest ended ruined. At 7%
it compounds to seven and a half, and three bot strategies now finish:

| strategy | score | peak debt |
|---|---|---|
| never repays | 124,440 | 35,603 |
| repays early | 191,099 | 5,350 |
| patient buyer | 315,901 | 11,267 |

That spread is the game: the same thirty days, two and a half times the
result.

**The hash was quietly biased.** FNV-1a alone left 8.6% more values in
some tenths of the range than others - small enough never to notice,
large enough to make certain goods cheaper than intended. A murmur3
finaliser flattens it to 3%.

---

## History

This repo previously held a different game: a persistent shared market
with a bonding curve, atomic Lua trades, a Redis-stream ledger with a
relay worker, regions, shipping, short selling, player-issued goods and
NPC traders. It was interesting to build and dull to play - no clock, no
score, and prices that drifted a percent an hour.

The engineering survived the rewrite in a better form. The money-supply
invariant guarded a shared economy this game no longer has; the
replay-determinism property guards a leaderboard, which is the thing
players would actually lie about. The old design and the reasoning behind
it are in the git history from `v0.1-simulation` to `v1.0`.
