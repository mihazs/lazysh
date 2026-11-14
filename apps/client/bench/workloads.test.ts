import { describe, expect, it } from 'vitest';
import { ansiColor, chunks, fullScreenRedraw, medianOf, plainText, screenOf, shellSession, summarize } from './workloads';

const geometry = { cols: 80, rows: 24 };
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('terminal benchmark workloads', () => {
  it('replays identical bytes for the same seed and different bytes for another', () => {
    const a = plainText({ ...geometry, bytes: 20000, seed: 1 }), b = plainText({ ...geometry, bytes: 20000, seed: 1 }), c = plainText({ ...geometry, bytes: 20000, seed: 2 });
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
    expect(a.data.length).toBeGreaterThanOrEqual(20000);
  });

  it('keeps every text line narrower than the terminal so nothing wraps', () => {
    for (const workload of [plainText({ ...geometry, bytes: 20000, seed: 3 }), ansiColor({ ...geometry, bytes: 20000, seed: 3 })])
      for (const row of text(workload.data).replace(/\x1b\[[0-9;]*m/g, '').split('\r\n')) expect(row.length).toBeLessThan(geometry.cols);
  });

  it('colored text shows the same visible words as its stripped form and uses all style families', () => {
    const colored = ansiColor({ ...geometry, bytes: 30000, seed: 4 });
    const raw = text(colored.data);
    for (const sequence of [/\x1b\[3[0-7]m/, /\x1b\[9[0-7];4[0-7]m/, /\x1b\[38;5;\d+m/, /\x1b\[38;2;\d+;\d+;\d+;48;5;\d+m/, /\x1b\[1;4;3\dm/]) expect(raw).toMatch(sequence);
    expect(colored.screen).toEqual(screenOf(raw, geometry.rows));
  });

  it('full-screen redraws end on the last frame and place each row absolutely', () => {
    const w = fullScreenRedraw({ ...geometry, frames: 5, seed: 5 });
    expect(w.screen).toHaveLength(geometry.rows);
    expect(w.screen[0]).toMatch(/^frame 4 row 1 /);
    expect(text(w.data).split('\x1b[H')).toHaveLength(6);
  });

  it('shell sessions end on the last prompt and fit a phone-width terminal', () => {
    const { bursts, screen } = shellSession(10, geometry, 6);
    expect(bursts).toHaveLength(10);
    expect(screen.filter(Boolean).at(-1)).toBe('$');
    const narrow = shellSession(50, { cols: 30, rows: 24 }, 6);
    for (const row of narrow.bursts.join('').split('\r\n')) expect(row.length).toBeLessThan(30 + 2);
  });

  it('splits data into 16 KiB chunks without losing or reordering bytes', () => {
    const data = plainText({ ...geometry, bytes: 50000, seed: 7 }).data;
    const parts = chunks(data);
    expect(parts.slice(0, -1).every(part => part.length === 16384)).toBe(true);
    expect(Uint8Array.from(parts.flatMap(part => [...part]))).toEqual(data);
  });

  it('summarizes percentiles by interpolation and medians numeric leaves across runs', () => {
    expect(summarize([])).toBeNull();
    const s = summarize([4, 1, 3, 2, 5])!;
    expect(s).toMatchObject({ n: 5, min: 1, p50: 3, max: 5, mean: 3 });
    expect(summarize([0, 10])!.p50).toBe(5);
    expect(medianOf([{ a: 1, b: { c: 10 }, ok: true }, { a: 5, b: { c: 30 }, ok: true }, { a: 3, b: { c: 20 }, ok: true }])).toEqual({ a: 3, b: { c: 20 }, ok: true });
  });
});
