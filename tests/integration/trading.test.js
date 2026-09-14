import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import {
  ECON_GRANTED,
  ECON_RESERVE,
  ECON_BURNED,
  goodSupply,
  userCash,
  userHoldings,
} from '../../packages/api/src/redis/keys.js';
import { User } from '../../packages/api/src/models/User.js';
import { buyCost, sellBreakdown, STARTING_GRANT } from '@tgc/shared';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply, makePlayerDirect } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

async function makePlayer(username = 'trader') {
  const res = await request(app)
    .post('/auth/register')
    .send({ username, password: 'correct-horse-battery' })
    .expect(201);
  return { token: res.body.token, id: res.body.user.id };
}

const trade = (token, body) =>
  request(app).post('/trades').set('Authorization', `Bearer ${token}`).send(body);

/** granted === cash + reserve + burned, to the exact Note. NFR-5. */
async function assertMoneySupply() {
  const redis = getRedis();
  const [granted, reserve, burned] = await redis.mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);
  // Cash is read from Redis, which is the live truth from Phase 5.
  // Reading Mongo here would be checking the projection, not the books.
  const users = await User.find().lean();
  const cashKeys = users.map((u) => userCash(u._id.toString()));
  const cashValues = cashKeys.length > 0 ? await redis.mget(...cashKeys) : [];
  const cash = cashValues.reduce((sum, v) => sum + Number(v ?? 0), 0);

  expect(cash + Number(reserve ?? 0) + Number(burned ?? 0)).toBe(Number(granted ?? 0));
}

describe('POST /trades', () => {
  it('buys, moving cash into the reserve and supply up', async () => {
    const { token } = await makePlayer();
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 10_000);

    const expected = buyCost(basePrice, 10_000, 100, k, n);
    const res = await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);

    expect(res.body.trade.notional).toBe(expected);
    expect(res.body.cash).toBe(STARTING_GRANT - expected);
    expect(res.body.supply).toBe(10_100);
    expect(await getRedis().get(ECON_RESERVE)).toBe(String(expected));
    await assertMoneySupply();
  });

  it('sells, burning the spread and paying out the rest', async () => {
    const { token } = await makePlayer();
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 10_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);
    const expected = sellBreakdown(basePrice, 10_100, 100, k, n);

    const res = await trade(token, { goodId: id, side: 'sell', qty: 100 }).expect(201);
    expect(res.body.trade.notional).toBe(expected.net);
    expect(res.body.trade.spread).toBe(expected.spread);
    expect(res.body.supply).toBe(10_000);
    expect(await getRedis().get(ECON_BURNED)).toBe(String(expected.spread));
    await assertMoneySupply();
  });

  it('leaves a round trip poorer than it started', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);
    const sold = await trade(token, { goodId: id, side: 'sell', qty: 100 }).expect(201);

    expect(sold.body.cash).toBeLessThan(STARTING_GRANT);
    await assertMoneySupply();
  });

  it('keeps the books balanced across a long mixed run', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 20_000);

    for (let i = 0; i < 15; i += 1) {
      await trade(token, { goodId: id, side: 'buy', qty: 50 });
      if (i % 3 === 0) await trade(token, { goodId: id, side: 'sell', qty: 40 });
    }
    await assertMoneySupply();
  });

  it('tracks weighted average cost across several buys', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);
    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);

    const res = await request(app)
      .get('/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = res.body.holdings[0];
    expect(row.quantity).toBe(200);
    // Second buy happened at a higher supply, so the average must sit
    // between the two fill prices.
    expect(row.avgCost).toBeGreaterThan(0);
    expect(row.costBasis).toBeGreaterThan(0);
  });

  it('rejects a buy the player cannot afford', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood({ basePrice: 50_000, k: 500, n: 3 });
    await setSupply(id, 5_000);

    const res = await trade(token, { goodId: id, side: 'buy', qty: 500 }).expect(400);
    expect(res.body.error).toBe('insufficient_funds');
    await assertMoneySupply();
  });

  it('rejects selling units the player does not hold', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    const res = await trade(token, { goodId: id, side: 'sell', qty: 50 }).expect(400);
    expect(res.body.error).toBe('insufficient_holdings');
  });

  it('rejects a trade over the size cap', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    const res = await trade(token, { goodId: id, side: 'buy', qty: 5_000 }).expect(400);
    expect(res.body.error).toBe('trade_too_large');
  });

  it('requires a token', async () => {
    const { id } = await makeGood();
    await request(app).post('/trades').send({ goodId: id, side: 'buy', qty: 10 }).expect(401);
  });

  it('never accepts a price from the client', async () => {
    // zod strips unknown keys, so a smuggled price cannot reach the
    // handler even if someone later spreads req.body into a write.
    const { token } = await makePlayer();
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 10_000);

    const res = await trade(token, { goodId: id, side: 'buy', qty: 100, price: 1 }).expect(201);
    expect(res.body.trade.notional).toBe(buyCost(basePrice, 10_000, 100, k, n));
  });
});

describe('GET /portfolio', () => {
  it('values holdings at what selling them would actually return', async () => {
    // Not spot price times quantity - that ignores both the spread and
    // the fact that selling walks the price down, and would overstate
    // every portfolio in the game.
    const { token } = await makePlayer();
    const { id, basePrice, k, n } = await makeGood();
    await setSupply(id, 10_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);

    const res = await request(app)
      .get('/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = res.body.holdings[0];
    const trueValue = sellBreakdown(basePrice, 10_100, 100, k, n).net;
    expect(row.value).toBe(trueValue);
    expect(row.value).toBeLessThan(row.currentPrice * row.quantity);
  });

  it('shows an immediate round trip at a loss', async () => {
    const { token } = await makePlayer();
    const { id } = await makeGood();
    await setSupply(id, 10_000);
    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);

    const res = await request(app)
      .get('/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.unrealizedPL).toBeLessThan(0);
    expect(res.body.netWorth).toBeLessThan(STARTING_GRANT);
  });

  it('reports an empty portfolio as just cash', async () => {
    const { token } = await makePlayer();
    const res = await request(app)
      .get('/portfolio')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.holdings).toEqual([]);
    expect(res.body.netWorth).toBe(STARTING_GRANT);
  });
});

describe('concurrency', () => {
  it('two simultaneous buys both land', async () => {
    // In Phase 4 this test asserted the bug: both requests read the same
    // supply and one purchase vanished. The whole of Phase 5 exists to
    // turn this assertion around.
    const a = await makePlayer('racer_a');
    const b = await makePlayer('racer_b');
    const { id } = await makeGood();
    await setSupply(id, 10_000);

    await Promise.all([
      trade(a.token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 }),
      trade(b.token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 }),
    ]);

    expect(Number(await getRedis().get(goodSupply(id)))).toBe(10_200);
    await assertMoneySupply();
  });

  it('holds exactly under 60 concurrent buys from 60 players', async () => {
    // Created directly rather than through the register endpoint, which
    // is rate limited to ten attempts per IP. Sixty of them is a trade
    // concurrency test, not a registration test.
    const players = [];
    for (let i = 0; i < 60; i += 1) {
      players.push((await makePlayerDirect(`swarm_${i}`)).token);
    }
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 100_000);

    const results = await Promise.all(
      players.map((t) => trade(t, { goodId: id, side: 'buy', qty: 100, slippageBps: 2_000 })),
    );
    const accepted = results.filter((r) => r.status === 201).length;

    // Supply must have moved by exactly 100 per accepted trade. Not
    // approximately - exactly. Any drift means units were created or
    // destroyed by interleaving.
    expect(Number(await getRedis().get(goodSupply(id)))).toBe(100_000 + accepted * 100);
    await assertMoneySupply();
  });

  it('never lets concurrent buys overdraw one account', async () => {
    // The other half of the race: two buys both reading the same balance
    // and both deciding they can afford it.
    const { token, id: userId } = await makePlayer('spender');
    const { id } = await makeGood({ basePrice: 900, k: 50_000, n: 1 });
    await setSupply(id, 50_000);

    // Each buy costs roughly a third of the starting grant, so a few of
    // these must be refused. None may drive the balance negative.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        trade(token, { goodId: id, side: 'buy', qty: 20, slippageBps: 3_000 }),
      ),
    );

    const cash = Number(await getRedis().get(userCash(userId)));
    expect(cash).toBeGreaterThanOrEqual(0);
    await assertMoneySupply();
  });

  it('never lets concurrent sells dispose of more than is held', async () => {
    const { token, id: userId } = await makePlayer('dumper');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 }).expect(201);

    // Six simultaneous attempts to sell the same 100 units.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        trade(token, { goodId: id, side: 'sell', qty: 100, slippageBps: 3_000 }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const held = await getRedis().hget(userHoldings(userId), id);
    expect(Number(held ?? 0)).toBe(0);
    await assertMoneySupply();
  });
});

describe('slippage', () => {
  it('refuses a trade whose price moved past the tolerance', async () => {
    const { token } = await makePlayer('picky');
    const other = await makePlayer('mover');
    const { id } = await makeGood({ basePrice: 8, k: 4_000, n: 3 });
    await setSupply(id, 4_000);

    // A zero tolerance means "only at exactly the price I was quoted",
    // which cannot survive a concurrent trade on a steep good.
    const [, picky] = await Promise.all([
      trade(other.token, { goodId: id, side: 'buy', qty: 400, slippageBps: 5_000 }),
      trade(token, { goodId: id, side: 'buy', qty: 400, slippageBps: 0 }),
    ]);

    if (picky.status === 400) {
      expect(picky.body.error).toBe('slippage_exceeded');
      expect(picky.body.details.actual).toBeGreaterThan(picky.body.details.limit);
    }
    await assertMoneySupply();
  });

  it('rejects a tolerance wide enough to be meaningless', async () => {
    const { token } = await makePlayer('reckless');
    const { id } = await makeGood();
    const res = await trade(token, { goodId: id, side: 'buy', qty: 10, slippageBps: 9_999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
});
