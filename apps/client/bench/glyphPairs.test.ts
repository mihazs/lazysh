import { describe, expect, it } from 'vitest';
import { visiblePairs } from './glyphPairs';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('visible glyph-style cells', () => {
  it('counts cells, not SGR sequences: attributes accumulate until reset', async () => {
    // Both red letters come from the same SGR sequence but the second is also bold.
    expect((await visiblePairs(bytes('\x1b[31ma\x1b[1m\x1b[31ma\x1b[0m'), 20, 5)).pairs).toBe(2);
    expect((await visiblePairs(bytes('\x1b[31ma\x1b[0m\x1b[31ma\x1b[0m'), 20, 5)).pairs).toBe(1);
  });

  it('ignores spaces, counts a screen per 16 KiB chunk and separates the last screen from the rest', async () => {
    const first = 'x'.repeat(16 * 1024 - 2) + '\r\n', second = '\x1b[2J\x1b[Hyy';
    const { frames, pairs, lastScreenPairs } = await visiblePairs(bytes(first + second), 20, 5);
    expect(frames).toBe(2);
    expect(pairs).toBe(2); // x and y
    expect(lastScreenPairs).toBe(1); // the screen was cleared before y
    expect((await visiblePairs(bytes('   \x1b[31m  '), 20, 5)).pairs).toBe(0);
  });
});
