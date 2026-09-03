import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseKeyCount } from '../../packages/api/src/redis/scripts.js';

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
