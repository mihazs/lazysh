// Cold start of the "WASM terminal" candidate against xterm.js on the same V8 (Node), one fresh process per sample
// (docs/architecture/terminal-benchmarks.md, #1323): how long until the first byte is parsed, from nothing loaded.
// Usage: node bench/wasmStartup.mjs <ghostty-vt.wasm> [processes]
// The module is built as described in the benchmarks document. Each child process measures once and prints one JSON line:
// xterm.js (import of @xterm/headless, `new Terminal`, first 16 KiB written) or wasm (read the file, compile, instantiate,
// create the terminal, first 16 KiB written), plus the process's resident set before and after.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const [wasmPath, count = '15', mode, ...rest] = process.argv.slice(2);
const SAMPLE = new TextEncoder().encode('\x1b[31mhello\x1b[0m world 日本語 \u{1F600}\r\n'.repeat(400)).subarray(0, 16 * 1024);
const rssMiB = () => process.memoryUsage().rss / 1048576;

if (mode === '--child') {
  const [engine] = rest, rss0 = rssMiB(), t0 = performance.now();
  let t1, cursor;
  if (engine === 'xterm') {
    const { Terminal } = (await import('@xterm/headless')).default;
    t1 = performance.now();
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    term._core.writeSync(SAMPLE);
    cursor = [term.buffer.active.cursorX, term.buffer.active.cursorY];
  } else {
    const bytes = readFileSync(wasmPath);
    t1 = performance.now();
    const module = new WebAssembly.Module(bytes), t2 = performance.now();
    const { exports: x } = new WebAssembly.Instance(module, {}), t3 = performance.now();
    const slot = x.ghostty_wasm_alloc_opaque();
    if (x.ghostty_terminal_new(0, slot, 80, 24) !== 0) throw new Error('ghostty_terminal_new failed');
    const term = new DataView(x.memory.buffer).getUint32(slot, true), buffer = x.ghostty_alloc(0, SAMPLE.length), out = x.ghostty_alloc(0, 8);
    new Uint8Array(x.memory.buffer, buffer, SAMPLE.length).set(SAMPLE);
    x.ghostty_terminal_vt_write(term, buffer, SAMPLE.length);
    const at = id => { x.ghostty_terminal_get(term, id, out); return new DataView(x.memory.buffer).getUint16(out, true); };
    cursor = [at(3), at(4)];
    console.log(JSON.stringify({ compileMs: t2 - t1, instantiateMs: t3 - t2, memoryMiB: x.memory.buffer.byteLength / 1048576, rssBefore: rss0, rssAfter: rssMiB(), totalMs: performance.now() - t0, loadMs: t1 - t0, cursor }));
    process.exit(0);
  }
  console.log(JSON.stringify({ loadMs: t1 - t0, totalMs: performance.now() - t0, rssBefore: rss0, rssAfter: rssMiB(), cursor }));
  process.exit(0);
}

if (!wasmPath) { console.error('usage: node bench/wasmStartup.mjs <ghostty-vt.wasm> [processes]'); process.exit(2); }
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const range = xs => `${median(xs).toFixed(1)} (${Math.min(...xs).toFixed(1)} to ${Math.max(...xs).toFixed(1)})`;
const run = engine => Array.from({ length: Number(count) }, () => {
  const done = spawnSync(process.execPath, [new URL(import.meta.url).pathname, wasmPath, count, '--child', engine], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`${engine} child failed: ${done.stderr}`);
  return JSON.parse(done.stdout.trim());
});
console.log(`node ${process.version} (V8 ${process.versions.v8}), ${os.cpus()[0]?.model}, ${os.type()} ${os.release()}, load average at start ${os.loadavg().map(x => x.toFixed(2)).join(' ')}`);
console.log(`${count} fresh processes per engine, first 16 KiB written; milliseconds and MiB, median (min to max); wasm module ${(readFileSync(wasmPath).length / 1048576).toFixed(1)} MiB`);
const xterm = run('xterm'), wasm = run('wasm');
const same = xterm.every(s => s.cursor.join() === xterm[0].cursor.join()) && wasm.every(s => s.cursor.join() === wasm[0].cursor.join());
if (!same || xterm[0].cursor.join() !== wasm[0].cursor.join()) throw new Error(`the engines disagree on the cursor: ${xterm[0].cursor} against ${wasm[0].cursor}`);
console.log('| engine | load (import or file read) | compile | instantiate | start to first byte parsed, total | resident set added | wasm linear memory |');
console.log('|---|---|---|---|---|---|---|');
console.log(`| xterm.js headless | ${range(xterm.map(s => s.loadMs))} | | | ${range(xterm.map(s => s.totalMs))} | ${range(xterm.map(s => s.rssAfter - s.rssBefore))} | |`);
console.log(`| libghostty-vt wasm | ${range(wasm.map(s => s.loadMs))} | ${range(wasm.map(s => s.compileMs))} | ${range(wasm.map(s => s.instantiateMs))} | ${range(wasm.map(s => s.totalMs))} | ${range(wasm.map(s => s.rssAfter - s.rssBefore))} | ${range(wasm.map(s => s.memoryMiB))} |`);
