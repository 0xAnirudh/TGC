import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import { ECON_GRANTED, userCash } from '../../packages/api/src/redis/keys.js';
import { revalueAll, rankOf } from '../../packages/api/src/services/leaderboard.js';
import { bonusFor, BASE_BONUS, MAX_BONUS } from '../../packages/api/src/services/bonus.js';
import { User } from '../../packages/api/src/models/User.js';
import { STARTING_GRANT } from '@tgc/shared';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply, makePlayerDirect } from '../helpers/market.js';

const app = createApp();

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

const trade = (token, body) =>
  request(app).post('/trades').set('Authorization', `Bearer ${token}`).send(body);

describe('GET /leaderboard', () => {
  it('ranks players by net worth', async () => {
    const rich = await makePlayerDirect('rich_one');
    const poor = await makePlayerDirect('poor_one');
    // Give one of them a clear edge.
    await getRedis().set(userCash(rich.id), STARTING_GRANT * 3);

    await revalueAll();
    const res = await request(app).get('/leaderboard').expect(200);

    expect(res.body.entries[0].username).toBe('rich_one');
    expect(res.body.entries[1].username).toBe('poor_one');
    expect(res.body.entries[0].rank).toBe(1);
    expect(poor.id).toBeTruthy();
  });

  it('is public and needs no token', async () => {
    await makePlayerDirect('anyone');
    await revalueAll();
    await request(app).get('/leaderboard').expect(200);
  });

  it('serves from the sorted set rather than recomputing', async () => {
    // Changing a balance without revaluing must not move the board.
    // If it does, the board is being computed on read, which is the
    // thing FR-8.2 forbids.
    const a = await makePlayerDirect('steady');
    await revalueAll();

    await getRedis().set(userCash(a.id), STARTING_GRANT * 10);
    const res = await request(app).get('/leaderboard').expect(200);
    expect(res.body.entries[0].netWorth).toBe(STARTING_GRANT);
  });

  it('counts holdings at what they would actually sell for', async () => {
    const player = await makePlayerDirect('holder');
    const { id } = await makeGood({ basePrice: 20, k: 200_000, n: 1 });
    await setSupply(id, 50_000);
    await trade(player.token, { goodId: id, side: 'buy', qty: 100, slippageBps: 500 }).expect(201);

    await revalueAll();
    const user = await User.findById(player.id).lean();

    // Bought and not yet sold, so net worth must be below the starting
    // grant - the spread and the curve movement are both real costs.
    expect(user.netWorthCached).toBeLessThan(STARTING_GRANT);
    expect(user.netWorthCached).toBeGreaterThan(STARTING_GRANT * 0.9);
  });

  it('gives a player their rank', async () => {
    const a = await makePlayerDirect('first_place');
    await getRedis().set(userCash(a.id), STARTING_GRANT * 5);
    await makePlayerDirect('second_place');
    await revalueAll();

    expect(await rankOf(a.id)).toBe(1);
  });
});

describe('GET /players/:username', () => {
  it('shows a public profile', async () => {
    await makePlayerDirect('public_trader');
    await revalueAll();

    const res = await request(app).get('/players/public_trader').expect(200);
    expect(res.body.player.username).toBe('public_trader');
    expect(res.body.player.rank).toBe(1);
    expect(res.body.player.holdings).toEqual([]);
  });

  it('finds a player whatever case the name is typed in', async () => {
    await makePlayerDirect('MixedCase');
    await request(app).get('/players/mixedcase').expect(200);
  });

  it('hides holdings when the player has made them private', async () => {
    // Knowing what someone holds tells you what they are about to sell,
    // so this is a real privacy control, not decoration.
    const p = await makePlayerDirect('secretive');
    await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${p.token}`)
      .send({ portfolioPublic: false })
      .expect(200);

    const res = await request(app).get('/players/secretive').expect(200);
    expect(res.body.player.holdings).toBeUndefined();
    expect(res.body.player.netWorth).toBeDefined();
  });

  it('404s an unknown name', async () => {
    const res = await request(app).get('/players/nobody_here').expect(404);
    expect(res.body.error).toBe('player_not_found');
  });
});

describe('daily bonus', () => {
  it('scales with account age and stops at the cap', () => {
    expect(bonusFor(0)).toBe(BASE_BONUS);
    expect(bonusFor(7)).toBe(BASE_BONUS + 500);
    expect(bonusFor(9999)).toBe(MAX_BONUS);
  });

  it('pays out and counts itself against the faucet total', async () => {
    // The delicate part. A bonus that pays without incrementing
    // ECON_GRANTED breaks the money supply invariant silently.
    const p = await makePlayerDirect('claimer');
    const grantedBefore = Number(await getRedis().get(ECON_GRANTED));

    const res = await request(app)
      .post('/me/bonus')
      .set('Authorization', `Bearer ${p.token}`)
      .expect(200);

    const grantedAfter = Number(await getRedis().get(ECON_GRANTED));
    expect(grantedAfter - grantedBefore).toBe(res.body.amount);
    expect(res.body.cash).toBe(STARTING_GRANT + res.body.amount);
  });

  it('refuses a second claim the same day', async () => {
    const p = await makePlayerDirect('greedy');
    await request(app).post('/me/bonus').set('Authorization', `Bearer ${p.token}`).expect(200);

    const res = await request(app)
      .post('/me/bonus')
      .set('Authorization', `Bearer ${p.token}`)
      .expect(400);
    expect(res.body.error).toBe('bonus_already_claimed');
  });

  it('pays only once when claimed concurrently', async () => {
    // Two simultaneous claims both pass the "has it been a day" check.
    // Only the conditional update can decide which one pays.
    const p = await makePlayerDirect('double_dipper');
    const grantedBefore = Number(await getRedis().get(ECON_GRANTED));

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/me/bonus').set('Authorization', `Bearer ${p.token}`),
      ),
    );

    const paid = results.filter((r) => r.status === 200);
    expect(paid).toHaveLength(1);
    const grantedAfter = Number(await getRedis().get(ECON_GRANTED));
    expect(grantedAfter - grantedBefore).toBe(paid[0].body.amount);
  });
});
