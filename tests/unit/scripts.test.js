import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseKeyCount, assertNoCollision } from '../../packages/api/src/redis/scripts.js';

const LUA_DIR = join(process.cwd(), 'packages/api/src/lua');

describe('lua key-count directive', () => {
  it('reads the declared count', () => {
    expect(parseKeyCount('-- keys: 3\nreturn 1', 'x')).toBe(3);
    expect(parseKeyCount('-- a comment\n-- keys: 0\nreturn 1', 'x')).toBe(0);
  });

  it('refuses a script that does not declare one', () => {
    expect(() => parseKeyCount('return 1', 'mystery')).toThrow(/missing its key-count/);
  });

  it('every shipped script declares a count that matches its KEYS usage', async () => {
    const files = (await readdir(LUA_DIR)).filter((f) => f.endsWith('.lua'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(join(LUA_DIR, file), 'utf8');
      const declared = parseKeyCount(source, basename(file, '.lua'));

      // Highest KEYS[n] the script actually references. A script that
      // declares fewer keys than it uses works on one node and breaks on
      // a cluster, so the two must not drift apart.
      const used = [...source.matchAll(/KEYS\[(\d+)\]/g)].map((m) => Number(m[1]));
      const highest = used.length > 0 ? Math.max(...used) : 0;

      expect(declared, `${file} declares ${declared} keys but uses KEYS[${highest}]`).toBe(highest);
    }
  });
});

describe('client method collisions', () => {
  // A script's filename becomes a method on the Redis client, so a file
  // named ping.lua replaces redis.ping() with itself. That is exactly how
  // the Phase 1 health check came to report a healthy Redis as down.
  const fakeClient = { ping: () => {}, get: () => {}, eval: () => {} };

  it('refuses a script that would shadow a real command', () => {
    expect(() => assertNoCollision(fakeClient, 'ping')).toThrow(/would shadow/);
    expect(() => assertNoCollision(fakeClient, 'get')).toThrow(/would shadow/);
  });

  it('allows a name that shadows nothing', () => {
    expect(() => assertNoCollision(fakeClient, 'trade')).not.toThrow();
    expect(() => assertNoCollision(fakeClient, 'smoketest')).not.toThrow();
  });

  it('no shipped script name collides with an ioredis client method', async () => {
    const { default: Redis } = await import('ioredis');
    const files = (await readdir(LUA_DIR)).filter((f) => f.endsWith('.lua'));

    for (const file of files) {
      const name = basename(file, '.lua');
      expect(typeof Redis.prototype[name], `${file} would shadow redis.${name}()`).not.toBe(
        'function',
      );
    }
  });
});
