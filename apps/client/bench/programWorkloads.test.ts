import xterm from '@xterm/headless';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { programWorkloads, type Replay } from './programWorkloads';
import { agentStream, moshEnvelope } from './workloads';

const { Terminal } = xterm;
const all = programWorkloads({ agentTokens: 120 });
const streams = all.filter(replay => replay.kind === 'stream');

/** The screen and cursor xterm.js 5.5.0 (headless) shows after the stream's steps were delivered `times` times in a row. */
async function replayed(replay: Pick<Replay, 'cols' | 'rows' | 'steps'>, times: number) {
  const terminal = new Terminal({ cols: replay.cols, rows: replay.rows, scrollback: 5000, allowProposedApi: true });
  for (let i = 0; i < times; i++) for (const step of replay.steps) await new Promise<void>(resolve => terminal.write(Buffer.from(step, 'base64'), resolve));
  const buffer = terminal.buffer.active;
  return { lines: Array.from({ length: replay.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true).trimEnd() ?? ''), cursor: [buffer.cursorX, buffer.cursorY] };
}

describe('program workloads', () => {
  it('cover W5 to W8 and W11, each with a recorded source, a hash and bytes; only the seeded agent stream is not repeatable', () => {
    expect(all.filter(replay => replay.kind === 'stream' && !replay.repeatable).map(replay => replay.id)).toEqual(['W8']);
    expect(new Set(all.map(replay => replay.id))).toEqual(new Set(['W5', 'W6', 'W7', 'W8', 'W11']));
    for (const replay of all) {
      expect(replay.sha256, replay.variant).toMatch(/^[0-9a-f]{64}$/);
      expect(replay.bytes, replay.variant).toBeGreaterThan(0);
      expect(replay.checks, replay.variant).toHaveLength(replay.steps.length);
    }
  });

  it.each(streams.map(replay => [replay.variant, replay] as const))('%s: the screen after the last step is the recorded one, and stays so when a repeatable stream is replayed again', async (_name, replay) => {
    const expected = replay.checks.at(-1)!;
    for (const times of replay.repeatable ? [1, 2, 3] : [1]) expect(await replayed(replay, times), `replayed ${times} times`).toEqual({ lines: expected.lines, cursor: expected.cursor });
  });

  it('wraps a captured Mosh body in the envelope that reproduces the captured update, whatever its id', () => {
    const captured = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../e2e/fixtures/mosh-resize-frames.json'), 'utf8')).frames as { frameId: number; bytesHex: string }[];
    const frames = all.find(replay => replay.variant.startsWith('six captured'))!;
    expect(frames.steps).toHaveLength(captured.length);
    frames.steps.forEach((step, i) => {
      const [cols, rows] = frames.checks[i]!.size!;
      expect(Buffer.from(moshEnvelope(captured[i].frameId, { cols, rows }, Buffer.from(step, 'base64'))).toString('hex')).toBe(captured[i].bytesHex);
    });
    expect(new TextDecoder().decode(moshEnvelope(99, { cols: 7, rows: 3 }, new Uint8Array()))).toBe('\x1b]7777;lazysh-mosh;1;begin;99;7;3\x1b\\\x1b]7777;lazysh-mosh;1;end;99\x1b\\');
  });
});

describe('agent stream', () => {
  it.each([[1, 100, 30], [7, 100, 30], [300, 100, 30], [300, 46, 37], [60, 80, 12]])('%i writes at %ix%i end on the screen xterm.js shows', async (tokens, cols, rows) => {
    const stream = agentStream({ tokens, cols, rows, seed: 5 });
    const shown = await replayed({ cols, rows, steps: stream.steps.map(step => Buffer.from(step).toString('base64')) }, 1);
    expect(shown.lines).toEqual(stream.screen);
    expect(shown.cursor).toEqual(stream.cursor);
  });

  it('replays identical bytes for a seed, different ones for another, and writes in small pieces', () => {
    const a = agentStream({ tokens: 50, cols: 100, rows: 30, seed: 1 }), b = agentStream({ tokens: 50, cols: 100, rows: 30, seed: 1 }), c = agentStream({ tokens: 50, cols: 100, rows: 30, seed: 2 });
    expect(a.steps).toEqual(b.steps);
    expect(a.steps).not.toEqual(c.steps);
    expect(a.steps).toHaveLength(50);
    expect(Math.max(...a.steps.map(step => step.length))).toBeLessThan(2000);
  });
});
