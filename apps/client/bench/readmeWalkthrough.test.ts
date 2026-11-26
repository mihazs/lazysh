import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { findFont, LAYOUT, renderWalkthrough, timeline, validateScenes, wrap, type Scene } from './readmeWalkthrough';

// The tour is rendered from a synthetic card, a red still and a blue clip at a tenth of the real size, then single pixels are read back, so
// what the test asserts is what is on screen at a given second. ffmpeg, ffprobe and a bold font are needed (the runbook lists them).
const has = (tool: string) => spawnSync(tool, ['-version']).status === 0;
const font = (() => { try { return findFont(); } catch { return undefined; } })();
const tools = has('ffmpeg') && has('ffprobe') && !!font;
const small = { width: 180, picture: 400, band: 60 };
const scenes: Scene[] = [
  { kind: 'card', duration: 1.4, title: 'demo', subtitle: 'a card', transition: 'fade' },
  { kind: 'image', file: 'red.png', duration: 1.6, caption: 'A red still that moves', keyframes: [{ t: 0, zoom: 1, x: 0.5, y: 0.5 }, { t: 1, zoom: 1.5, x: 0.5, y: 0.5 }] },
  { kind: 'clip', file: 'blue.mp4', start: 0.2, duration: 1.6, caption: 'A blue clip' },
];
let dir: string, output: string;
const pixel = (at: number, x: number, y: number) =>
  [...spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', output, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-']).stdout];

describe('the tour as a timeline', () => {
  test('scenes overlap by one transition at every join', () => {
    const { starts, offsets, total } = timeline(scenes, 0.6);
    expect(starts).toEqual([0, 0.8, 1.8]);
    expect(offsets).toEqual([0.8, 1.8]);
    expect(total).toBeCloseTo(1.4 + 1.6 + 1.6 - 1.2, 6);
  });
  test('a scene shorter than two transitions, a missing caption or a keyframe past the end is refused', () => {
    expect(() => validateScenes([scenes[0], { ...scenes[2], duration: 1 } as Scene], 0.6)).toThrow('longer than two transitions');
    expect(() => validateScenes([scenes[0], { ...scenes[2], caption: '' } as Scene], 0.6)).toThrow('caption');
    expect(() => validateScenes([scenes[0], { ...(scenes[1] as Scene & { kind: 'image' }), keyframes: [{ t: 9, zoom: 1, x: 0.5, y: 0.5 }] }], 0.6)).toThrow('after the end');
    expect(() => validateScenes([scenes[0]], 0.6)).toThrow('at least two');
  });
  test('captions wrap before they outgrow the picture and keep the lines they were given', () => {
    expect(wrap('Pick your terminal engine: Auto, Native or xterm.js')).toBe('Pick your terminal\nengine: Auto, Native or\nxterm.js');
    expect(wrap('Free and open source\ngithub.com/mihazs/lazysh')).toBe('Free and open source\ngithub.com/mihazs/lazysh');
    expect(wrap('Short')).toBe('Short');
  });
  test('the font is the one named, or the first common one that exists', () => {
    expect(findFont({ README_FONT: '/x/Bold.ttf' }, path => path === '/x/Bold.ttf')).toBe('/x/Bold.ttf');
    expect(() => findFont({}, () => false)).toThrow('README_FONT');
  });
  test('the committed tour is valid and 25 to 45 seconds long', async () => {
    const committed = (await import('./readme-demo/walkthrough.json')).default as Scene[];
    validateScenes(committed, LAYOUT.xfade);
    expect(timeline(committed, LAYOUT.xfade).total).toBeGreaterThanOrEqual(25);
    expect(timeline(committed, LAYOUT.xfade).total).toBeLessThanOrEqual(45);
  });
});

describe.skipIf(!tools)('the rendered tour', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'readme-walkthrough-test-'));
    output = join(dir, 'tour.mp4');
    const made = [
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=90x200', '-frames:v', '1', join(dir, 'red.png')]),
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=90x200:r=30:d=3', '-pix_fmt', 'yuv420p', join(dir, 'blue.mp4')]),
    ];
    expect(made.map(done => done.status)).toEqual([0, 0]);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('is H.264 at the asked size and 30 frames per second, as long as the timeline says, with the web player first', () => {
    const { bytes, seconds } = renderWalkthrough(scenes, dir, output, { layout: small });
    expect(bytes).toBe(statSync(output).size);
    const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration', '-of', 'csv=p=0', output]).stdout.toString().trim().split('\n');
    expect(out[0]).toBe('h264,180,460,30/1');
    expect(Number(out[1])).toBeCloseTo(seconds, 1);
    expect(spawnSync('head', ['-c', '4096', output]).stdout.includes('moov')).toBe(true);
  });
  test('shows the card, then the still, then the clip, and a blend while one replaces the other', () => {
    const dark = pixel(0.3, 10, 10), red = pixel(1.6, 90, 200), blue = pixel(3.0, 90, 200), mid = pixel(1.2, 90, 200);
    expect(dark.every(channel => channel < 40)).toBe(true);
    expect(red[0]).toBeGreaterThan(200); expect(red[2]).toBeLessThan(60);
    expect(blue[2]).toBeGreaterThan(200); expect(blue[0]).toBeLessThan(60);
    // Within the first join (the card fading to the still) the picture is neither the card nor the still.
    expect(mid[0]).toBeGreaterThan(30); expect(mid[0]).toBeLessThan(230);
  });
  test('puts the caption in the band under the picture and nothing there before it fades in', () => {
    const band = (at: number) => Math.max(...[...Array(18).keys()].flatMap(i => pixel(at, 20 + i * 8, 430)));
    expect(band(1.9)).toBeGreaterThan(120);   // the red still's caption, fully in
    expect(band(0.9)).toBeLessThan(120);       // the join where the card's caption is gone and the next one has not come
  });
  test('a tour that cannot fit its budget is refused and leaves no file', () => {
    const big = join(dir, 'big.mp4');
    expect(() => renderWalkthrough(scenes, dir, big, { layout: small, maxBytes: 10 })).toThrow('does not fit');
    expect(() => statSync(big)).toThrow();
  });
  test('a missing source is named', () => {
    expect(() => renderWalkthrough([scenes[0], { ...(scenes[2] as Scene & { kind: 'clip' }), file: 'nope.mp4' }], dir, join(dir, 'x.mp4'), { layout: small })).toThrow('nope.mp4');
  });
});
