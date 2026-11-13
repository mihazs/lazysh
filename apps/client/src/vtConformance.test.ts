// @vitest-environment jsdom
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {dense, fixturesDir, observeXterm, observeXtermKey, observeXtermMouse, sparse, type Fixture, type KeyFixture, type MouseFixture} from './vtConformance';

// The same fixtures are replayed by the Rust core (packages/terminal-runtime/tests/vt_fixtures.rs).
// This side pins what xterm.js 5.5.0 does today; UPDATE_VT_FIXTURES=1 rewrites `expect` from xterm,
// and the diff is then reviewed like any other change.
const dir = join(fixturesDir, 'vt');
const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();

describe.each(files)('xterm.js 5.5.0 on %s', file => {
  const fixtures: Fixture[] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  it.each(fixtures.map(fixture => [fixture.id, fixture] as const))('%s', async (_id, fixture) => {
    const observed = await observeXterm(fixture);
    if (process.env.UPDATE_VT_FIXTURES) {
      fixture.expect = sparse(observed);
      writeFileSync(join(dir, file), `${JSON.stringify(fixtures, null, 2)}\n`);
      return;
    }
    expect(observed).toEqual(dense(fixture.expect));
  });
});

/** Fixtures whose `expect` is what xterm sends (one string per fixture, or per event for mouse). */
function describeSent<T extends {id: string; expect: unknown}>(title: string, name: string, observe: (fixture: T) => Promise<T['expect']>) {
  describe(title, () => {
    const file = join(fixturesDir, name);
    const fixtures: T[] = JSON.parse(readFileSync(file, 'utf8'));
    it.each(fixtures.map(fixture => [fixture.id, fixture] as const))('%s', async (_id, fixture) => {
      const sent = await observe(fixture);
      if (process.env.UPDATE_VT_FIXTURES) {
        fixture.expect = sent;
        writeFileSync(file, `${JSON.stringify(fixtures, null, 2)}\n`);
        return;
      }
      expect(sent).toEqual(fixture.expect);
    });
  });
}

describeSent<KeyFixture>('xterm.js 5.5.0 key encoding', 'keys.json', observeXtermKey);
describeSent<MouseFixture>('xterm.js 5.5.0 mouse reports', 'mouse.json', observeXtermMouse);

describe('Mosh frame fixtures', () => {
  const captured = JSON.parse(readFileSync(join(__dirname, '../e2e/fixtures/mosh-resize-frames.json'), 'utf8')) as {
    frames: {frameId: number; bytesHex: string; expectedCursor: [number, number]; expectedLongRow: string; expectedFirstRowBoldRed: boolean}[];
  };
  // Frames 4, 5 and 7 differ from 3, 2 and 6 only in the resize sequence around the same redraw; the e2e
  // spec covers those against moshResize, and replaying them here would only duplicate these screens.
  const fixtures: Fixture[] = JSON.parse(readFileSync(join(dir, 'mosh-frames.json'), 'utf8'));
  it.each(captured.frames.filter(frame => [2, 3, 6].includes(frame.frameId)).map(frame => [frame.frameId, frame] as const))('frame %s is the e2e capture and meets its expectations', (_id, frame) => {
    const fixture = fixtures.find(candidate => candidate.id === `mosh-frame-${frame.frameId}`)!;
    const bytes = fixture.steps.flatMap(step => ('writeBase64' in step ? [step.writeBase64] : []));
    expect(Buffer.from(bytes[0], 'base64').toString('hex')).toBe(frame.bytesHex);
    expect(fixture.expect.cursor).toEqual({x: frame.expectedCursor[0], y: frame.expectedCursor[1]});
    expect(fixture.expect.lines![1]).toContain(frame.expectedLongRow);
    expect(fixture.expect.cells![0].flags).toContain('bold');
    expect(fixture.expect.cells![0].fg).toBe('p:1');
  });
});
