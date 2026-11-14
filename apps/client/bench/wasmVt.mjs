// Parse-only throughput of three VT engines on the same bytes and the same V8 (Node): xterm.js 5.5.0 headless (no renderer),
// and libghostty-vt compiled to WebAssembly from the vendored source (docs/architecture/terminal-benchmarks.md, #1323).
// Usage: node bench/wasmVt.mjs <ghostty-vt.wasm> <fixtures-dir> [MiB per workload]
// The wasm is built from packages/herdr-upstream/vendor/libghostty-vt with Zig: see the benchmarks document. The
// fixtures come from `cargo run --release --example dump_workloads -- <dir>` in packages/terminal-runtime.
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import { CHUNK, RUNS, SCROLLBACK_LINES, cell, mibPerS, xtermRun } from './vtBench.mjs';

const [wasmPath, fixtureDir, mib = '16'] = process.argv.slice(2);
if (!wasmPath || !fixtureDir) { console.error('usage: node bench/wasmVt.mjs <ghostty-vt.wasm> <fixtures-dir> [MiB]'); process.exit(2); }
const VOLUME = Number(mib) << 20, COLS = 80, ROWS = 24, SCROLLBACK_BYTES = 4 << 20;
const WORKLOADS = [['plain text', 'plain-text'], ['ANSI + truecolor', 'ansi---truecolor'], ['full-screen redraw', 'full-screen-redraw'], ['CJK/emoji/combining', 'cjk-emoji-combining']];

const load = slug => {
  const fd = openSync(`${fixtureDir}/${slug}.bin`, 'r'), data = Buffer.alloc(VOLUME);
  readSync(fd, data, 0, VOLUME, 0); closeSync(fd);
  return new Uint8Array(data.buffer, data.byteOffset, VOLUME);
};
const module = new WebAssembly.Module(readFileSync(wasmPath));
/** One libghostty-vt terminal in its own wasm instance: feeds 16 KiB chunks through linear memory like a WebView bridge would. */
function wasmTerminal() {
  const { exports: x } = new WebAssembly.Instance(module, {});
  const slot = x.ghostty_wasm_alloc_opaque();
  if (x.ghostty_terminal_new(0, slot, COLS, ROWS) !== 0) throw new Error('ghostty_terminal_new failed');
  const term = new DataView(x.memory.buffer).getUint32(slot, true);
  const limit = x.ghostty_alloc(0, 8);
  new DataView(x.memory.buffer).setBigUint64(limit, BigInt(SCROLLBACK_BYTES), true);
  if (x.ghostty_terminal_set(term, 27, limit) !== 0) throw new Error('scrollback option refused');
  const buffer = x.ghostty_alloc(0, CHUNK), out = x.ghostty_alloc(0, 8);
  const cursor = id => { x.ghostty_terminal_get(term, id, out); return new DataView(x.memory.buffer).getUint16(out, true); };
  return {
    write(chunk) { new Uint8Array(x.memory.buffer, buffer, chunk.length).set(chunk); x.ghostty_terminal_vt_write(term, buffer, chunk.length); },
    cursor: () => [cursor(3), cursor(4)],
    memoryMiB: () => x.memory.buffer.byteLength / 1048576,
  };
}

function wasmRun(data) {
  const t = wasmTerminal(), started = performance.now();
  for (let at = 0; at < data.length; at += CHUNK) t.write(data.subarray(at, at + CHUNK));
  const ms = performance.now() - started, cursor = t.cursor();
  if (cursor[0] === 0 && cursor[1] === 0) throw new Error('the wasm terminal shows no output: the measurement would be of nothing');
  return { mib: mibPerS(data.length, ms), cursor, memory: t.memoryMiB() };
}

console.log(`node ${process.version} (V8 ${process.versions.v8}), ${os.cpus()[0]?.model}, ${os.type()} ${os.release()}, load average at start ${os.loadavg().map(x => x.toFixed(2)).join(' ')}`);
console.log(`xterm.js @xterm/headless 5.5.0, scrollback ${SCROLLBACK_LINES} lines; libghostty-vt wasm32 ${(readFileSync(wasmPath).length / 1048576).toFixed(1)} MiB, scrollback ${SCROLLBACK_BYTES >> 20} MiB; ${COLS}x${ROWS}; ${mib} MiB per workload in 16 KiB chunks, ${RUNS} runs, MiB/s median (min to max)\n`);
console.log('| workload | xterm.js write() | xterm.js writeSync (private, no scheduling) | libghostty-vt wasm | cursor after (xterm / wasm) | wasm memory MiB |');
console.log('|---|---|---|---|---|---|');
for (const [name, slug] of WORKLOADS) {
  const data = load(slug), runs = { write: [], sync: [], wasm: [] };
  await xtermRun(data.subarray(0, 1 << 20), 'sync', COLS, ROWS); wasmRun(data.subarray(0, 1 << 20)); // warm the JIT
  let xt, w;
  for (let i = 0; i < RUNS; i++) {
    const a = await xtermRun(data, 'write', COLS, ROWS), b = await xtermRun(data, 'sync', COLS, ROWS);
    w = wasmRun(data); xt = a;
    runs.write.push(a.mib); runs.sync.push(b.mib); runs.wasm.push(w.mib);
  }
  console.log(`| ${name} | ${cell(runs.write)} | ${cell(runs.sync)} | ${cell(runs.wasm)} | ${xt.cursor.join(',')} / ${w.cursor.join(',')} | ${w.memory.toFixed(0)} |`);
}
