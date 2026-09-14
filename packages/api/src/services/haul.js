import { randomBytes } from 'node:crypto';
import { Run, RunAction } from '../models/Run.js';
import { getRedis } from '../redis/client.js';
import { runState, runCargo, runFlow, activeRun } from '../redis/runKeys.js';
import { ApiError } from '../util/errors.js';
import { log } from '../log.js';
import {
  RUN_DAYS,
  OPENING_CASH,
  OPENING_DEBT,
  OPENING_CAPACITY,
  CAPACITY_STEP,
  MAX_CAPACITY,
  capacityCost,
  DEBT_RATE_BPS,
  IMPACT_SCALE,
  START_TOWN,
  TOWNS,
  TOWN_BY_ID,
  ROADS,
  GOODS,
  GOOD_BY_ID,
  boardFor,
  priceFor,
  sellReturnFor,
} from '@tgc/shared';
import { rollEvent } from './haulEvents.js';

/**
 * Running a haul.
 *
 * The live run lives in Redis and every action goes through one Lua
 * script, so a double-clicked buy cannot spend the same money twice.
 * Each action is also appended to a Mongo log, which is what lets a
 * finished run be replayed and its score recomputed rather than trusted.
 */

const REDIS_TTL_SEC = 60 * 60 * 12;

/* ---------------------------------------------------------------- *
 * Reading the run
 * ---------------------------------------------------------------- */

async function readState(runId) {
  const redis = getRedis();
  const [state, cargo] = await Promise.all([
    redis.hgetall(runState(runId)),
    redis.hgetall(runCargo(runId)),
  ]);
  if (!state || !state.day) return null;

  return {
    id: runId,
    day: Number(state.day),
    cash: Number(state.cash),
    debt: Number(state.debt),
    capacity: Number(state.capacity),
    town: state.town,
    status: state.status,
    seq: Number(state.seq ?? 0),
    seed: state.seed,
    cargo: Object.fromEntries(
      Object.entries(cargo)
        .map(([k, v]) => [k, Number(v)])
        .filter(([, v]) => v > 0),
    ),
  };
}

/** The run as the player is allowed to see it - no seed. */
export async function viewRun(userId) {
  const redis = getRedis();
  const runId = await redis.get(activeRun(userId));
  if (!runId) return null;

  const state = await readState(runId);
  if (!state) {
    await redis.del(activeRun(userId));
    return null;
  }

  const carried = Object.values(state.cargo).reduce((a, b) => a + b, 0);
  const flow = await redis.hgetall(runFlow(runId));

  // Today's prices, here. Deliberately only here - not knowing what
  // the next town pays is the game.
  const board = boardFor(state.seed, state.day, state.town).map((row) => {
    const moved = Number(flow[`${state.town}:${row.id}`] ?? 0);
    return {
      ...row,
      held: state.cargo[row.id] ?? 0,
      // What the next unit actually costs after what has already been
      // moved here today, so the shown price is the price paid.
      effective: Math.max(1, Math.round(row.price * (1 + moved / IMPACT_SCALE))),
      moved,
    };
  });

  return {
    id: state.id,
    day: state.day,
    daysLeft: RUN_DAYS - state.day,
    totalDays: RUN_DAYS,
    town: state.town,
    townName: TOWN_BY_ID[state.town]?.name,
    blurb: TOWN_BY_ID[state.town]?.blurb,
    cash: state.cash,
    debt: state.debt,
    debtTomorrow: Math.ceil((state.debt * (10_000 + DEBT_RATE_BPS)) / 10_000),
    capacity: state.capacity,
    carried,
    cargo: state.cargo,
    board,
    roads: ROADS[state.town] ?? [],
    towns: TOWNS.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, x: t.x, y: t.y })),
    upgrade:
      state.capacity >= MAX_CAPACITY
        ? null
        : { step: CAPACITY_STEP, cost: capacityCost(state.capacity) },
    status: state.status,
  };
}

/* ---------------------------------------------------------------- *
 * Starting and ending
 * ---------------------------------------------------------------- */

export async function startRun(userId) {
  const redis = getRedis();

  const existing = await redis.get(activeRun(userId));
  if (existing && (await readState(existing))) {
    throw ApiError.badRequest('run_in_progress', 'You already have a haul underway');
  }

  // Abandon anything left half-finished in Mongo, so the one-active-run
  // rule holds even if Redis was flushed underneath a live run.
  await Run.updateMany({ userId, status: 'active' }, { $set: { status: 'abandoned' } });

  const seed = randomBytes(8).toString('hex');
  const run = await Run.create({
    userId,
    seed,
    day: 1,
    town: START_TOWN,
    cash: OPENING_CASH,
    debt: OPENING_DEBT,
    capacity: OPENING_CAPACITY,
  });

  const id = run._id.toString();
  await redis
    .multi()
    .hset(runState(id), {
      day: 1,
      cash: OPENING_CASH,
      debt: OPENING_DEBT,
      capacity: OPENING_CAPACITY,
      town: START_TOWN,
      status: 'active',
      seq: 0,
      seed,
      userId,
    })
    .del(runCargo(id), runFlow(id))
    .set(activeRun(userId), id)
    .expire(runState(id), REDIS_TTL_SEC)
    .expire(activeRun(userId), REDIS_TTL_SEC)
    .exec();

  log.info('haul started', { userId, runId: id });
  return viewRun(userId);
}

/**
 * End the run.
 *
 * The cart is liquidated at today's prices wherever the player happens
 * to be standing, then the debt is taken out of what is left. Being
 * caught at the frontier holding luxuries nobody there wants is a real
 * way to lose, which is why the last day matters.
 */
export async function endRun(userId, { abandoned = false } = {}) {
  const redis = getRedis();
  const runId = await redis.get(activeRun(userId));
  if (!runId) throw ApiError.notFound('no_run', 'No haul underway');

  const state = await readState(runId);
  if (!state) throw ApiError.notFound('no_run', 'No haul underway');

  let cash = state.cash;
  const sold = [];

  for (const [goodId, qty] of Object.entries(state.cargo)) {
    if (qty <= 0) continue;
    const { price } = priceFor(state.seed, state.day, state.town, goodId);
    const proceeds = sellReturnFor(price, 0, qty);
    cash += proceeds;
    sold.push({ good: GOOD_BY_ID[goodId]?.name ?? goodId, qty, proceeds });
  }

  const debt = state.debt;
  const score = cash - debt;
  const ruined = score < 0;

  await Run.updateOne(
    { _id: runId },
    {
      $set: {
        day: state.day,
        town: state.town,
        cash,
        debt,
        cargo: {},
        status: abandoned ? 'abandoned' : 'finished',
        // A run that ends in the red scores zero rather than a negative
        // number. The board is a list of hauls, not of disasters.
        score: abandoned ? null : Math.max(0, score),
        ruined,
        finishedAt: new Date(),
        seq: state.seq,
      },
    },
  );

  await redis.del(runState(runId), runCargo(runId), runFlow(runId), activeRun(userId));
  log.info('haul ended', { userId, runId, score, ruined, abandoned });

  return {
    runId,
    days: state.day,
    liquidated: sold,
    cashBefore: state.cash,
    cashAfter: cash,
    debt,
    score: Math.max(0, score),
    ruined,
    abandoned,
  };
}

/* ---------------------------------------------------------------- *
 * Doing things
 * ---------------------------------------------------------------- */

const ERRORS = {
  no_run: () => ApiError.notFound('no_run', 'No haul underway'),
  run_over: () => ApiError.badRequest('run_over', 'This haul has ended'),
  bad_qty: () => ApiError.badRequest('bad_qty', 'That is not a quantity'),
  no_room: (free) =>
    ApiError.badRequest('no_room', `Only ${free} units of room left in the cart`, {
      free: Number(free),
    }),
  too_dear: (need, have) =>
    ApiError.badRequest('too_dear', 'Not enough Notes', { need: Number(need), have: Number(have) }),
  not_carried: (have) =>
    ApiError.badRequest('not_carried', `You are only carrying ${have}`, { have: Number(have) }),
  nothing_to_repay: () => ApiError.badRequest('nothing_to_repay', 'Nothing to repay'),
  unknown_action: () => ApiError.badRequest('unknown_action', 'No such action'),
};

async function apply(userId, { action, target, amount = 0 }) {
  const redis = getRedis();
  const runId = await redis.get(activeRun(userId));
  if (!runId) throw ERRORS.no_run();

  const state = await readState(runId);
  if (!state) throw ERRORS.no_run();

  // The price the script will use, computed here from the seed. The
  // client never supplies it and cannot influence it.
  let unitPrice = 0;
  if (action === 'buy' || action === 'sell') {
    if (!GOOD_BY_ID[target]) throw ApiError.badRequest('no_such_good', 'No such good');
    unitPrice = priceFor(state.seed, state.day, state.town, target).price;
  }

  if (action === 'travel') {
    const connected = ROADS[state.town] ?? [];
    if (!connected.includes(target)) {
      throw ApiError.badRequest('no_road', 'No road runs there from here', { from: state.town });
    }
  }

  const upgradeCost = action === 'upgrade' ? capacityCost(state.capacity) : 0;
  if (action === 'upgrade' && state.capacity >= MAX_CAPACITY) {
    throw ApiError.badRequest('cart_maxed', 'The cart is as big as it gets');
  }

  const result = await redis.haul(
    runState(runId),
    runCargo(runId),
    runFlow(runId),
    action,
    target ?? '',
    amount,
    unitPrice,
    IMPACT_SCALE,
    CAPACITY_STEP,
    DEBT_RATE_BPS,
    RUN_DAYS,
    upgradeCost,
  );

  const [status, ...rest] = result;
  if (status === 'error') {
    const [code, ...details] = rest;
    const build = ERRORS[code];
    throw build ? build(...details) : ApiError.badRequest(code, 'Refused');
  }

  const [day, cash, debt, capacity, town, moved] = rest.map((v, i) => (i === 4 ? v : Number(v)));

  // Append to the log. Not awaited by the caller's critical path, but
  // awaited here so an action and its record cannot reorder.
  await RunAction.create({
    runId,
    seq: state.seq + 1,
    day: state.day,
    town: state.town,
    type: action,
    good: action === 'buy' || action === 'sell' ? target : null,
    qty: action === 'buy' || action === 'sell' ? amount : 0,
    amount: action === 'sell' ? moved : -moved,
    cashAfter: cash,
    debtAfter: debt,
    note: action === 'travel' ? target : null,
  });

  await redis.expire(runState(runId), REDIS_TTL_SEC);

  return { day, cash, debt, capacity, town, moved };
}

export const buy = (userId, good, qty) =>
  apply(userId, { action: 'buy', target: good, amount: qty });
export const sell = (userId, good, qty) =>
  apply(userId, { action: 'sell', target: good, amount: qty });
export const repay = (userId, amount) => apply(userId, { action: 'repay', amount });
export const upgrade = (userId) => apply(userId, { action: 'upgrade' });

/**
 * Travel, which is also where things go wrong.
 *
 * The day advances, the debt grows, and the road gets a chance to take
 * something. Events fire on arrival rather than departure so the player
 * sees the consequence and the new prices together.
 */
export async function travel(userId, to) {
  const moved = await apply(userId, { action: 'travel', target: to });

  const redis = getRedis();
  const runId = await redis.get(activeRun(userId));
  const state = await readState(runId);

  const event = await rollEvent({ runId, state, userId });
  return { ...moved, event };
}

export { GOODS, TOWNS };
