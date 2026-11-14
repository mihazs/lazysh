// Parse-only throughput of xterm.js 5.5.0 (headless, no renderer) on the bytes of the recorded baseline's streamed workloads,
// with the final screen checked against the one the baseline expects. Same bytes as `harness_parse` in packages/terminal-runtime.
// Usage: bun bench/dumpWorkloads.ts <dir> && node bench/harnessParse.mjs <dir>
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { RUNS, cell, xtermRun } from './vtBench.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node bench/harnessParse.mjs <dir>'); process.exit(2); }
console.log(`node ${process.version} (V8 ${process.versions.v8}), ${os.cpus()[0]?.model}, ${os.type()} ${os.release()}, load average at start ${os.loadavg().map(x => x.toFixed(2)).join(' ')}`);
console.log(`xterm.js @xterm/headless 5.5.0, scrollback 5000 lines, 16 KiB chunks, ${RUNS} runs, MiB/s median (min to max)\n`);
console.log('| workload | geometry | bytes | xterm.js write() | xterm.js writeSync (private, no scheduling) | final screen equals the baseline\'s |');
console.log('|---|---|---|---|---|---|');
for (const file of readdirSync(dir).filter(name => name.endsWith('.bin')).sort()) {
  const [kind, geometry] = file.slice(0, -4).split('-'), [cols, rows] = geometry.split('x').map(Number);
  const data = new Uint8Array(readFileSync(`${dir}/${file}`)), expected = readFileSync(`${dir}/${file.slice(0, -4)}.screen.json`, 'utf8');
  await xtermRun(data.subarray(0, 1 << 20), 'sync', cols, rows); // warm the JIT
  const runs = { write: [], sync: [] };
  let last;
  for (let i = 0; i < RUNS; i++) {
    last = await xtermRun(data, 'write', cols, rows);
    runs.write.push(last.mib); runs.sync.push((await xtermRun(data, 'sync', cols, rows)).mib);
  }
  console.log(`| ${kind} | ${geometry} | ${data.length} | ${cell(runs.write)} | ${cell(runs.sync)} | ${JSON.stringify(last.screen) === expected} |`);
}
