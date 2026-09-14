import { RunAction } from '../models/Run.js';
import { getRedis } from '../redis/client.js';
import { runState, runCargo } from '../redis/runKeys.js';
import { log } from '../log.js';
import { hash32, GOOD_BY_ID, GOODS, priceFor } from '@tgc/shared';

/**
 * Things that happen on the road.
 *
 * The old game had no jeopardy at all - nothing could go wrong, so
 * nothing was at stake and no decision carried weight. These are the
 * fix. They fire on arrival, so the consequence and the new prices land
 * together.
 *
 * Deterministic from the run's seed and the day, like prices, so a
 * replay reproduces the same misfortunes and a score stays verifiable.
 *
 * The mix is deliberately tilted toward the bad. A run where the road is
 * mostly kind is a run where the cart may as well not have a limit.
 */

const EVENTS = [
  {
    id: 'bandits',
    weight: 11,
    when: (s) => s.carried > 0,
    apply: ({ state, random }) => {
      // They take a share of the single largest holding - the thing you
      // were most pleased about.
      //
      // Softened from a fifth-to-half after a playtest lost cargo four
      // times in twelve days. Repeated large losses stop reading as
      // jeopardy and start reading as the game cheating.
      const [good, qty] = Object.entries(state.cargo).sort((a, b) => b[1] - a[1])[0];
      const taken = Math.max(1, Math.round(qty * (0.12 + random * 0.18)));
      return {
        text: `Bandits on the road. They take ${taken} ${GOOD_BY_ID[good]?.name ?? good}.`,
        cargo: { [good]: -taken },
      };
    },
  },
  {
    id: 'toll',
    weight: 12,
    apply: ({ state, random }) => {
      const toll = Math.max(40, Math.round(state.cash * (0.04 + random * 0.07)));
      return { text: `A bridge toll nobody warned you about. ${toll} Notes.`, cash: -toll };
    },
  },
  {
    id: 'axle',
    weight: 8,
    apply: ({ state, random }) => {
      const bill = Math.max(60, Math.round(state.cash * (0.06 + random * 0.09)));
      return {
        text: `The axle splits. A wheelwright puts it right for ${bill} Notes.`,
        cash: -bill,
      };
    },
  },
  {
    id: 'spoiled',
    weight: 9,
    when: (s) => s.carried > 0,
    apply: ({ state, random }) => {
      const [good, qty] =
        Object.entries(state.cargo)[Math.floor(random * Object.keys(state.cargo).length)] ?? [];
      if (!good) return null;
      const lost = Math.max(1, Math.round(qty * 0.15));
      return {
        text: `Rain gets into the cart. ${lost} ${GOOD_BY_ID[good]?.name ?? good} ruined.`,
        cargo: { [good]: -lost },
      };
    },
  },
  {
    id: 'windfall',
    weight: 7,
    apply: ({ random }) => {
      const found = Math.round(120 + random * 600);
      return { text: `A purse in the ditch, and nobody about. ${found} Notes.`, cash: found };
    },
  },
  {
    id: 'abandoned',
    weight: 8,
    apply: ({ state, random }) => {
      const good = GOODS[Math.floor(random * GOODS.length)];
      const free = Math.max(2, Math.round((state.capacity - state.carried) * 0.25));
      if (free < 2) return null;
      return {
        text: `An abandoned cart by the roadside. You take ${free} ${good.name}.`,
        cargo: { [good.id]: free },
      };
    },
  },
  {
    id: 'rumour',
    weight: 11,
    apply: ({ state, random }) => {
      // A real look at tomorrow, somewhere. The only information the
      // game ever gives away for free, and it is worth acting on.
      const good = GOODS[Math.floor(random * GOODS.length)];
      const { price } = priceFor(state.seed, state.day + 1, state.town, good.id);
      return {
        text: `A carter says ${good.name} will fetch about ${price.toLocaleString()} here tomorrow.`,
      };
    },
  },
  {
    id: 'quiet',
    weight: 30,
    apply: () => ({ text: 'The road is quiet.' }),
  },
];

export async function rollEvent({ runId, state, userId }) {
  if (!state) return null;

  const carried = Object.values(state.cargo).reduce((a, b) => a + b, 0);
  const context = { ...state, carried };

  const pickRoll = hash32(`${state.seed}|${state.day}|${state.town}|event`);
  const detailRoll = hash32(`${state.seed}|${state.day}|${state.town}|detail`);

  const eligible = EVENTS.filter((e) => !e.when || e.when(context));
  const total = eligible.reduce((sum, e) => sum + e.weight, 0);

  let cursor = pickRoll * total;
  let chosen = eligible[eligible.length - 1];
  for (const e of eligible) {
    cursor -= e.weight;
    if (cursor <= 0) {
      chosen = e;
      break;
    }
  }

  const outcome = chosen.apply({ state: context, random: detailRoll });
  if (!outcome) return null;

  const redis = getRedis();
  const tx = redis.multi();

  if (outcome.cash) {
    // Floored at zero. An event may leave a player broke; it may not
    // leave them owing the road money on top of the creditor.
    const next = Math.max(0, state.cash + outcome.cash);
    tx.hset(runState(runId), 'cash', next);
  }
  for (const [good, delta] of Object.entries(outcome.cargo ?? {})) {
    tx.hincrby(runCargo(runId), good, delta);
  }
  await tx.exec();

  // Clean up anything an event drove to zero or below.
  const after = await redis.hgetall(runCargo(runId));
  const clear = Object.entries(after).filter(([, v]) => Number(v) <= 0);
  if (clear.length > 0) await redis.hdel(runCargo(runId), ...clear.map(([k]) => k));

  const cash = Number(await redis.hget(runState(runId), 'cash'));

  await RunAction.create({
    runId,
    seq: state.seq + 1,
    day: state.day,
    town: state.town,
    type: 'event',
    amount: outcome.cash ?? 0,
    cashAfter: cash,
    debtAfter: state.debt,
    note: chosen.id,
  });
  await redis.hincrby(runState(runId), 'seq', 1);

  log.debug('road event', { runId, userId, event: chosen.id });

  return {
    id: chosen.id,
    text: outcome.text,
    cash: outcome.cash ?? 0,
    cargo: outcome.cargo ?? null,
  };
}
