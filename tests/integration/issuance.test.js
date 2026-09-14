import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import {
  STREAM_TRADES,
  ECON_BURNED,
  ECON_GRANTED,
  userCash,
  goodSupply,
} from '../../packages/api/src/redis/keys.js';
import { ISSUE_FEE, GATE } from '../../packages/api/src/services/issuance.js';
import { generateNewspaper, dateKey } from '../../packages/api/src/services/newspaper.js';
import { driftTick } from '../../packages/api/src/services/drift.js';
import { User } from '../../packages/api/src/models/User.js';
import { Good } from '../../packages/api/src/models/Good.js';
import { runOnce } from '../../packages/relay/src/index.js';
import { STARTING_GRANT } from '@tgc/shared';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply, makePlayerDirect } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(async () => {
  await resetStores();
  await getRedis()
    .xgroup('CREATE', STREAM_TRADES, 'relay', '0', 'MKSTREAM')
    .catch(() => {});
});

/** A player who satisfies every issuance gate. */
async function makeQualifiedIssuer(username = 'issuer_one') {
  const p = await makePlayerDirect(username);
  // Written through the raw driver rather than Mongoose.
  //
  // With `timestamps: true`, Mongoose marks createdAt immutable and
  // silently drops a $set on it - no error, the field simply does not
  // change. The account-age gate then never passes and every issuance
  // test returns 403 for a reason nothing reports.
  await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(p.id) },
    {
      $set: {
        netWorthCached: GATE.minNetWorth + 50_000,
        tradeCount: GATE.minTradeCount + 5,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    },
  );
  // Topping up cash must also count against the faucet total, or the
  // money supply invariant is broken by the test setup rather than by
  // the code under test. Notes cannot appear from nowhere here either.
  await getRedis()
    .multi()
    .incrby(userCash(p.id), STARTING_GRANT)
    .incrby(ECON_GRANTED, STARTING_GRANT)
    .exec();
  return p;
}

const issueBody = (over = {}) => ({
  name: 'Quartz',
  colorToken: 'violet',
  k: 10_000,
  n: 2,
  basePrice: 100,
  ...over,
});

describe('POST /issue', () => {
  it('creates a good and burns the fee', async () => {
    const p = await makeQualifiedIssuer();
    const burnedBefore = Number((await getRedis().get(ECON_BURNED)) ?? 0);

    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody())
      .expect(201);

    expect(res.body.good.name).toBe('Quartz');
    expect(res.body.feeBurned).toBe(ISSUE_FEE);
    expect(res.body.cash).toBe(STARTING_GRANT * 2 - ISSUE_FEE);

    const burnedAfter = Number(await getRedis().get(ECON_BURNED));
    expect(burnedAfter - burnedBefore).toBe(ISSUE_FEE);
  });

  it('starts the good at zero supply with no allocation to the issuer', async () => {
    // Two reasons, and both matter. Economically a free allocation is a
    // mint handed to one player. Structurally, supply no trade created
    // is not reconstructable - the rebuild would erase it (FINDING-007).
    const p = await makeQualifiedIssuer();
    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody())
      .expect(201);

    const id = res.body.good.id;
    expect(await getRedis().get(goodSupply(id))).toBe('0');
    expect(await getRedis().hget(`user:${p.id}:holdings`, id)).toBeNull();
  });

  it('keeps the money supply balanced with the fee as a sink', async () => {
    const p = await makeQualifiedIssuer();
    await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody())
      .expect(201);

    const redis = getRedis();
    const [granted, burned] = await redis.mget(ECON_GRANTED, ECON_BURNED);
    const users = await User.find().lean();
    const cashValues = await redis.mget(...users.map((u) => userCash(u._id.toString())));
    const cash = cashValues.reduce((sum, v) => sum + Number(v ?? 0), 0);

    expect(cash + Number(burned ?? 0)).toBe(Number(granted));
  });

  it('makes the new good immediately tradeable by anyone', async () => {
    const issuer = await makeQualifiedIssuer();
    const buyer = await makePlayerDirect('early_buyer');

    const created = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${issuer.token}`)
      .send(issueBody())
      .expect(201);

    await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ goodId: created.body.good.id, side: 'buy', qty: 100, slippageBps: 1_000 })
      .expect(201);
  });

  it('refuses a player who has not met the gate', async () => {
    const p = await makePlayerDirect('rookie');
    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody())
      .expect(403);
    expect(res.body.error).toBe('issuance_gate');
  });

  it('tells a player exactly which requirements they fail', async () => {
    const p = await makePlayerDirect('curious');
    const res = await request(app)
      .get('/issue/requirements')
      .set('Authorization', `Bearer ${p.token}`)
      .expect(200);

    expect(res.body.eligible).toBe(false);
    expect(res.body.failures.map((f) => f.requirement)).toContain('tradeCount');
    expect(res.body.fee).toBe(ISSUE_FEE);
  });

  it('refuses a curve steeper than the allowed band', async () => {
    // n = 50 is not a market, it is a trap for whoever buys second.
    const p = await makeQualifiedIssuer();
    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody({ n: 50 }))
      .expect(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('refuses a duplicate name regardless of case', async () => {
    const p = await makeQualifiedIssuer();
    await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody({ name: 'Quartz' }))
      .expect(201);

    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody({ name: 'quartz' }))
      .expect(409);
    expect(res.body.error).toBe('good_name_taken');
  });

  it('refuses an issuer who cannot cover the fee', async () => {
    const p = await makeQualifiedIssuer('broke_issuer');
    // Drain the account. This test does not assert the invariant, so
    // burning the difference off the faucet total is unnecessary noise.
    await getRedis().set(userCash(p.id), ISSUE_FEE - 1);

    const res = await request(app)
      .post('/issue')
      .set('Authorization', `Bearer ${p.token}`)
      .send(issueBody())
      .expect(400);

    expect(res.body.error).toBe('insufficient_funds');
    expect(await Good.countDocuments()).toBe(0);
  });
});

describe('the newspaper', () => {
  it('reports a quiet day when nothing traded', async () => {
    const paper = await generateNewspaper();
    expect(paper.headlines).toHaveLength(1);
    expect(paper.headlines[0].template).toBe('quiet_day');
  });

  it('names the biggest trade of the day', async () => {
    const p = await makePlayerDirect('whale');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);

    await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ goodId: id, side: 'buy', qty: 100, slippageBps: 1_000 })
      .expect(201);
    for (let i = 0; i < 40; i += 1) if ((await runOnce()) === 0) break;

    const paper = await generateNewspaper();
    const biggest = paper.headlines.find((h) => h.template === 'biggest_trade');
    expect(biggest.params.username).toBe('whale');
    expect(biggest.text).toMatch(/whale moved 100 units/);
  });

  it('reports movers from snapshots', async () => {
    await makeGood({ name: 'Mover', basePrice: 100, k: 20_000, n: 1 });
    const p = await makePlayerDirect('mover_trader');
    const goods = await Good.find().lean();
    await setSupply(goods[0]._id.toString(), 10_000);

    // Two snapshots at different prices give the movement something to
    // compare. Drift with a pinned random makes the direction certain.
    await driftTick({ random: () => 0 });
    await driftTick({ random: () => 0 });

    await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ goodId: goods[0]._id.toString(), side: 'buy', qty: 100, slippageBps: 2_000 })
      .expect(201);
    for (let i = 0; i < 40; i += 1) if ((await runOnce()) === 0) break;

    const paper = await generateNewspaper();
    expect(paper.headlines.some((h) => h.template === 'top_loser')).toBe(true);
  });

  it('keeps the facts alongside the sentence', async () => {
    // The paper is a record, not prose. Storing the facts separately
    // means the wording can change without reinterpreting history.
    const paper = await generateNewspaper();
    for (const h of paper.headlines) {
      expect(h).toHaveProperty('template');
      expect(h).toHaveProperty('params');
      expect(typeof h.text).toBe('string');
    }
  });

  it('replaces rather than duplicates when regenerated for a day', async () => {
    await generateNewspaper();
    await generateNewspaper();

    const res = await request(app).get('/newspaper').expect(200);
    expect(res.body.newspaper.date).toBe(dateKey());
  });

  it('404s before any edition exists', async () => {
    const res = await request(app).get('/newspaper').expect(404);
    expect(res.body.error).toBe('no_newspaper');
  });
});
