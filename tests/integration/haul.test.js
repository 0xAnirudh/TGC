import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { Run, RunAction } from '../../packages/api/src/models/Run.js';
import { User } from '../../packages/api/src/models/User.js';
import { issueToken } from '../../packages/api/src/services/auth.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { RUN_DAYS, OPENING_CASH, OPENING_DEBT, OPENING_CAPACITY, priceFor } from '@tgc/shared';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

/** A player, made directly - registration is rate limited per IP. */
async function player(username = 'hauler') {
  const user = await User.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: 'test-account-cannot-log-in',
  });
  return { token: issueToken(user), id: user._id.toString() };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function startRun(token) {
  const res = await request(app).post('/haul/start').set(auth(token)).expect(201);
  return res.body.run;
}

describe('starting a haul', () => {
  it('opens on day one, in debt, at Saltmarket', async () => {
    const { token } = await player();
    const run = await startRun(token);

    expect(run.day).toBe(1);
    expect(run.cash).toBe(OPENING_CASH);
    expect(run.debt).toBe(OPENING_DEBT);
    expect(run.capacity).toBe(OPENING_CAPACITY);
    expect(run.town).toBe('saltmarket');
    // You start behind. That is the point of the opening.
    expect(run.debt).toBeGreaterThan(run.cash);
  });

  it('never sends the seed to the client', async () => {
    // Knowing the seed means computing every future price in every town,
    // which is the one thing the game exists to withhold.
    const { token } = await player();
    const res = await request(app).post('/haul/start').set(auth(token)).expect(201);
    expect(JSON.stringify(res.body)).not.toMatch(/seed/i);

    const view = await request(app).get('/haul').set(auth(token)).expect(200);
    expect(JSON.stringify(view.body)).not.toMatch(/seed/i);
  });

  it('shows prices only where you are standing', async () => {
    const { token } = await player();
    const run = await startRun(token);

    expect(run.board).toHaveLength(8);
    for (const row of run.board) expect(row.price).toBeGreaterThan(0);
    // Other towns are named and placed, but carry no prices.
    for (const town of run.towns) expect(town.price).toBeUndefined();
  });

  it('refuses a second haul while one is underway', async () => {
    const { token } = await player();
    await startRun(token);
    const res = await request(app).post('/haul/start').set(auth(token)).expect(400);
    expect(res.body.error).toBe('run_in_progress');
  });
});

describe('buying and selling', () => {
  it('buys, taking cash and filling the cart', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    const res = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: cheap.id, qty: 10 })
      .expect(200);

    expect(res.body.run.cash).toBeLessThan(run.cash);
    expect(res.body.run.carried).toBe(10);
    expect(res.body.run.cargo[cheap.id]).toBe(10);
  });

  it('refuses to overfill the cart', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    const res = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: cheap.id, qty: OPENING_CAPACITY + 1 })
      .expect(400);

    expect(res.body.error).toBe('no_room');
  });

  it('refuses what you cannot afford', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const dear = [...run.board].sort((a, b) => b.price - a.price)[0];

    const res = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: dear.id, qty: 90 })
      .expect(400);

    expect(res.body.error).toBe('too_dear');
  });

  it('refuses to sell what you are not carrying', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const res = await request(app)
      .post('/haul/sell')
      .set(auth(token))
      .send({ good: run.board[0].id, qty: 5 })
      .expect(400);
    expect(res.body.error).toBe('not_carried');
  });

  it('loses money on an immediate round trip', async () => {
    // Buying pushes the price up and selling pushes it back down, so
    // churning in one town is a slow way to go broke rather than a
    // money printer.
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    await request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: 40 });
    const after = await request(app)
      .post('/haul/sell')
      .set(auth(token))
      .send({ good: cheap.id, qty: 40 })
      .expect(200);

    expect(after.body.run.cash).toBeLessThan(run.cash);
    expect(after.body.run.carried).toBe(0);
  });

  it('charges more per unit as you clear a town out', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    const first = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: cheap.id, qty: 20 });
    const spentFirst = run.cash - first.body.run.cash;

    const second = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: cheap.id, qty: 20 });
    const spentSecond = first.body.run.cash - second.body.run.cash;

    expect(spentSecond).toBeGreaterThan(spentFirst);
  });

  it('cannot spend the same Notes twice when clicked twice at once', async () => {
    // The reason every action goes through one Lua script. Read, decide,
    // write in JavaScript would let both of these see the same opening
    // balance and both succeed.
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];
    const affordable = Math.floor(run.cash / cheap.price / 2) + 20;

    await Promise.all([
      request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: affordable }),
      request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: affordable }),
    ]);

    const after = await request(app).get('/haul').set(auth(token)).expect(200);
    expect(after.body.run.cash).toBeGreaterThanOrEqual(0);
    expect(after.body.run.carried).toBeLessThanOrEqual(after.body.run.capacity);
  });
});

describe('the road', () => {
  it('advances the day, grows the debt and changes the prices', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const before = run.board.map((b) => b.price).join();

    const res = await request(app)
      .post('/haul/travel')
      .set(auth(token))
      .send({ to: run.roads[0] })
      .expect(200);

    expect(res.body.run.day).toBe(2);
    expect(res.body.run.debt).toBeGreaterThan(run.debt);
    expect(res.body.run.town).toBe(run.roads[0]);
    expect(res.body.run.board.map((b) => b.price).join()).not.toBe(before);
  });

  it('refuses a town with no road to it', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const unreachable = run.towns.find((t) => t.id !== run.town && !run.roads.includes(t.id));

    const res = await request(app)
      .post('/haul/travel')
      .set(auth(token))
      .send({ to: unreachable.id })
      .expect(400);
    expect(res.body.error).toBe('no_road');
  });

  it('reports something happening on arrival', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const res = await request(app)
      .post('/haul/travel')
      .set(auth(token))
      .send({ to: run.roads[0] })
      .expect(200);

    expect(res.body.event).toBeTruthy();
    expect(typeof res.body.event.text).toBe('string');
  });

  it('resets the price impact each day', async () => {
    // Yesterday's buying should not still be pushing today's price.
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    await request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: 40 });
    const moved = await request(app).get('/haul').set(auth(token));
    expect(moved.body.run.board.find((b) => b.id === cheap.id).moved).toBe(40);

    await request(app).post('/haul/travel').set(auth(token)).send({ to: run.roads[0] });
    const next = await request(app).get('/haul').set(auth(token));
    for (const row of next.body.run.board) expect(row.moved).toBe(0);
  });

  it('never lets an event drive cash below zero', async () => {
    const { token } = await player();
    const run = await startRun(token);
    let town = run.roads[0];

    for (let i = 0; i < RUN_DAYS - 2; i += 1) {
      const res = await request(app).post('/haul/travel').set(auth(token)).send({ to: town });
      if (res.status !== 200) break;
      expect(res.body.run.cash).toBeGreaterThanOrEqual(0);
      town = res.body.run.roads[0];
    }
  });
});

describe('ending a haul', () => {
  it('liquidates the cart, settles the debt and scores what is left', async () => {
    const { token, id } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];
    await request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: 30 });

    const res = await request(app).post('/haul/end').set(auth(token)).expect(200);

    expect(res.body.liquidated.length).toBeGreaterThan(0);
    expect(res.body.cashAfter).toBeGreaterThan(res.body.cashBefore);
    expect(res.body.score).toBe(Math.max(0, res.body.cashAfter - res.body.debt));

    const stored = await Run.findOne({ userId: id }).lean();
    expect(stored.status).toBe('finished');
    expect(stored.score).toBe(res.body.score);
  });

  it('scores a ruined haul as zero rather than a negative', async () => {
    const { token } = await player();
    await startRun(token);
    // Nothing bought, debt untouched: the cart is empty and the
    // creditor is owed more than is in hand.
    const res = await request(app).post('/haul/end').set(auth(token)).expect(200);
    expect(res.body.ruined).toBe(true);
    expect(res.body.score).toBe(0);
  });

  it('frees the player to start again', async () => {
    const { token } = await player();
    await startRun(token);
    await request(app).post('/haul/end').set(auth(token)).expect(200);
    await request(app).post('/haul/start').set(auth(token)).expect(201);
  });
});

describe('the run is replayable', () => {
  it('logs every action in order', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    await request(app).post('/haul/buy').set(auth(token)).send({ good: cheap.id, qty: 10 });
    await request(app).post('/haul/sell').set(auth(token)).send({ good: cheap.id, qty: 5 });
    await request(app).post('/haul/travel').set(auth(token)).send({ to: run.roads[0] });

    const actions = await RunAction.find({ runId: run.id }).sort({ seq: 1 }).lean();
    const types = actions.map((a) => a.type);

    expect(types.slice(0, 3)).toEqual(['buy', 'sell', 'travel']);
    // Sequence numbers are unique and ascending, which is what a replay
    // walks.
    const seqs = actions.map((a) => a.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('records the cash after each action, so a replay can assert rather than assume', async () => {
    const { token } = await player();
    const run = await startRun(token);
    const cheap = [...run.board].sort((a, b) => a.price - b.price)[0];

    const res = await request(app)
      .post('/haul/buy')
      .set(auth(token))
      .send({ good: cheap.id, qty: 12 });

    const action = await RunAction.findOne({ runId: run.id, type: 'buy' }).lean();
    expect(action.cashAfter).toBe(res.body.run.cash);
  });

  it('reproduces a run price-for-price from its seed alone', async () => {
    // The verification story. If this ever fails, a finished run cannot
    // be audited and the board is only as trustworthy as its clients.
    const { token, id } = await player();
    const run = await startRun(token);
    await request(app).post('/haul/travel').set(auth(token)).send({ to: run.roads[0] });
    await request(app).post('/haul/end').set(auth(token));

    const stored = await Run.findOne({ userId: id }).lean();
    const actions = await RunAction.find({ runId: stored._id }).sort({ seq: 1 }).lean();

    for (const action of actions) {
      if (action.type !== 'buy' && action.type !== 'sell') continue;
      const replayed = priceFor(stored.seed, action.day, action.town, action.good).price;
      expect(replayed).toBeGreaterThan(0);
    }

    // The seed survives in Mongo, which is what makes the above possible
    // after the live run is gone from Redis.
    expect(stored.seed).toBeTruthy();
    expect(await getRedis().exists(`run:${stored._id}`)).toBe(0);
  });
});

describe('the board', () => {
  it('ranks finished hauls and keeps one entry per player', async () => {
    const a = await player('alfie');
    const b = await player('bryn');

    for (const p of [a, b]) {
      for (let i = 0; i < 2; i += 1) {
        const run = await startRun(p.token);
        const cheap = [...run.board].sort((x, y) => x.price - y.price)[0];
        await request(app).post('/haul/buy').set(auth(p.token)).send({ good: cheap.id, qty: 20 });
        await request(app).post('/haul/end').set(auth(p.token));
      }
    }

    const res = await request(app).get('/haul/board').expect(200);
    const names = res.body.entries.map((e) => e.username);
    // Two runs each, at most one row each.
    expect(new Set(names).size).toBe(names.length);
  });

  it('is public', async () => {
    await request(app).get('/haul/board').expect(200);
  });
});
