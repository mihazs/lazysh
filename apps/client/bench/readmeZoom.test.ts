import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, smoothstep, validateKeyframes, viewAt, visibleRect, zoomFilter, type Keyframe } from './readmeZoom';

// The source is a 2 s video whose luma is x/width and whose blue chroma is y/height, so any pixel of the output says which part of the
// source it shows. ffmpeg and ffprobe are the real ones.
const W = 360, H = 800;
const keyframes: Keyframe[] = [{ t: 0.5, zoom: 1, x: 0.5, y: 0.5 }, { t: 1.5, zoom: 2, x: 0.75, y: 0.25 }];
// The clip cases need ffmpeg and ffprobe (the runbook lists them as requirements); the keyframe cases below do not.
const tools = ['ffmpeg', 'ffprobe'].every(tool => spawnSync(tool, ['-version']).status === 0);
let dir: string, source: string, clip: string;

const pixel = (file: string, at: number, x: number, y: number) => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=yuv444p`, '-f', 'rawvideo', '-']);
  return [...out.stdout];
};

beforeAll(() => {
  if (!tools) return;
  dir = mkdtempSync(join(tmpdir(), 'readme-zoom-test-'));
  source = join(dir, 'source.mp4');
  clip = join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=15:d=2,geq=lum='255*X/W':cb='255*Y/H':cr=128`, '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-crf', '8', source]);
  expect(made.status).toBe(0);
  renderClip(source, keyframes, clip, { width: 180, fps: 30 });
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('keyframes', () => {
  test('are validated', () => {
    expect(() => validateKeyframes([])).toThrow('at least one');
    expect(() => validateKeyframes([{ t: 0, zoom: 0.5, x: 0.5, y: 0.5 }])).toThrow('zoom');
    expect(() => validateKeyframes([{ t: 0, zoom: 2, x: 1.5, y: 0.5 }])).toThrow('fractions');
    expect(() => validateKeyframes([{ t: 1, zoom: 1, x: 0.5, y: 0.5 }, { t: 1, zoom: 2, x: 0.5, y: 0.5 }])).toThrow('increase');
  });
  test('ease in and out, hold at both ends, and never leave the frame', () => {
    expect(smoothstep(0.5)).toBe(0.5);
    expect(viewAt(keyframes, 0).zoom).toBe(1);
    expect(viewAt(keyframes, 9).zoom).toBe(2);
    expect(viewAt(keyframes, 1).zoom).toBeCloseTo(1.5, 6);
    // Slow at the start and the end: a tenth of the way in covers far less than a tenth of the change.
    expect(viewAt(keyframes, 0.6).zoom - 1).toBeLessThan(0.05);
    const near = visibleRect({ zoom: 2, x: 0.95, y: 0.02 });
    expect(near.left + near.size).toBeCloseTo(1, 9);
    expect(near.top).toBe(0);
  });
  test('the filter refuses crops that leave no picture', () => {
    expect(() => zoomFilter(keyframes, { width: W, height: H }, { cropTop: 500, cropBottom: 300 })).toThrow('no picture');
  });
});

describe.skipIf(!tools)('the rendered clip', () => {
  test('is H.264 at the asked size and frame rate, 2 s long, and starts the web player fast', () => {
    const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0', clip]);
    expect(out.stdout.toString().trim()).toBe('h264,180,400,30/1,60');
    // faststart: the moov box precedes the media data
    expect(readFileSync(clip).subarray(0, 4096).includes('moov')).toBe(true);
  });
  test('shows the whole frame before the zoom, and the asked part of it while held', () => {
    // t=0.2: whole frame: left edge luma 0, right edge 255, top chroma 0, bottom 255.
    const start = [pixel(clip, 0.2, 0, 0), pixel(clip, 0.2, 179, 399)];
    expect(start[0][0]).toBeLessThan(12); expect(start[0][1]).toBeLessThan(12);
    expect(start[1][0]).toBeGreaterThan(243); expect(start[1][1]).toBeGreaterThan(243);
    // t=1.8: zoom 2 centred on (0.75, 0.25): x from 0.5 to 1, y from 0 to 0.5.
    const held = [pixel(clip, 1.8, 0, 0), pixel(clip, 1.8, 179, 399)];
    expect(held[0][0]).toBeGreaterThan(127 - 12); expect(held[0][0]).toBeLessThan(127 + 12);
    expect(held[0][1]).toBeLessThan(12);
    expect(held[1][0]).toBeGreaterThan(243);
    expect(held[1][1]).toBeGreaterThan(127 - 12); expect(held[1][1]).toBeLessThan(127 + 12);
  });
  test('moves as the easing says in the middle of the transition', () => {
    const view = viewAt(keyframes, 1.0), rect = visibleRect(view);
    const [luma, chroma] = pixel(clip, 1.0, 0, 0);
    expect(Math.abs(luma - 255 * rect.left)).toBeLessThan(10);
    expect(Math.abs(chroma - 255 * rect.top)).toBeLessThan(10);
    const [lumaEnd] = pixel(clip, 1.0, 179, 0);
    expect(Math.abs(lumaEnd - 255 * (rect.left + rect.size))).toBeLessThan(10);
  });
  test('a clip that cannot fit its budget is refused and leaves no file', () => {
    const big = join(dir, 'big.mp4');
    expect(() => renderClip(source, keyframes, big, { width: 360, maxBytes: 10 })).toThrow('does not fit');
    expect(() => statSync(big)).toThrow();
  });
});
