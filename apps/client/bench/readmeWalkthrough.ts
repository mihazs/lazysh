// One guided tour of the app for the README, assembled from the real captures (runbook: docs/how-to/capture-readme-media.md).
// A scene is a title card, a still image or a clip. Stills move with the keyframed ease-in/out zoom of readmeZoom.ts; clips keep the zoom they
// were recorded with. Every scene gets a caption in a band under the picture, and scenes join with ffmpeg's xfade (a zoom-through by default).
//   bun readmeWalkthrough.ts --scenes readme-demo/walkthrough.json --dir docs/assets/readme --out walkthrough.mp4 [--max-kb 5120]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { flags, type Keyframe, probe, validateKeyframes, zoomFilter } from './readmeZoom';

export type Scene =
  | { kind: 'card'; duration: number; title: string; subtitle?: string; transition?: string }
  | { kind: 'image'; file: string; duration: number; caption: string; keyframes: Keyframe[]; transition?: string }
  | { kind: 'clip'; file: string; start?: number; duration: number; caption: string; transition?: string };

export interface Layout { width: number; picture: number; band: number; fps: number; xfade: number; background: string; font: string }
/** 540 x 1100 is the app's own picture (a 1080 x 2198 screen without its bars at half size); the band under it holds the caption. */
export const LAYOUT: Omit<Layout, 'font'> = { width: 540, picture: 1100, band: 140, fps: 30, xfade: 0.6, background: '0x0b0f1a' };

const FONTS = ['/usr/share/fonts/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf'];
/** README_FONT names a bold sans-serif font file; without it the first of a few common ones is used. */
export function findFont(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  const font = env.README_FONT ?? FONTS.find(exists);
  if (!font || !exists(font)) throw new Error('no bold sans-serif font found: set README_FONT to a .ttf file');
  return font;
}

/** Where each scene starts in the finished video and how long the video is: scenes overlap by `xfade` seconds at every join. */
export function timeline(scenes: Scene[], xfade: number) {
  const starts: number[] = [];
  let at = 0;
  for (const scene of scenes) { starts.push(Number(at.toFixed(6))); at += scene.duration - xfade; }
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0) - xfade * (scenes.length - 1);
  // The xfade offset of join i (between scene i and i+1) is the start of scene i+1 in the finished video.
  return { starts, offsets: starts.slice(1), total: Number(total.toFixed(6)) };
}

export function validateScenes(scenes: Scene[], xfade: number): void {
  if (scenes.length < 2) throw new Error('scenes: a walk-through needs at least two scenes');
  scenes.forEach((scene, i) => {
    const label = `scenes[${i}]`;
    if (!(scene.duration > 2 * xfade)) throw new Error(`${label}: duration must be longer than two transitions (${2 * xfade} s)`);
    if (scene.kind === 'card') { if (!scene.title) throw new Error(`${label}: a card needs a title`); return; }
    if (!scene.caption) throw new Error(`${label}: a caption is needed`);
    if (!scene.file) throw new Error(`${label}: a file is needed`);
    if (scene.kind === 'image') {
      validateKeyframes(scene.keyframes);
      if (scene.keyframes[scene.keyframes.length - 1].t > scene.duration) throw new Error(`${label}: a keyframe lies after the end of the scene`);
    }
    if (scene.kind === 'clip' && (scene.start ?? 0) < 0) throw new Error(`${label}: start must not be negative`);
  });
}

/** Greedy word wrap, so a caption is never wider than the 540 px picture (about 24 bold characters at the caption's size). */
export function wrap(text: string, max = 24): string {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// drawtext reads its text from a file, so quoting never touches the caption; only the file path and the expressions are in the graph.
const q = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const fade = (duration: number, edge = 0.35) => `alpha='if(lt(t,${edge}),t/${edge},if(gt(t,${(duration - edge).toFixed(3)}),(${duration.toFixed(3)}-t)/${edge},1))'`;

export interface SceneGraph { filters: string[]; textFiles: Record<string, string>; inputs: string[][] }

/** The filtergraph of the whole tour: one chain per scene ending in [sI], then the xfade joins ending in [out]. */
export function buildGraph(scenes: Scene[], layout: Layout, sources: (file: string) => { width: number; height: number }, textDir: string): SceneGraph {
  validateScenes(scenes, layout.xfade);
  const { width, picture, band, fps, background, font } = layout, height = picture + band;
  const filters: string[] = [], textFiles: Record<string, string> = {}, inputs: string[][] = [];
  const text = (name: string, value: string) => { const path = join(textDir, name); textFiles[path] = value; return path; };
  scenes.forEach((scene, i) => {
    const d = scene.duration;
    const draw = (path: string, size: number, color: string, y: string) =>
      `drawtext=fontfile=${q(font)}:textfile=${q(path)}:fontsize=${size}:fontcolor=${color}:text_align=center:x=(w-text_w)/2:y=${y}:${fade(d)}`;
    let chain: string;
    if (scene.kind === 'card') {
      const title = text(`title${i}.txt`, scene.title), sub = scene.subtitle ? text(`sub${i}.txt`, scene.subtitle) : '';
      chain = `color=c=${background}:s=${width}x${height}:r=${fps}:d=${d},format=yuv420p,${draw(title, 84, 'white', `${Math.round(height * 0.34)}`)}${sub ? `,${draw(sub, 30, '0xcbd5e1', `${Math.round(height * 0.34) + 130}`)}` : ''}[s${i}]`;
    } else {
      const cap = text(`caption${i}.txt`, wrap(scene.caption));
      if (scene.kind === 'image') {
        inputs.push(['-loop', '1', '-framerate', String(fps), '-t', String(d), '-i', scene.file]);
        chain = `[${inputs.length - 1}:v]${zoomFilter(scene.keyframes, sources(scene.file), { width, fps })}`;
      } else {
        const start = scene.start ?? 0;
        inputs.push(['-i', scene.file]);
        chain = `[${inputs.length - 1}:v]trim=start=${start}:end=${start + d},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${picture}:flags=lanczos,format=yuv420p`;
      }
      chain += `,setsar=1,pad=${width}:${height}:0:0:color=${background},${draw(cap, 32, 'white', `${picture}+(${band}-text_h)/2`)}[s${i}]`;
    }
    // A card has no input; inputs only grow for stills and clips, so the label index above is the input's own index.
    filters.push(chain);
  });
  let previous = 's0';
  scenes.slice(1).forEach((scene, j) => {
    const next = j === scenes.length - 2 ? 'out' : `x${j + 1}`;
    filters.push(`[${previous}][s${j + 1}]xfade=transition=${scene.transition ?? 'zoomin'}:duration=${layout.xfade}:offset=${timeline(scenes, layout.xfade).offsets[j]}[${next}]`);
    previous = next;
  });
  return { filters, textFiles, inputs };
}

/** Renders the tour; tries a lower quality until the file fits `maxBytes` and fails (leaving no file) when none does. */
export function renderWalkthrough(scenes: Scene[], dir: string, output: string, options: { layout?: Partial<Layout>; maxBytes?: number } = {}): { bytes: number; seconds: number } {
  const layout: Layout = { ...LAYOUT, font: findFont(), ...options.layout };
  const resolved = scenes.map(scene => ('file' in scene ? { ...scene, file: resolve(dir, scene.file) } : scene)) as Scene[];
  for (const scene of resolved) if ('file' in scene && !existsSync(scene.file)) throw new Error(`${scene.file} does not exist`);
  const work = mkdtempSync(join(tmpdir(), 'readme-walkthrough-'));
  try {
    const graph = buildGraph(resolved, layout, file => probe(file), work);
    for (const [path, value] of Object.entries(graph.textFiles)) writeFileSync(path, value);
    const script = join(work, 'graph.txt');
    // The graph is in a file because its expressions hold commas; "[out]" is the last xfade.
    writeFileSync(script, graph.filters.join(';\n'));
    const max = options.maxBytes ?? 5 * 1024 * 1024;
    for (const crf of [24, 27, 30, 33]) {
      const done = spawnSync('ffmpeg', ['-v', 'error', '-y', ...graph.inputs.flat(), '-/filter_complex', script, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'slow',
        '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(layout.fps), '-movflags', '+faststart', output]);
      if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr.toString().trim()}`);
      const bytes = statSync(output).size;
      if (bytes <= max) return { bytes, seconds: timeline(resolved, layout.xfade).total };
    }
    rmSync(output, { force: true });
    throw new Error(`${output} does not fit ${max} bytes even at crf 33; shorten the scenes`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith('readmeWalkthrough.ts')) {
  const args = flags(process.argv.slice(2));
  if (!args.scenes || !args.dir || !args.out) { console.error('usage: readmeWalkthrough.ts --scenes walkthrough.json --dir docs/assets/readme --out walkthrough.mp4 [--max-kb 5120]'); process.exit(2); }
  try {
    const scenes = JSON.parse(readFileSync(args.scenes, 'utf8')) as Scene[];
    const { bytes, seconds } = renderWalkthrough(scenes, args.dir, args.out, { maxBytes: Number(args['max-kb'] ?? 5120) * 1024 });
    console.error(`readmeWalkthrough: ${args.out}: ${bytes} bytes, ${seconds.toFixed(1)} s`);
  } catch (error) { console.error(`readmeWalkthrough: ${(error as Error).message}`); process.exit(1); }
}
