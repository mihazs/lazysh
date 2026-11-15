// Writes the bytes and the expected final screen of the baseline benchmark's streamed workloads (W2 plain, W3 ANSI,
// W4 redraw) at its two geometries, with the sizes and seeds apps/client/e2e/terminal-bench.spec.ts uses, so another
// engine can parse exactly what the recorded xterm.js baseline parsed (docs/architecture/terminal-benchmarks.md).
// Usage: bun bench/dumpWorkloads.ts <directory>; read by harnessParse.mjs and the terminal runtime's harness_parse example.
import { mkdirSync, writeFileSync } from 'node:fs';
import { ansiColor, fullScreenRedraw, plainText, type Geometry, type Workload } from './workloads';

export const GEOMETRIES: Geometry[] = [{ cols: 152, rows: 38 }, { cols: 46, rows: 37 }];
export const WORKLOADS: [string, (geometry: Geometry) => Workload][] = [
  ['plain', geometry => plainText({ bytes: 4 << 20, ...geometry, seed: 20 })],
  ['ansi', geometry => ansiColor({ bytes: 2 << 20, ...geometry, seed: 30 })],
  ['redraw', geometry => fullScreenRedraw({ frames: 1500, ...geometry, seed: 40 })],
];

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: bun bench/dumpWorkloads.ts <directory>'); process.exit(2); }
  mkdirSync(dir, { recursive: true });
  for (const geometry of GEOMETRIES) for (const [kind, make] of WORKLOADS) {
    const { data, screen } = make(geometry), name = `${dir}/${kind}-${geometry.cols}x${geometry.rows}`;
    writeFileSync(`${name}.bin`, data);
    writeFileSync(`${name}.screen.json`, JSON.stringify(screen));
    console.log(`${name}.bin ${data.length} bytes`);
  }
}
