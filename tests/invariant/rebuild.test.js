import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { STREAM_TRADES } from '../../packages/api/src/redis/keys.js';
import { rebuildFromLedger, snapshotState } from '../../packages/api/src/services/rebuild.js';
import { runOnce, GROUP } from '../../packages/relay/src/index.js';
import { Trade } from '../../packages/api/src/models/Trade.js';
import { User } from '../../packages/api/src/models/User.js';
import { Market } from '../../packages/api/src/models/Market.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(async () => {
  await resetStores();
  // resetStores flushes the stream too, so the group has to be recreated.
  await getRedis()
    .xgroup('CREATE', STREAM_TRADES, GROUP, '0', 'MKSTREAM')
    .catch(() => {});
});

async function makePlayer(username) {
  const res = await request(app)
    .post('/auth/register')
    .send({ username, password: 'correct-horse-battery' })
    .expect(201);
  return res.body.token;
}

const trade = (token, body) =>
  request(app).post('/trades').set('Authorization', `Bearer ${token}`).send(body);

/** Run the relay until the stream is drained. */
async function drainRelay() {
  for (let i = 0; i < 40; i += 1) {
    if ((await runOnce()) === 0) break;
  }
}

describe('the stream is the ledger', () => {
  it('appends a trade to the stream atomically with the trade itself', async () => {
    const token = await makePlayer('streamer');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    const res = await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);

    const entries = await getRedis().xrange(STREAM_TRADES, '-', '+');
    expect(entries).toHaveLength(1);
    // The id the API returned is the stream entry id. They are the same
    // thing, which is what makes the projection idempotent.
    expect(entries[0][0]).toBe(res.body.trade.id);
  });

  it('writes nothing to mongo until the relay runs', async () => {
    // The API no longer writes the ledger. If this ever fails, the dual
    // write has crept back in.
    const token = await makePlayer('nowriter');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);
    expect(await Trade.countDocuments()).toBe(0);

    await drainRelay();
    expect(await Trade.countDocuments()).toBe(1);
  });

  it('projects a redelivered entry without double-counting it', async () => {
    // At-least-once delivery is the contract. Projecting twice must be
    // indistinguishable from projecting once.
    const token = await makePlayer('dupe');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100 }).expect(201);
    await drainRelay();

    const after = await Trade.findOne().lean();
    const redis = getRedis();

    // Force a redelivery by resetting the group's cursor to the start.
    await redis.xgroup('SETID', STREAM_TRADES, GROUP, '0');
    await drainRelay();

    expect(await Trade.countDocuments()).toBe(1);
    const again = await Trade.findOne().lean();
    expect(again.notional).toBe(after.notional);
    expect(again.quantity).toBe(after.quantity);

    // The counters are the part a naive upsert gets wrong: the ledger
    // row is deduplicated by its unique index, but an unguarded $inc
    // fires again on every redelivery.
    const user = await User.findOne({ usernameLower: 'dupe' }).lean();
    expect(user.tradeCount).toBe(1);
    const market = await Market.findOne({ goodId: id }).lean();
    expect(market.vol24h).toBe(100);
  });
});

describe('rebuild from the ledger', () => {
  it('reproduces live state exactly after a full flush', async () => {
    // The strongest claim in the project: snapshot everything, destroy
    // Redis, replay the ledger, and land on byte-identical state.
    const alice = await makePlayer('alice');
    const bob = await makePlayer('bob');

    // Both goods start at zero supply and are traded up from there.
    //
    // That is not incidental to the test - it is the test. The rebuild
    // derives supply from the trades alone, so any supply that no trade
    // created is, correctly, not reconstructable. An earlier version of
    // this test injected 60,000 units straight into Redis and then
    // complained that the rebuild produced 260; the rebuild was right
    // and the test was cheating. See FINDING-007.
    const iron = await makeGood({ name: 'Iron', basePrice: 20, k: 200_000, n: 1, supply: 0 });
    const silk = await makeGood({ name: 'Silk', basePrice: 35, k: 120_000, n: 2, supply: 0 });

    for (let i = 0; i < 7; i += 1) {
      await trade(alice, { goodId: iron.id, side: 'buy', qty: 100, slippageBps: 2_000 });
      await trade(bob, { goodId: silk.id, side: 'buy', qty: 100, slippageBps: 2_000 });
      if (i % 3 === 0) {
        await trade(alice, { goodId: iron.id, side: 'sell', qty: 40, slippageBps: 2_000 });
        await trade(bob, { goodId: silk.id, side: 'sell', qty: 30, slippageBps: 2_000 });
      }
    }
    await drainRelay();

    const before = await snapshotState();
    const tradeCount = await Trade.countDocuments();
    expect(tradeCount).toBeGreaterThan(15);

    // Destroy every bit of live state.
    await getRedis().flushdb();

    const { summary } = await rebuildFromLedger();
    expect(summary.trades).toBe(tradeCount);

    const after = await snapshotState();
    expect(after).toEqual(before);
  });

  it('reconstructs supply without trusting the cached copy in mongo', async () => {
    // Mongo's Market.supply is a convenience field. The claim is that
    // supply is derivable from the trades alone, so the rebuild starts
    // every good at zero and must still arrive at the right number.
    const token = await makePlayer('deriver');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1, supply: 0 });

    for (let i = 0; i < 6; i += 1) {
      await trade(token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 });
    }
    await drainRelay();

    const { state } = await rebuildFromLedger({ dryRun: true });
    expect(state.supply.get(id)).toBe(600);
  });

  it('balances the money supply after rebuilding', async () => {
    const token = await makePlayer('balancer');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 });
    await trade(token, { goodId: id, side: 'sell', qty: 60, slippageBps: 500 });
    await drainRelay();
    await getRedis().flushdb();

    const { state } = await rebuildFromLedger();
    const cash = [...state.cash.values()].reduce((a, b) => a + b, 0);

    expect(cash + state.reserve + state.burned).toBe(state.granted);
  });
});
