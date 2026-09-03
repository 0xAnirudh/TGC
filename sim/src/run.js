import { Economy } from './economy.js';
import { makeRandom } from './random.js';
import { sparkline, table, notes } from './report.js';
import { buyCost, sellReturn, maxTradeQty, STARTING_GRANT } from '@tgc/shared';

/**
 * Phase 0 economy simulation.
 *
 * Runs thousands of random trades against an in-memory market and
 * asserts the economic invariants after every checkpoint. This is the
 * gate the rest of the project sits behind: if round trips can be
 * profitable, or the money supply can drift by a single Note, nothing
 * built on top of the curve can be correct either.
 *
 *   node sim/src/run.js [--trades=10000] [--seed=42] [--players=200]
 */

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const CONFIG = {
  trades: arg('trades', 10_000),
  seed: arg('seed', 42),
  players: arg('players', 200),
  checkEvery: arg('checkEvery', 250),
};

/**
 * A spread of goods: cheap and flat, mid-range, and steep and scarce.
 * The point is to exercise the curve across its parameter band rather
 * than to prove one comfortable setting works.
 */
const GOODS = [
  { id: 'iron', basePrice: 60, k: 20_000, n: 1 },
  { id: 'grain', basePrice: 45, k: 25_000, n: 1 },
  { id: 'copper', basePrice: 120, k: 12_000, n: 2 },
  { id: 'silk', basePrice: 200, k: 8_000, n: 2 },
  { id: 'amber', basePrice: 340, k: 5_000, n: 2 },
  { id: 'cobalt', basePrice: 180, k: 6_000, n: 3 },
  { id: 'ink', basePrice: 90, k: 15_000, n: 2 },
  { id: 'saffron', basePrice: 500, k: 3_000, n: 3 },
];

function build() {
  const economy = new Economy({ seed: CONFIG.seed });
  for (const g of GOODS) economy.addGood(g.id, g);
  for (let i = 0; i < CONFIG.players; i += 1) economy.addPlayer(`p${i}`, STARTING_GRANT);
  return economy;
}

/**
 * Largest quantity this player can actually afford right now, capped by
 * the per-trade size limit. Halving down from the cap keeps the search
 * to a handful of steps instead of a loop over every quantity.
 */
function affordableQty(economy, playerId, good, want) {
  let qty = Math.min(want, maxTradeQty(good.supply));
  const cash = economy.players.get(playerId).cash;
  while (qty > 0 && buyCost(good.basePrice, good.supply, qty, good.k, good.n) > cash) {
    qty = Math.floor(qty / 2);
  }
  return qty;
}

function run() {
  const economy = build();
  const rng = makeRandom(CONFIG.seed);
  const history = Object.fromEntries(GOODS.map((g) => [g.id, []]));
  const startPrice = Object.fromEntries(GOODS.map((g) => [g.id, economy.spot(g.id)]));

  let executed = 0;

  for (let i = 0; i < CONFIG.trades; i += 1) {
    const playerId = `p${rng.int(0, CONFIG.players - 1)}`;
    const good = economy.goods.get(rng.pick(GOODS).id);
    const holding = economy.held(playerId, good.id);

    // One trade in twelve is reckless: it ignores the caps and asks for
    // far more than the player can cover. A simulation that only ever
    // submits valid trades proves nothing about the guards - these are
    // here so the rejection paths are exercised under load rather than
    // only in unit tests.
    const reckless = rng.chance(1 / 12);

    // A player holding something sells about half the time. Everyone
    // else can only buy, which is what gives the market net upward
    // pressure early and something to sell into later.
    if (holding > 0 && rng.chance(0.45)) {
      const qty = reckless
        ? holding + rng.int(1, 5_000)
        : Math.min(holding, maxTradeQty(good.supply), rng.int(1, holding));
      if (qty > 0 && economy.sell(playerId, good.id, qty).ok) executed += 1;
    } else {
      const want = rng.int(1, 400);
      const qty = reckless
        ? want + rng.int(1, 50_000)
        : affordableQty(economy, playerId, good, want);
      if (qty > 0 && economy.buy(playerId, good.id, qty).ok) executed += 1;
    }

    if (i % CONFIG.checkEvery === 0) {
      for (const g of GOODS) history[g.id].push(economy.spot(g.id));
      const violations = economy.checkInvariants();
      if (violations.length > 0) {
        console.error(`\nINVARIANT VIOLATION at trade ${i}:`);
        for (const v of violations) console.error(`  ${v}`);
        process.exit(1);
      }
    }
  }

  for (const g of GOODS) history[g.id].push(economy.spot(g.id));
  report(economy, history, startPrice, executed);
  return economy;
}

/**
 * Buy a quantity and immediately sell it back. The result must always be
 * negative. This is checked here as well as in the test suite because it
 * is the single most important property of the whole economy, and it
 * should be visible in the simulation output, not just in a green test.
 */
function roundTripCheck(economy) {
  const rows = [];
  for (const g of economy.goods.values()) {
    const qty = Math.max(1, Math.min(250, maxTradeQty(g.supply)));
    const cost = buyCost(g.basePrice, g.supply, qty, g.k, g.n);
    const back = sellReturn(g.basePrice, g.supply + qty, qty, g.k, g.n);
    rows.push({
      good: g.id,
      qty,
      cost: notes(cost),
      'sold back for': notes(back),
      net: notes(back - cost),
      lossy: back < cost ? 'yes' : 'NO — BROKEN',
    });
  }
  return rows;
}

function report(economy, history, startPrice, executed) {
  const accounted = economy.totalCash() + economy.reserve + economy.burned;

  console.log(`\nGeneral Company — economy simulation`);
  console.log(`${'='.repeat(72)}`);
  console.log(
    `seed ${CONFIG.seed} · ${CONFIG.players} players · ${CONFIG.trades} attempts · ` +
      `${executed} executed`,
  );

  console.log(`\nRejections`);
  console.log(
    table([
      {
        'insufficient funds': economy.rejections.funds,
        'insufficient holdings': economy.rejections.holdings,
        'over trade cap': economy.rejections.cap,
      },
    ]),
  );

  console.log(`\nPrice evolution`);
  console.log(
    table(
      Object.keys(history).map((id) => {
        const g = economy.goods.get(id);
        const series = history[id];
        const now = series[series.length - 1];
        return {
          good: id,
          n: g.n,
          supply: notes(g.supply),
          open: startPrice[id].toFixed(2),
          close: now.toFixed(2),
          change: `${(((now - startPrice[id]) / startPrice[id]) * 100).toFixed(1)}%`,
          chart: sparkline(series),
        };
      }),
    ),
  );

  console.log(`\nRound trip — buy then immediately sell back`);
  console.log(table(roundTripCheck(economy)));

  console.log(`\nMoney supply`);
  console.log(
    table([
      { term: 'granted (faucet)', notes: notes(economy.granted) },
      { term: 'player cash', notes: notes(economy.totalCash()) },
      { term: 'curve reserve', notes: notes(economy.reserve) },
      { term: 'burned by spread (sink)', notes: notes(economy.burned) },
      { term: 'cash + reserve + burned', notes: notes(accounted) },
      { term: 'discrepancy', notes: notes(accounted - economy.granted) },
    ]),
  );

  // Buys round up and sells round down, so the reserve carries a little
  // more than the curve integral says it should. The gap is the
  // accumulated dust, and it always favours the system.
  const dust = economy.reserve - economy.reserveFromCurve();
  console.log(`\nRounding`);
  console.log(
    table([
      { term: 'reserve, accumulated', notes: notes(economy.reserve) },
      {
        term: 'reserve, from curve integral',
        notes: notes(Math.round(economy.reserveFromCurve())),
      },
      { term: 'dust (must be >= 0)', notes: notes(Math.round(dust)) },
      { term: 'dust per executed trade', notes: (dust / Math.max(1, executed)).toFixed(4) },
    ]),
  );

  const violations = economy.checkInvariants();
  console.log(`\n${'='.repeat(72)}`);
  if (violations.length === 0) {
    console.log(`ALL INVARIANTS HOLD — money supply balances to the exact Note.`);
  } else {
    console.log(`INVARIANTS VIOLATED:`);
    for (const v of violations) console.log(`  ${v}`);
    process.exitCode = 1;
  }
  console.log('');
}

run();
