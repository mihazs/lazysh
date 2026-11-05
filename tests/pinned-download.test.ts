import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFixtureRoots, project } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'pinned-download.sh');
const pinned = 'pinned fixture bytes';
const sha = createHash('sha256').update(pinned).digest('hex');
const roots = gitFixtureRoots('lazysh-pinned-download-test-');
afterAll(() => roots.cleanup());

/** Run the helper with a fake curl that records its argv and writes `served` to its -o target. */
async function download({ cached, served = pinned, curlExit = 0 }: { cached?: string; served?: string; curlExit?: number } = {}) {
  const { root: directory } = await roots.create();
  const bin = join(directory, 'bin'), cache = join(directory, 'cache'), calls = join(directory, 'calls');
  await mkdir(bin);
  if (cached !== undefined) { await mkdir(cache); await writeFile(join(cache, sha), cached); }
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\nfor target; do :; done\nprintf \'%s\' "$SERVED" > "$target"\nexit "$CURL_EXIT"\n', { mode: 0o700 });
  const output = join(directory, 'fixture.tar.gz');
  const child = Bun.spawn(['sh', script, sha, output, '--fail', '--max-filesize', '64', 'https://example.invalid/fixture.tar.gz'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAZYSH_PINNED_DOWNLOADS: cache, CALLS: calls, SERVED: served, CURL_EXIT: String(curlExit) },
    stdout: 'pipe', stderr: 'pipe' });
  const exit = await child.exited;
  const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);
  return { exit, path: output, output: await read(output), cached: await read(join(cache, sha)), calls: (await read(calls))?.trim().split('\n') ?? [] };
}

test('a cache miss downloads with the caller curl arguments and caches only the matching bytes', async () => {
  const result = await download();
  expect(result).toMatchObject({ exit: 0, output: pinned, cached: pinned });
  expect(result.calls).toEqual([`--fail --max-filesize 64 https://example.invalid/fixture.tar.gz -o ${result.path}`]);
});

test('a matching cached copy is used without contacting the host', async () => {
  expect(await download({ cached: pinned, served: 'never served' })).toMatchObject({ exit: 0, output: pinned, cached: pinned, calls: [] });
});

test('a cached copy that no longer matches the pin is downloaded again and replaced', async () => {
  const result = await download({ cached: 'stale or tampered bytes' });
  expect(result).toMatchObject({ exit: 0, output: pinned, cached: pinned });
  expect(result.calls).toHaveLength(1);
});

test('bytes that do not match the pin reach the caller for rejection but are never cached', async () => {
  const result = await download({ served: 'changed upstream bytes' });
  expect(result).toMatchObject({ exit: 0, output: 'changed upstream bytes', cached: undefined });
  expect(result.calls).toHaveLength(1);
});

test('a failed download fails the step', async () => {
  const result = await download({ curlExit: 22 });
  expect(result.exit).toBe(22);
  expect(result.cached).toBeUndefined();
});
