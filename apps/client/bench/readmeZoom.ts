// Eased zoom-and-pan over a screen recording, for the README clips (runbook: docs/how-to/capture-readme-media.md).
// A clip is a raw `screenrecord` video plus keyframes {t, zoom, x, y}: at time t (seconds) the view is `zoom` times closer (1 = the whole
// frame) and centred on (x, y), both as a fraction of the frame. Between two keyframes the view eases in and out (smoothstep), and
// before the first or after the last it holds. ffmpeg draws it with zoompan on a 2x upscaled frame, at a steady frame rate.
//   bun readmeZoom.ts --in raw.mp4 --keyframes keyframes.json --out clip.mp4 [--crop-top PX] [--crop-bottom PX] [--width 540] [--fps 30] [--max-kb 5120]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Keyframe { t: number; zoom: number; x: number; y: number }
export interface View { zoom: number; x: number; y: number }

export const smoothstep = (u: number) => u * u * (3 - 2 * u);

export function validateKeyframes(keyframes: Keyframe[]): void {
  if (keyframes.length === 0) throw new Error('keyframes: at least one is needed');
  keyframes.forEach((k, i) => {
    if (![k.t, k.zoom, k.x, k.y].every(Number.isFinite)) throw new Error(`keyframes[${i}]: t, zoom, x and y must be numbers`);
    if (k.t < 0) throw new Error(`keyframes[${i}]: t must not be negative`);
    if (k.zoom < 1 || k.zoom > 4) throw new Error(`keyframes[${i}]: zoom must be between 1 and 4`);
    if (k.x < 0 || k.x > 1 || k.y < 0 || k.y > 1) throw new Error(`keyframes[${i}]: x and y are fractions of the frame, between 0 and 1`);
    if (i > 0 && k.t <= keyframes[i - 1].t) throw new Error(`keyframes[${i}]: t must increase`);
  });
}

/** The view at time t: held before the first keyframe and after the last, eased in between. */
export function viewAt(keyframes: Keyframe[], t: number): View {
  const first = keyframes[0], last = keyframes[keyframes.length - 1];
  if (t <= first.t) return { zoom: first.zoom, x: first.x, y: first.y };
  if (t >= last.t) return { zoom: last.zoom, x: last.x, y: last.y };
  const i = keyframes.findIndex(k => k.t > t), a = keyframes[i - 1], b = keyframes[i];
  const e = smoothstep((t - a.t) / (b.t - a.t));
  return { zoom: a.zoom + (b.zoom - a.zoom) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}

/** The visible rectangle as fractions of the frame, kept inside it: the view cannot show what is outside the recording. */
export function visibleRect(view: View) {
  const size = 1 / view.zoom;
  const left = Math.min(Math.max(view.x - size / 2, 0), 1 - size), top = Math.min(Math.max(view.y - size / 2, 0), 1 - size);
  return { left, top, size };
}

// The same piecewise easing as an ffmpeg expression over `in_time`; `pick` chooses the keyframe field.
const num = (value: number) => value.toFixed(6);
function expression(keyframes: Keyframe[], pick: (k: Keyframe) => number): string {
  let out = num(pick(keyframes[keyframes.length - 1]));
  for (let i = keyframes.length - 1; i > 0; i--) {
    const a = keyframes[i - 1], b = keyframes[i];
    const u = `(in_time-${num(a.t)})/${num(b.t - a.t)}`;
    out = `if(lt(in_time,${num(b.t)}),${num(pick(a))}+${num(pick(b) - pick(a))}*(${u})*(${u})*(3-2*(${u})),${out})`;
  }
  return `if(lt(in_time,${num(keyframes[0].t)}),${num(pick(keyframes[0]))},${out})`;
}

export interface FilterOptions { cropTop?: number; cropBottom?: number; width?: number; fps?: number; scale?: number }
/** The ffmpeg filter chain (one line; written to a script file because the expressions hold commas). */
export function zoomFilter(keyframes: Keyframe[], source: { width: number; height: number }, options: FilterOptions = {}): string {
  validateKeyframes(keyframes);
  const { cropTop = 0, cropBottom = 0, fps = 30, scale = 2 } = options;
  const height = source.height - cropTop - cropBottom;
  if (height <= 0) throw new Error('the crops leave no picture');
  const width = even(options.width ?? source.width), outHeight = even(Math.round(height * width / source.width));
  const z = expression(keyframes, k => k.zoom);
  // zoompan places the window by its top-left corner, in pixels of the upscaled frame; clip keeps it inside the frame.
  const x = `clip((${expression(keyframes, k => k.x)})*iw-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip((${expression(keyframes, k => k.y)})*ih-ih/zoom/2,0,ih-ih/zoom)`;
  return [
    `crop=iw:${height}:0:${cropTop}`, `fps=${fps}`, `scale=iw*${scale}:ih*${scale}:flags=bicubic`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${outHeight}:fps=${fps}`, 'format=yuv420p',
  ].join(',');
}
const even = (n: number) => Math.round(n / 2) * 2;

function probe(file: string) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [width, height] = out.stdout.toString().trim().split(',').map(Number);
  if (!width || !height) throw new Error(`cannot read the size of ${file}`);
  return { width, height };
}

/** Renders the clip; tries a lower quality until the file fits `maxBytes` and fails when none does. */
export function renderClip(input: string, keyframes: Keyframe[], output: string, options: FilterOptions & { maxBytes?: number } = {}): number {
  const work = mkdtempSync(join(tmpdir(), 'readme-zoom-'));
  try {
    const script = join(work, 'filter.txt');
    writeFileSync(script, zoomFilter(keyframes, probe(input), options));
    for (const crf of [24, 28, 32, 36]) {
      const done = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-/vf', script, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
        '-movflags', '+faststart', '-r', String(options.fps ?? 30), output]);
      if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr.toString().trim()}`);
      const size = statSync(output).size;
      if (size <= (options.maxBytes ?? 5 * 1024 * 1024)) return size;
    }
    rmSync(output, { force: true });
    throw new Error(`${output} does not fit ${options.maxBytes ?? 5 * 1024 * 1024} bytes even at crf 36; use a shorter clip`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith('readmeZoom.ts')) {
  const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((pairs, item, i, all) => (item.startsWith('--') ? [...pairs, [item.slice(2), all[i + 1]]] : pairs), []));
  if (!args.in || !args.keyframes || !args.out) { console.error('usage: readmeZoom.ts --in raw.mp4 --keyframes keyframes.json --out clip.mp4 [--crop-top PX] [--crop-bottom PX] [--width 540] [--fps 30] [--max-kb 5120]'); process.exit(2); }
  try {
    const size = renderClip(args.in, JSON.parse(readFileSync(args.keyframes, 'utf8')), args.out, {
      cropTop: Number(args['crop-top'] ?? 0), cropBottom: Number(args['crop-bottom'] ?? 0), width: Number(args.width ?? 540), fps: Number(args.fps ?? 30),
      maxBytes: Number(args['max-kb'] ?? 5120) * 1024,
    });
    console.error(`readmeZoom: ${args.out}: ${size} bytes`);
  } catch (error) { console.error(`readmeZoom: ${(error as Error).message}`); process.exit(1); }
}
