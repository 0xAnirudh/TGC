/**
 * Load test.
 *
 * Drives the running API over HTTP and reports latency percentiles for
 * the two paths the non-functional requirements actually name:
 *
 *   NFR-1  quote latency   p95 under 10ms
 *   NFR-2  trade execution p95 under 50ms end to end
 *
 * Then runs the invariant suite against the resulting state, because a
 * fast market that has stopped balancing is not a result worth
 * publishing.
 *
 *   node loadtest/run.mjs --users=40 --trades=600
 *
 * A k6 version of the same scenarios is in loadtest/k6/, for anyone who
 * has k6 installed. This exists so the numbers can be reproduced with
 * nothing but Node.
 */
import { connectMongo, disconnectMongo } from '../packages/api/src/db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../packages/api/src/redis/client.js';
import { User } from '../packages/api/src/models/User.js';
import {
  ECON_GRANTED,
  ECON_RESERVE,
  ECON_BURNED,
  userCash,
} from '../packages/api/src/redis/keys.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const BASE = process.env.LOADTEST_BASE ?? 'http://localhost:4000';
const USERS = arg('users', 40);
const TRADES = arg('trades', 600);
const QUOTES = arg('quotes', 1_500);

/**
 * Concurrent virtual users.
 *
 * This matters more than it looks. The first version of this script
 * fired every request at once with Promise.all and reported a quote p95
 * of 12.8 SECONDS - which measured nothing but how long 1,500 requests
 * take to queue through one Node process. Latency under a stampede is
 * queueing time, not service time, and publishing it as the system's
 * latency would be dishonest.
 *
 * A real load test holds concurrency fixed and measures how the system
 * responds at that level.
 */
const VUS = arg('vus', 20);

/**
 * Run `total` tasks through a pool of `concurrency` workers.
 *
 * Each worker takes the next task when it finishes its current one, so
 * exactly `concurrency` requests are in flight at any moment.
 */
async function pool(total, concurrency, task) {
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      await task(i);
    }
  });
  await Promise.all(workers);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarise(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    path: label,
    n: sorted.length,
    p50: percentile(sorted, 50).toFixed(2),
    p95: percentile(sorted, 95).toFixed(2),
    p99: percentile(sorted, 99).toFixed(2),
    max: (sorted[sorted.length - 1] ?? 0).toFixed(2),
  };
}

async function timed(fn) {
  const t = process.hrtime.bigint();
  const res = await fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, res };
}

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);

  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`\n  API is not answering at ${BASE}. Start it first.\n`);
    process.exit(1);
  }

  const { goods } = await fetch(`${BASE}/goods`).then((r) => r.json());
  if (goods.length === 0) {
    console.error('\n  No goods. Run the seed first.\n');
    process.exit(1);
  }

  // Registration is rate limited per IP, so load-test accounts are made
  // directly. The limiter is tested in its own suite; throttling the
  // load generator would only measure the limiter.
  const { issueToken } = await import('../packages/api/src/services/auth.js');
  const { STARTING_GRANT } = await import('@tgc/shared');
  const stamp = Date.now().toString(36);

  const tokens = [];
  for (let i = 0; i < USERS; i += 1) {
    const username = `lt_${stamp}_${i}`;
    const user = await User.create({
      username,
      usernameLower: username,
      passwordHash: 'loadtest-account-cannot-log-in',
      cash: STARTING_GRANT * 50,
      startingGrant: STARTING_GRANT * 50,
    });
    await getRedis()
      .multi()
      .set(userCash(user._id.toString()), STARTING_GRANT * 50)
      .incrby(ECON_GRANTED, STARTING_GRANT * 50)
      .exec();
    tokens.push(issueToken(user));
  }

  console.log(
    `\n  ${USERS} accounts, ${goods.length} goods, ${VUS} concurrent users, target ${BASE}`,
  );

  // ---- quote read storm -------------------------------------------
  const quoteSamples = [];
  const quoteStarted = Date.now();
  await pool(QUOTES, VUS, async (i) => {
    const good = goods[i % goods.length];
    const { ms } = await timed(() =>
      fetch(`${BASE}/goods/${good.id}/quote?side=buy&qty=50`).then((r) => r.json()),
    );
    quoteSamples.push(ms);
  });
  const quoteRps = Math.round(QUOTES / ((Date.now() - quoteStarted) / 1000));

  // ---- sustained mixed trading ------------------------------------
  const tradeSamples = [];
  let accepted = 0;
  let rejected = 0;
  const rejectionReasons = {};

  const tradeStarted = Date.now();
  await pool(TRADES, VUS, async (i) => {
    const token = tokens[i % tokens.length];
    const good = goods[i % goods.length];
    // Three buys to one sell, so supply builds rather than every sell
    // failing against an empty market.
    const side = i % 4 === 3 ? 'sell' : 'buy';

    const { ms, res } = await timed(() =>
      post('/trades', { goodId: good.id, side, qty: 25, slippageBps: 3_000 }, token),
    );
    tradeSamples.push(ms);

    if (res.status === 201) accepted += 1;
    else {
      rejected += 1;
      const code = res.body?.error ?? String(res.status);
      rejectionReasons[code] = (rejectionReasons[code] ?? 0) + 1;
    }
  });
  const tradeRps = Math.round(TRADES / ((Date.now() - tradeStarted) / 1000));

  // ---- invariant ---------------------------------------------------
  const redis = getRedis();
  const [granted, reserve, burned] = await redis.mget(ECON_GRANTED, ECON_RESERVE, ECON_BURNED);
  const users = await User.find().lean();
  const cashValues = await redis.mget(...users.map((u) => userCash(u._id.toString())));
  const cash = cashValues.reduce((sum, v) => sum + Number(v ?? 0), 0);
  const accounted = cash + Number(reserve ?? 0) + Number(burned ?? 0);
  const discrepancy = accounted - Number(granted ?? 0);

  const table = (rows) => {
    const cols = Object.keys(rows[0]);
    const w = Object.fromEntries(
      cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]),
    );
    const line = (cells) => '  ' + cols.map((c) => String(cells[c]).padEnd(w[c])).join('  ');
    console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
    console.log('  ' + cols.map((c) => '-'.repeat(w[c])).join('  '));
    for (const r of rows) console.log(line(r));
  };

  console.log(`\n  Latency (ms)`);
  table([
    summarise('GET  /goods/:id/quote', quoteSamples),
    summarise('POST /trades', tradeSamples),
  ]);

  console.log(`\n  Trades`);
  console.log(`    accepted  ${accepted}`);
  console.log(`    rejected  ${rejected} ${JSON.stringify(rejectionReasons)}`);

  console.log(`\n  Money supply after load`);
  console.log(`    granted      ${Number(granted).toLocaleString()}`);
  console.log(`    cash         ${cash.toLocaleString()}`);
  console.log(`    reserve      ${Number(reserve ?? 0).toLocaleString()}`);
  console.log(`    burned       ${Number(burned ?? 0).toLocaleString()}`);
  console.log(`    discrepancy  ${discrepancy}`);
  console.log(
    `\n  ${discrepancy === 0 ? 'INVARIANT HOLDS' : 'INVARIANT VIOLATED'} after ${accepted} trades\n`,
  );

  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
  process.exit(discrepancy === 0 ? 0 : 1);
}

main();
