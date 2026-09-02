const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Compress a price series into a single line of block characters. */
export function sparkline(series, width = 40) {
  if (series.length === 0) return '';
  const step = Math.max(1, Math.floor(series.length / width));
  const sampled = [];
  for (let i = 0; i < series.length; i += step) sampled.push(series[i]);

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min || 1;
  return sampled
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / span) * BLOCKS.length))])
    .join('');
}

export const notes = (n) => n.toLocaleString('en-US');

export function table(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const width = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]),
  );
  const line = (cells) => '  ' + cols.map((c) => String(cells[c]).padEnd(width[c])).join('  ');
  const header = line(Object.fromEntries(cols.map((c) => [c, c])));
  const rule = '  ' + cols.map((c) => '-'.repeat(width[c])).join('  ');
  return [header, rule, ...rows.map(line)].join('\n');
}
