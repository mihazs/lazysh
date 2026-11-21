import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFixtureRoots, project } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'speech-fixtures.sh');
const roots = gitFixtureRoots('lazysh-speech-fixtures-test-');
afterAll(() => roots.cleanup());

/** Run the script with a fake curl that writes `served` to its -o target and exits with `curlExit`. */
async function fetchFixture(name: string, { served = 'replaced bytes', curlExit = 0 } = {}) {
  const { root } = await roots.create();
  const bin = join(root, 'bin'), calls = join(root, 'calls'), directory = join(root, 'fixtures');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\nfor target; do :; done\nprintf \'%s\' "$SERVED" > "$target"\nexit "$CURL_EXIT"\n');
  await chmod(join(bin, 'curl'), 0o700);
  const child = Bun.spawn(['sh', script, directory, name], { cwd: project, stdout: 'pipe', stderr: 'inherit',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SERVED: served, CURL_EXIT: String(curlExit) } });
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const called = await Bun.file(calls).text().catch(() => '');
  return { exit, stdout, called, file: await Bun.file(join(directory, name)).exists() };
}

test('an unknown fixture is refused before anything is downloaded', async () => {
  expect(await fetchFixture('other.bin')).toMatchObject({ exit: 2, called: '', file: false, stdout: '::error::Unknown speech fixture other.bin\n' });
});

test('a download that no longer matches its pinned size and digest fails naming the fixture', async () => {
  const result = await fetchFixture('jfk.wav');
  expect(result.exit).toBe(1);
  expect(result.stdout).toContain('::error::jfk.wav: https://raw.githubusercontent.com/ggml-org/whisper.cpp/');
  expect(result.stdout).toContain('no longer matches its pinned 352078 bytes and SHA-256 59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e');
  expect(result.called).toContain('--max-filesize 352078 https://raw.githubusercontent.com/ggml-org/whisper.cpp/');
});

test('a publisher that serves more bytes than the pin is reported against the pinned size', async () => {
  const result = await fetchFixture('jfk.wav', { curlExit: 63 });
  expect(result.exit).toBe(63);
  expect(result.stdout).toContain('::error::jfk.wav: https://raw.githubusercontent.com/ggml-org/whisper.cpp/');
  expect(result.stdout).toContain('is larger than its pinned 352078 bytes');
});
