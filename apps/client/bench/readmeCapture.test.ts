import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// readme-capture.sh runs against a stub adb that serves prepared files; magick and ffmpeg are the real ones, so the size budgets are real.
// What it cannot show is the guest: the runbook (docs/how-to/capture-readme-media.md) covers that.
const script = fileURLToPath(new URL('./readme-capture.sh', import.meta.url));
// The script needs ImageMagick 7 and ffmpeg; a machine without them cannot run these cases (the runbook lists both as requirements).
const has = (tool: string, flag: string) => spawnSync(tool, [flag]).status === 0;
const tools = has('magick', '-version') && has('ffmpeg', '-version') && has('ffprobe', '-version');
let root: string, stubs: string, simple: string, noisy: string, video: string;

const run = (args: string[], env: Record<string, string> = {}) => {
  const done = spawnSync('sh', [script, ...args], {
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ADB: 'adb', README_MEDIA_OUT: join(root, 'out'), STUB_PNG: simple, STUB_VIDEO: video, ...env },
  });
  return { code: done.status, stderr: done.stderr.toString() };
};
const files = async () => (await readdir(join(root, 'out')).catch(() => [])).sort();

beforeAll(async () => {
  if (!tools) return;
  root = await mkdtemp(join(tmpdir(), 'readme-capture-'));
  stubs = join(root, 'bin');
  await mkdir(stubs);
  await writeFile(join(stubs, 'adb'), `#!/bin/sh
[ "$1" != -s ] || shift 2
case "$1" in
  get-state) echo device ;;
  exec-out) cat "$STUB_PNG" ;;
  shell) ;;
  pull) cp "$STUB_VIDEO" "$3" ;;
esac
`);
  await chmod(join(stubs, 'adb'), 0o755);
  simple = join(root, 'simple.png');
  noisy = join(root, 'noisy.png');
  video = join(root, 'clip.mp4');
  // A flat 1080x2400 screen with a text-like band fits; full-colour noise cannot fit 300 KB at any step of the ladder.
  expect(spawnSync('magick', ['-size', '1080x2400', 'xc:#1e1e2e', '-fill', '#cdd6f4', '-draw', 'rectangle 40,200 1040,260', simple]).status).toBe(0);
  expect(spawnSync('magick', ['-size', '1080x2400', 'xc:gray', '+noise', 'Random', noisy]).status).toBe(0);
  expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x1200:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', video]).status).toBe(0);
});
afterAll(() => (root ? rm(root, { recursive: true, force: true }) : undefined));

describe.skipIf(!tools)('readme-capture.sh', () => {
  test('a screenshot is written as <name>.png inside the PNG budget', async () => {
    const result = run(['shot', 'sessions']);
    expect(result.code).toBe(0);
    expect(await files()).toEqual(['sessions.png']);
    expect((await stat(join(root, 'out', 'sessions.png'))).size).toBeLessThanOrEqual(300 * 1024);
  });

  test('a screenshot that cannot fit the budget fails and leaves no file', async () => {
    const result = run(['shot', 'noisy'], { STUB_PNG: noisy, README_PNG_MAX_KB: '20' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not fit');
    expect(await files()).not.toContain('noisy.png');
  });

  test('cropping removes the status and navigation bars from the result', async () => {
    const result = run(['shot', 'cropped'], { README_CROP_TOP: '100', README_CROP_BOTTOM: '200' });
    expect(result.code).toBe(0);
    const size = spawnSync('magick', ['identify', '-format', '%wx%h', join(root, 'out', 'cropped.png')]).stdout.toString();
    expect(size).toBe('1080x2100');
  });

  test('a recording becomes a GIF inside the GIF budget', async () => {
    const result = run(['gif', 'open-session', '2']);
    expect(result.code).toBe(0);
    const gif = join(root, 'out', 'open-session.gif');
    expect((await stat(gif)).size).toBeLessThanOrEqual(4096 * 1024);
    expect(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', gif]).stdout.toString().trim()).toBe('gif');
  });

  test('a GIF over the budget at every step fails', () => {
    const result = run(['gif-from', 'too-big', video], { README_GIF_MAX_KB: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not fit');
  });

  test.each(['Bad Name', '-lead', 'trail-', 'two--hyphens', 'Upper', '../escape', ''])('the name %j is refused before any capture', name => {
    expect(run(['shot', name]).code).toBe(2);
  });

  test('an unreachable guest is exit 3, not a blank image', () => {
    const result = run(['shot', 'offline'], { ADB: 'no-such-adb' });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('adb is not installed');
  });

  test('check passes for files inside budget and names every violation', async () => {
    expect(run(['check']).code).toBe(0);
    await writeFile(join(root, 'out', 'Bad_Name.png'), 'x');
    await writeFile(join(root, 'out', 'huge.gif'), Buffer.alloc(6 * 1024 * 1024));
    await writeFile(join(root, 'out', 'clip.webm'), 'x');
    await writeFile(join(root, 'out', 'long-demo.mp4'), Buffer.alloc(6 * 1024 * 1024));
    const result = run(['check']);
    expect(result.code).toBe(1);
    for (const message of ['Bad_Name.png: bad name', 'huge.gif', 'over the', 'clip.webm: only .png, .gif and .mp4', 'long-demo.mp4']) expect(result.stderr).toContain(message);
  });
});
