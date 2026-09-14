import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { rebuildFromLedger, snapshotState } from '../../packages/api/src/services/rebuild.js';
import { Trade } from '../../packages/api/src/models/Trade.js';
import { setupStores, resetStores, teardownStores, settleLedger } from '../helpers/stores.js';
import { makeGood, setSupply } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

async function makePlayer(username) {
  const res = await request(app)
    .post('/auth/register')
    .send({ username, password: 'correct-horse-battery' })
    .expect(201);
  return res.body.token;
}

const trade = (token, body) =>
  request(app).post('/trades').set('Authorization', `Bearer ${token}`).send(body);

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
    // The ledger is written in the background; the rebuild reads it.
    await settleLedger(20);

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
    await settleLedger(6);

    const { state } = await rebuildFromLedger({ dryRun: true });
    expect(state.supply.get(id)).toBe(600);
  });

  it('balances the money supply after rebuilding', async () => {
    const token = await makePlayer('balancer');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await trade(token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 });
    await trade(token, { goodId: id, side: 'sell', qty: 60, slippageBps: 500 });
    await settleLedger(2);
    await getRedis().flushdb();

    const { state } = await rebuildFromLedger();
    const cash = [...state.cash.values()].reduce((a, b) => a + b, 0);

    expect(cash + state.reserve + state.burned).toBe(state.granted);
  });
});
