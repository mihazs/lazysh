// Shared by the parse-only VT benchmarks (wasmVt.mjs, harnessParse.mjs): the xterm.js headless run and the statistics.
import xterm from '@xterm/headless';
const { Terminal } = xterm;

export const CHUNK = 16 * 1024, RUNS = 5, SCROLLBACK_LINES = 5000;

// xterm.js warns on every writeSync; the private call is only the no-scheduling upper bound of its parser.
const warn = console.warn;
console.warn = (message, ...rest) => { if (!String(message).includes('writeSync')) warn(message, ...rest); };

export const median = xs => { const s = [...xs].sort((a, b) => a - b); return [s[s.length >> 1], s[0], s.at(-1)]; };
export const cell = xs => { const [m, lo, hi] = median(xs); return `${m.toFixed(1)} (${lo.toFixed(1)} to ${hi.toFixed(1)})`; };
export const mibPerS = (bytes, ms) => bytes / 1048576 / (ms / 1000);

/** One xterm.js headless run over `data` in 16 KiB chunks; `mode` is 'write' (queued, as the app calls it) or 'sync' (the private parser entry). */
export async function xtermRun(data, mode, cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const started = performance.now();
  if (mode === 'sync') for (let at = 0; at < data.length; at += CHUNK) term._core.writeSync(data.subarray(at, at + CHUNK));
  else {
    for (let at = 0; at < data.length; at += CHUNK) term.write(data.subarray(at, at + CHUNK));
    await new Promise(resolve => term.write('', resolve));
  }
  const ms = performance.now() - started, b = term.buffer.active;
  const screen = Array.from({ length: rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  term.dispose();
  return { mib: mibPerS(data.length, ms), cursor: [b.cursorX, b.cursorY], screen };
}
