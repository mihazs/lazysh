// Deterministic terminal workloads and statistics for the baseline benchmark.
// Pure module: no DOM, so it is shared by the in-page runner and unit tests.

export type Screen = string[];
export type Workload = { data: Uint8Array; screen: Screen; description: string };
export type Geometry = { cols: number; rows: number };

/** mulberry32: a small seeded PRNG so every run replays identical bytes. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'bravo', 'cache', 'delta', 'echo', 'fetch', 'graph', 'hash', 'index', 'join', 'kernel', 'lazy', 'merge', 'node', 'parse', 'queue', 'render', 'shell', 'token', 'unit', 'vector', 'write', 'xterm', 'yield', 'zone'];
const encoder = new TextEncoder();

function line(next: () => number, width: number) {
  let text = '';
  for (;;) {
    const word = WORDS[Math.floor(next() * WORDS.length)];
    if (text.length + word.length + 1 > width) return text;
    text += (text ? ' ' : '') + word;
  }
}

/** Visible rows left by streamed text: the last `rows` lines, the cursor row last. */
export function screenOf(text: string, rows: number): Screen {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\r\n').slice(-rows);
  while (lines.length < rows) lines.push(''); // a short transcript starts at the top row
  return lines.map(row => row.trimEnd());
}

type Text = Geometry & { bytes: number; seed: number };

/** W2: sustained plain text, every line one cell narrower than the terminal. */
export function plainText({ bytes, cols, rows, seed }: Text): Workload {
  const next = rng(seed), lines: string[] = [];
  let size = 0;
  while (size < bytes) { const row = line(next, cols - 1) + '\r\n'; lines.push(row); size += row.length; }
  const text = lines.join('');
  return { data: encoder.encode(text), screen: screenOf(text, rows), description: 'seeded lines of lowercase words' };
}

/** W3: the same text with a mix of 16-colour, 256-colour, truecolor and attribute sequences. */
export function ansiColor({ bytes, cols, rows, seed }: Text): Workload {
  const next = rng(seed), lines: string[] = [];
  const style = () => {
    const pick = Math.floor(next() * 6), n = Math.floor(next() * 256);
    return pick === 0 ? `\x1b[${30 + (n & 7)}m` : pick === 1 ? `\x1b[${90 + (n & 7)};${40 + ((n >> 3) & 7)}m` : pick === 2 ? `\x1b[38;5;${n}m`
      : pick === 3 ? `\x1b[38;2;${n};${(n * 7) & 255};${(n * 13) & 255};48;5;${(n * 3) & 255}m` : pick === 4 ? `\x1b[1;4;3${n & 7}m` : '\x1b[0m';
  };
  let size = 0;
  while (size < bytes) {
    const words = line(next, cols - 1).split(' ');
    const row = words.map(word => style() + word).join(' ') + '\x1b[0m\r\n';
    lines.push(row); size += row.length;
  }
  const text = lines.join('');
  return { data: encoder.encode(text), screen: screenOf(text, rows), description: 'seeded words, each with a random SGR style' };
}

/** How a style index becomes SGR parameters, and how many distinct valid styles the family has (`styles` must not exceed it). */
export const STYLE_FAMILIES = {
  truecolor: { limit: 65536, params: (i: number) => `38;2;${i & 255};${(i >> 8) & 255};${(i * 7) & 255}` },
  indexed: { limit: 256, params: (i: number) => `38;5;${i}` },
  /** Foreground and background, both from the 256-color palette. */
  background: { limit: 65536, params: (i: number) => `38;5;${i & 255};48;5;${i >> 8}` },
  /** The style families of W3, one at a time. */
  palette16: { limit: 8, params: (i: number) => `3${i}` },
  brightOnBackground: { limit: 64, params: (i: number) => `9${i & 7};4${i >> 3}` },
  truecolorOnBackground: { limit: 256, params: (i: number) => `38;2;${i};${(i * 7) & 255};${(i * 13) & 255};48;5;${(i * 3) & 255}` },
  boldUnderline: { limit: 8, params: (i: number) => `1;4;3${i}` },
  /** Bold, italic and underline in every combination, over indexed foregrounds. */
  attributes: { limit: 2048, params: (i: number) => `${['0', '1', '3', '1;3', '4', '1;4', '3;4', '1;3;4'][i & 7]};38;5;${i >> 3}` },
} as const;
export type StyleFamily = keyof typeof STYLE_FAMILIES;

/** Words in a chosen number of distinct styles (one SGR per word), for the cost of the first appearance of a glyph in a style. `distinctGlyphs` counts the (style, character) pairs a renderer with a glyph cache has to draw once. */
export function styledText({ bytes, cols, rows, seed, styles, family = 'truecolor' }: Text & { styles: number; family?: StyleFamily }): Workload & { distinctGlyphs: number } {
  const next = rng(seed), lines: string[] = [], glyphs = new Set<number>(), { limit, params } = STYLE_FAMILIES[family];
  if (styles > limit) throw new Error(`The ${family} family has only ${limit} styles, ${styles} requested`);
  let size = 0;
  while (size < bytes) {
    const row = line(next, cols - 1).split(' ').map(word => {
      const style = Math.floor(next() * styles);
      for (const char of word) glyphs.add(style * 256 + char.charCodeAt(0));
      return `\x1b[${params(style)}m${word}`;
    }).join(' ') + '\x1b[0m\r\n';
    lines.push(row); size += row.length;
  }
  const text = lines.join('');
  return { data: encoder.encode(text), screen: screenOf(text, rows), description: `seeded words in ${styles} distinct ${family} styles`, distinctGlyphs: glyphs.size };
}

/** W4: full-screen redraws by absolute positioning, like a TUI repainting every frame. */
export function fullScreenRedraw({ frames, cols, rows, seed }: Geometry & { frames: number; seed: number }): Workload {
  const next = rng(seed);
  let out = '', screen: Screen = [];
  for (let frame = 0; frame < frames; frame++) {
    screen = [];
    out += '\x1b[H';
    for (let row = 1; row <= rows; row++) {
      const text = `frame ${frame} row ${row} ${line(next, cols - 1)}`.slice(0, cols - 1).trimEnd();
      screen.push(text);
      out += `\x1b[${row};1H\x1b[${30 + (row & 7)}m${text}\x1b[0m\x1b[K`;
    }
  }
  return { data: encoder.encode(out), screen, description: `${frames} absolute-positioned repaints of the whole screen` };
}

/** The W2–W4 streams and their fixed seeds, shared by every benchmark arm. */
export function streamWorkload(kind: 'plain' | 'ansi' | 'redraw', size: number, geometry: Geometry): Workload {
  switch (kind) {
    case 'plain': return plainText({ ...geometry, bytes: size, seed: 20 });
    case 'ansi': return ansiColor({ ...geometry, bytes: size, seed: 30 });
    case 'redraw': return fullScreenRedraw({ ...geometry, frames: size, seed: 40 });
  }
}

/** W1: prompt, short command, short output; each element is one remote burst. */
export function shellSession(interactions: number, { cols, rows }: Geometry, seed: number): { bursts: string[]; screen: Screen } {
  const next = rng(seed), bursts: string[] = [];
  let text = '$ ';
  for (let i = 0; i < interactions; i++) {
    const command = `${WORDS[Math.floor(next() * WORDS.length)]} ${i}`;
    const output = Array.from({ length: Math.floor(next() * 4) }, () => line(next, Math.min(60, cols - 1))).map(row => row + '\r\n').join('');
    const burst = `${command}\r\n${output}$ `;
    bursts.push(burst); text += burst;
  }
  return { bursts, screen: screenOf(text, rows) };
}

const REGION_ROWS = 5;
/** W8, streaming: an agent CLI answering. Words arrive a few at a time; after every arrival the live region (the unfinished answer line, a spinner line and a bordered prompt box) is erased by moving up and rewritten, and a finished answer line is committed above it. One write per arrival. Needs at least REGION_ROWS + 1 rows. */
export function agentStream({ tokens, cols, rows, seed }: Geometry & { tokens: number; seed: number }): { steps: Uint8Array[]; screen: Screen; cursor: [x: number, y: number]; description: string } {
  const next = rng(seed), width = cols - 1, committed: string[] = [], steps: Uint8Array[] = [];
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', blue = '\x1b[38;2;120;120;255m', end = '\x1b[0m';
  const box = [`╭${'─'.repeat(width - 2)}╮`, `│ > ${' '.repeat(width - 5)}│`, `╰${'─'.repeat(width - 2)}╯`];
  let partial = '', arrived = 0, region: string[] = [];
  for (let token = 0; token < tokens; token++) {
    let commit = '';
    for (let words = 1 + Math.floor(next() * 3); words > 0; words--) {
      const word = WORDS[Math.floor(next() * WORDS.length)];
      if (partial && partial.length + word.length + 1 > width) { committed.push(partial); commit += `\x1b[2K${partial}\r\n`; partial = ''; }
      partial += (partial ? ' ' : '') + word; arrived++;
    }
    const status = `${spinner[token % spinner.length]} Working… (${Math.floor(token / 10)}s · ${arrived} words)`;
    region = [partial, status, ...box];
    const painted = [partial, `\x1b[2m${status}${end}`, ...box.map(row => blue + row + end)].map(row => `\x1b[2K${row}\r\n`).join('');
    steps.push(encoder.encode((token === 0 ? '' : `\x1b[${REGION_ROWS}A`) + commit + painted + '\x1b[2K'));
  }
  const all = [...committed, ...region, ''];
  return { steps, screen: screenOf(all.join('\r\n'), rows), cursor: [0, Math.min(all.length, rows) - 1], description: `${tokens} writes of one to three words, each followed by an in-place redraw of a ${REGION_ROWS}-row live region` };
}

/** A Mosh display update as the transport wraps it (apps/client/e2e/fixtures/mosh-resize-frames.json): the begin envelope names the frame and its size, the end envelope closes it. */
export function moshEnvelope(id: number, { cols, rows }: Geometry, body: Uint8Array) {
  const begin = encoder.encode(`\x1b]7777;lazysh-mosh;1;begin;${id};${cols};${rows}\x1b\\`), end = encoder.encode(`\x1b]7777;lazysh-mosh;1;end;${id}\x1b\\`);
  const out = new Uint8Array(begin.length + body.length + end.length);
  out.set(begin); out.set(body, begin.length); out.set(end, begin.length + body.length);
  return out;
}

/** The 16 KiB chunking the Rust session workers use (ssh.rs, local.rs). */
export const CHUNK = 16 * 1024;
export function chunks(data: Uint8Array, size = CHUNK) {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size) out.push(data.subarray(at, Math.min(at + size, data.length)));
  return out;
}

export type Summary = { n: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number };

/** Linear-interpolated percentile of an ascending array. */
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * p, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export function summarize(values: number[]): Summary | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0], p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1)!, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}

type Tree = number | null | boolean | string | Tree[] | { [key: string]: Tree };
/** Median of every numeric leaf across runs of the same shape; other leaves keep the first run's value. */
export function medianOf(runs: Tree[]): Tree {
  const first = runs[0];
  if (typeof first === 'number') {
    const numbers = runs.filter((run): run is number => typeof run === 'number');
    return percentile([...numbers].sort((a, b) => a - b), 0.5);
  }
  if (first && typeof first === 'object' && !Array.isArray(first))
    return Object.fromEntries(Object.keys(first).map(key => [key, medianOf(runs.map(run => (run as { [key: string]: Tree })?.[key] ?? null))]));
  return first;
}
