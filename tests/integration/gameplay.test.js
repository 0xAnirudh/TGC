import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/api/src/redis/client.js';
import {
  ECON_GRANTED,
  ECON_RESERVE,
  ECON_BURNED,
  userCash,
  goodSupply,
} from '../../packages/api/src/redis/keys.js';
import { ensureBots, botTick } from '../../packages/api/src/services/bots.js';
import { maybeFireEvent } from '../../packages/api/src/services/events.js';
import {
  openShort,
  closeShort,
  liquidateUnderwater,
  heldByShorts,
  COLLATERAL_RATIO,
} from '../../packages/api/src/services/shorting.js';
import { User } from '../../packages/api/src/models/User.js';
import { ShortPosition } from '../../packages/api/src/models/ShortPosition.js';
import { MarketEvent } from '../../packages/api/src/models/MarketEvent.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';
import { makeGood, setSupply, makePlayerDirect } from '../helpers/market.js';

const app = createApp();
beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

/**
 * granted == cash + reserve + burned + heldByShorts.
 *
 * Shorting adds the fourth term: proceeds and collateral are real Notes
 * that are neither in a player's cash nor in the curve's reserve while a
 * position is open. Leaving it out would make every short look like a
 * leak.
 */
async function assertMoneySupply() {
  const redis = getRedis();
  const [granted, reserve, burned] = await redis.mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);
  const users = await User.find().lean();
  const cashValues = users.length
    ? await redis.mget(...users.map((u) => userCash(u._id.toString())))
    : [];
  const cash = cashValues.reduce((s, v) => s + Number(v ?? 0), 0);
  const held = await heldByShorts();

  expect(cash + Number(reserve ?? 0) + Number(burned ?? 0) + held).toBe(Number(granted ?? 0));
}

describe('NPC traders', () => {
  it('creates a roster and counts their grants against the faucet', async () => {
    const before = Number((await getRedis().get(ECON_GRANTED)) ?? 0);
    const { total } = await ensureBots();

    expect(total).toBeGreaterThan(5);
    const after = Number(await getRedis().get(ECON_GRANTED));
    expect(after).toBeGreaterThan(before);
    await assertMoneySupply();
  });

  it('does not create the roster twice', async () => {
    const first = await ensureBots();
    const second = await ensureBots();
    expect(second.created).toBe(0);
    expect(second.total).toBe(first.total);
  });

  it('moves the market on its own', async () => {
    // The whole reason bots exist: something happens when nobody is
    // playing.
    await ensureBots();
    const { id } = await makeGood({ basePrice: 60, k: 20_000, n: 1 });
    await setSupply(id, 4_000);

    const before = Number(await getRedis().get(goodSupply(id)));
    for (let i = 0; i < 6; i += 1) await botTick();
    const after = Number(await getRedis().get(goodSupply(id)));

    expect(after).not.toBe(before);
    await assertMoneySupply();
  });

  it('trades through the same path a player does', async () => {
    // Bots are ordinary Users with no special powers - they are refused
    // for funds and size exactly as anyone else is, which is what makes
    // their activity a real exercise of the trade path.
    await ensureBots();
    const { id } = await makeGood({ basePrice: 60, k: 20_000, n: 1 });
    await setSupply(id, 4_000);
    for (let i = 0; i < 4; i += 1) await botTick();

    const bot = await User.findOne({ isBot: true }).lean();
    expect(bot.passwordHash).toBe('bot-account-no-login');

    // No password produces that hash, so nobody can log in as a bot.
    const res = await request(app)
      .post('/auth/login')
      .send({ username: bot.username, password: 'bot-account-no-login' });
    expect(res.status).toBe(401);
  });

  it('keeps a good within sane bounds over many ticks', async () => {
    // An early tuning let bots move ten percent of supply per trade and
    // a good went to twenty-three times its launch price in under a
    // minute. This is the guard against that returning.
    await ensureBots();
    const { id } = await makeGood({ basePrice: 100, k: 20_000, n: 2 });
    await setSupply(id, 5_000);
    for (let i = 0; i < 25; i += 1) await botTick();

    const supply = Number(await getRedis().get(goodSupply(id)));
    expect(supply).toBeLessThan(40_000);
    await assertMoneySupply();
  });
});

describe('market events', () => {
  it('moves a price and records a headline', async () => {
    await makeGood({ basePrice: 200, k: 10_000, n: 2 });
    const event = await maybeFireEvent({ force: true });

    expect(event).toBeTruthy();
    expect(event.headline).toMatch(/\w/);
    expect(event.priceAfter).not.toBe(event.priceBefore);
    expect(await MarketEvent.countDocuments()).toBe(1);
  });

  it('cannot mint or burn a single Note', async () => {
    // An event changes what things cost, not who owns what. That is why
    // a random shock cannot break the economy - it is structural, not
    // careful.
    const p = await makePlayerDirect('event_watcher');
    const { id } = await makeGood({ basePrice: 200, k: 10_000, n: 2 });
    await setSupply(id, 5_000);

    const before = await getRedis().mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);
    for (let i = 0; i < 5; i += 1) await maybeFireEvent({ force: true });
    const after = await getRedis().mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);

    expect(after).toEqual(before);
    expect(p.id).toBeTruthy();
    await assertMoneySupply();
  });

  it('never moves supply', async () => {
    const { id } = await makeGood({ basePrice: 200, k: 10_000, n: 2 });
    await setSupply(id, 5_000);
    for (let i = 0; i < 5; i += 1) await maybeFireEvent({ force: true });
    expect(await getRedis().get(goodSupply(id))).toBe('5000');
  });

  it('respects the same price bounds drift does', async () => {
    // A good that can 50x on one roll is a lottery, not a market.
    const { id, good } = await makeGood({ basePrice: 100, k: 10_000, n: 1 });
    await setSupply(id, 1_000);
    for (let i = 0; i < 40; i += 1) await maybeFireEvent({ force: true });

    const base = Number(await getRedis().get(`mkt:${id}:basePrice`));
    expect(base).toBeLessThanOrEqual(100 * 4);
    expect(base).toBeGreaterThanOrEqual(100 * 0.25);
    expect(good.name).toBeTruthy();
  });

  it('serves recent events over the API', async () => {
    await makeGood({ basePrice: 200, k: 10_000, n: 2 });
    await maybeFireEvent({ force: true });
    const res = await request(app).get('/events').expect(200);
    expect(res.body.events).toHaveLength(1);
  });
});

describe('short selling', () => {
  /**
   * A player plus a good to short.
   *
   * Returned under explicit names rather than spread together. Both
   * makePlayerDirect and makeGood return an `id`, so `{ ...p, ...g }`
   * silently hands you the good's id where you meant the player's - and
   * every call then fails with "account no longer exists", pointing at
   * the service rather than at the helper.
   */
  async function shorter(username = 'bear') {
    const player = await makePlayerDirect(username);
    const good = await makeGood({ basePrice: 40, k: 200_000, n: 1 });
    await setSupply(good.id, 50_000);
    return { userId: player.id, token: player.token, goodId: good.id, good: good.good };
  }

  it('opens a position, locking collateral and dropping supply', async () => {
    const s = await shorter();
    const cashBefore = Number(await getRedis().get(userCash(s.userId)));

    const res = await openShort({ userId: s.userId, goodId: s.goodId, qty: 200 });

    expect(res.position.quantity).toBe(200);
    expect(res.position.collateral).toBeGreaterThan(0);
    expect(res.supply).toBe(49_800);
    expect(Number(await getRedis().get(userCash(s.userId)))).toBe(
      cashBefore - res.position.collateral,
    );
    await assertMoneySupply();
  });

  it('pays out when the price falls', async () => {
    const s = await shorter('profitable_bear');
    const opened = await openShort({ userId: s.userId, goodId: s.goodId, qty: 300 });

    // Crash the price. The short should now be worth more than it cost.
    await getRedis().set(`mkt:${s.goodId}:basePrice`, 20);
    const closed = await closeShort({ userId: s.userId, positionId: opened.position.id });

    expect(closed.realizedPL).toBeGreaterThan(0);
    await assertMoneySupply();
  });

  it('loses money when the price rises', async () => {
    const s = await shorter('wrong_bear');
    const opened = await openShort({ userId: s.userId, goodId: s.goodId, qty: 300 });

    await getRedis().set(`mkt:${s.goodId}:basePrice`, 55);
    const closed = await closeShort({ userId: s.userId, positionId: opened.position.id });

    expect(closed.realizedPL).toBeLessThan(0);
    await assertMoneySupply();
  });

  it('never loses more than the collateral', async () => {
    // A long position can lose at most what you paid. A short has no
    // ceiling, so the collateral is the only thing bounding the loss -
    // without this, a player could walk away from a debt the economy
    // would have to absorb.
    const s = await shorter('reckless_bear');
    const opened = await openShort({ userId: s.userId, goodId: s.goodId, qty: 300 });

    // Send the price to the moon.
    await getRedis().set(`mkt:${s.goodId}:basePrice`, 160);
    const closed = await closeShort({ userId: s.userId, positionId: opened.position.id });

    expect(closed.realizedPL).toBeGreaterThanOrEqual(-opened.position.collateral);
    expect(Number(await getRedis().get(userCash(s.userId)))).toBeGreaterThanOrEqual(0);
    await assertMoneySupply();
  });

  it('force-closes a position that runs past its liquidation price', async () => {
    const s = await shorter('doomed_bear');
    const opened = await openShort({ userId: s.userId, goodId: s.goodId, qty: 300 });

    await getRedis().set(`mkt:${s.goodId}:basePrice`, 120);
    const result = await liquidateUnderwater();

    expect(result.liquidated).toBe(1);
    const after = await ShortPosition.findById(opened.position.id).lean();
    expect(after.status).toBe('liquidated');
    await assertMoneySupply();
  });

  it('leaves a healthy position alone', async () => {
    const s = await shorter('safe_bear');
    await openShort({ userId: s.userId, goodId: s.goodId, qty: 200 });

    const result = await liquidateUnderwater();
    expect(result.liquidated).toBe(0);
  });

  it('refuses a short with not enough collateral', async () => {
    const s = await shorter('poor_bear');
    await getRedis().set(userCash(s.userId), 10);

    await expect(openShort({ userId: s.userId, goodId: s.goodId, qty: 300 })).rejects.toThrow(
      /collateral/i,
    );
  });

  it('refuses to short more units than exist', async () => {
    // Supply cannot go negative - the curve has no meaning below zero.
    const s = await shorter('greedy_bear');
    await setSupply(s.goodId, 50);

    await expect(openShort({ userId: s.userId, goodId: s.goodId, qty: 100 })).rejects.toThrow();
  });

  it('holds collateral at the configured ratio', async () => {
    const s = await shorter('ratio_bear');
    const opened = await openShort({ userId: s.userId, goodId: s.goodId, qty: 200 });
    expect(opened.position.collateral).toBe(Math.ceil(opened.position.proceeds * COLLATERAL_RATIO));
  });
});
