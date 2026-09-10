import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/api/src/redis/client.js';
import { buyCost, grossSellValue } from '@tgc/shared';

/**
 * The curve is implemented twice: once in JavaScript
 * (packages/shared/src/curve.js) for quotes, portfolio valuation and the
 * simulation, and once in Lua (packages/api/src/lua/trade.lua) for
 * execution.
 *
 * Two implementations of the same maths is a liability. If they ever
 * disagree, a quote promises one price and the trade charges another,
 * and - worse - the Phase 6 rebuild replays the ledger through the
 * JavaScript version and reconstructs a market that never existed.
 *
 * This test is the thing standing between those two implementations and
 * silent divergence.
 *
 * It has already earned its place. The first version of trade.lua
 * returned numbers via tostring(), which switches to scientific notation
 * past about 1e14 and keeps only 14 significant digits: a cost of
 * 353,041,482,706,872 came back as 3.5304148270687e+14, short by 72
 * Notes. 36 of 6,993 combinations disagreed. Formatting with '%.0f'
 * fixed every one.
 */

// The same arithmetic trade.lua performs, isolated so it can be compared
// directly against the JavaScript without running a whole trade.
const CURVE_LUA = `
local base = tonumber(ARGV[1])
local k    = tonumber(ARGV[2])
local n    = tonumber(ARGV[3])
local s    = tonumber(ARGV[4])
local q    = tonumber(ARGV[5])
local function integral(x) return (base * k / (n + 1)) * math.pow(1 + x / k, n + 1) end
local function fmt(x) return string.format('%.0f', x) end
return { fmt(math.ceil(integral(s + q) - integral(s))),
         fmt(math.floor(integral(s) - integral(s - q))) }
`;

const BASES = [10, 45, 60, 120, 200, 340, 500, 2_000, 50_000];
const KS = [100, 500, 3_000, 8_000, 12_000, 20_000, 25_000];
const NS = [1, 2, 3];
const SUPPLIES = [100, 250, 1_000, 5_000, 12_000, 40_000, 250_000];
const QTYS = [1, 7, 50, 100, 500, 2_500];

beforeAll(connectRedis);
afterAll(disconnectRedis);

describe('lua and javascript compute the same curve', () => {
  it('agrees on every combination across the parameter band', async () => {
    const redis = getRedis();
    const mismatches = [];
    let checked = 0;

    for (const base of BASES) {
      for (const k of KS) {
        for (const n of NS) {
          for (const s of SUPPLIES) {
            for (const q of QTYS) {
              if (q > s) continue;
              const [luaCost, luaGross] = await redis.eval(CURVE_LUA, 0, base, k, n, s, q);
              checked += 1;

              if (Number(luaCost) !== buyCost(base, s, q, k, n)) {
                mismatches.push({ base, k, n, s, q, side: 'buy', luaCost });
              }
              if (Number(luaGross) !== grossSellValue(base, s, q, k, n)) {
                mismatches.push({ base, k, n, s, q, side: 'sell', luaGross });
              }
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(6_000);
    expect(mismatches.slice(0, 3)).toEqual([]);
    expect(mismatches).toHaveLength(0);
  });

  it('does not lose digits on values large enough to need them', async () => {
    // The specific failure this test was written for. Anything above
    // 1e14 must still come back exact.
    const redis = getRedis();
    const [cost] = await redis.eval(CURVE_LUA, 0, 45, 100, 3, 250_000, 500);

    expect(cost).not.toMatch(/e\+/i);
    expect(Number(cost)).toBe(buyCost(45, 250_000, 500, 100, 3));
  });
});
