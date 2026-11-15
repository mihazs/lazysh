// Distinct visible cells (character, foreground, background, attributes) a renderer with a glyph cache has to draw when a
// workload is rendered after every 16 KiB chunk, from the real xterm.js 5.5.0 parser (@xterm/headless): SGR attributes
// accumulate until reset, so the number of cells differs from the number of distinct SGR sequences in the bytes.
// Usage: bun bench/glyphPairs.ts [cols rows]   (docs/architecture/terminal-benchmarks.md, #1323)
import xterm from '@xterm/headless';
import { ansiColor, chunks, STYLE_FAMILIES, styledText, type StyleFamily, type Workload } from './workloads';

const { Terminal } = xterm;

/** `frames` rendered screens (one per chunk), the distinct cells over all of them, and over the last one. */
export async function visiblePairs(data: Uint8Array, cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true }), seen = new Set<string>();
  let last = new Set<string>(), frames = 0;
  const cell = terminal.buffer.active.getNullCell();
  for (const part of chunks(data)) {
    await new Promise<void>(resolve => terminal.write(part, resolve));
    const buffer = terminal.buffer.active;
    last = new Set();
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      for (let x = 0; line && x < cols; x++) {
        const c = line.getCell(x, cell)!, chars = c.getChars();
        if (chars === '' || chars === ' ') continue;
        const key = `${chars}|${c.getFgColorMode()}:${c.getFgColor()}|${c.getBgColorMode()}:${c.getBgColor()}|${c.isBold()}${c.isItalic()}${c.isUnderline()}${c.isDim()}${c.isInverse()}${c.isStrikethrough()}`;
        seen.add(key); last.add(key);
      }
    }
    frames++;
  }
  terminal.dispose();
  return { frames, pairs: seen.size, lastScreenPairs: last.size };
}

if (import.meta.main) {
  const [cols = 46, rows = 37] = process.argv.slice(2).map(Number);
  const rowsOut: Array<[string, Workload]> = [];
  for (const [family, styles] of [['truecolor', 1], ['truecolor', 32], ['truecolor', 256], ['truecolor', 2048], ['indexed', 256], ['background', 256], ['background', 2048], ['attributes', 8], ['attributes', 256], ['palette16', 8], ['brightOnBackground', 64], ['truecolorOnBackground', 256], ['boldUnderline', 8]] as const satisfies ReadonlyArray<readonly [StyleFamily, number]>)
    rowsOut.push([`${styles} ${family} (${STYLE_FAMILIES[family].limit} possible)`, styledText({ bytes: 1 << 20, cols, rows, seed: 50, styles, family })]);
  for (const mib of [0.5, 1, 2, 4]) rowsOut.push([`W3 ${mib} MiB`, ansiColor({ bytes: mib * (1 << 20), cols, rows, seed: 30 })]);
  console.log(`${cols}x${rows}: distinct visible cells over every 16 KiB chunk end (first 1 MiB for styled text, as run), and on the last screen`);
  for (const [name, w] of rowsOut) {
    const { frames, pairs, lastScreenPairs } = await visiblePairs(w.data, cols, rows);
    console.log(`${name.padEnd(40)} ${String(frames).padStart(4)} frames ${String(pairs).padStart(6)} cells ${String(lastScreenPairs).padStart(5)} on the last screen`);
  }
}
