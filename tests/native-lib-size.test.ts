import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, spawnText } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'native-lib-size.sh');
const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));

/** A checkout whose x86_64 library is a symlink to a cargo output, as `tauri android build` leaves it, and an NDK whose llvm-strip keeps the first 40 bytes. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-lib-size-test-'));
  temporary.push(root);
  const jni = join(root, 'checkout', 'apps/client/src-tauri/gen/android/app/src/main/jniLibs/x86_64');
  const strip = join(root, 'ndk', 'toolchains/llvm/prebuilt/linux-x86_64/bin');
  await mkdir(jni, { recursive: true });
  await mkdir(strip, { recursive: true });
  await writeFile(join(root, 'liblazysh_lib.so'), Buffer.alloc(1000, 7));
  await symlink(join(root, 'liblazysh_lib.so'), join(jni, 'liblazysh_lib.so'));
  await writeFile(join(strip, 'llvm-strip'), '#!/bin/sh\n[ "$1" = --strip-unneeded ] && [ "$2" = -o ] || exit 2\nhead -c 40 "$4" > "$3"\n', { mode: 0o755 });
  return { root, checkout: join(root, 'checkout'), env: { ...process.env, NDK_HOME: join(root, 'ndk'), GITHUB_STEP_SUMMARY: join(root, 'summary.md') } };
}

test('the library of an ABI is measured as built and stripped, printed and added to the job summary', async () => {
  const { checkout, env, root } = await fixture();
  const result = await spawnText(project, ['sh', script, 'x86_64', checkout], env);
  expect(result).toMatchObject({ code: 0, stderr: '', stdout: 'liblazysh_lib.so x86_64: built 1000 bytes, stripped 40 bytes\n' });
  expect(await readFile(join(root, 'summary.md'), 'utf8')).toBe('- liblazysh_lib.so x86_64: built 1000 bytes, stripped 40 bytes\n');
});

test('an ABI that was not built fails and prints no size', async () => {
  const { checkout, env, root } = await fixture();
  const result = await spawnText(project, ['sh', script, 'arm64-v8a', checkout], env);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('No arm64-v8a library');
  expect(await readFile(join(root, 'summary.md'), 'utf8').catch(() => '')).toBe('');
});

test('a failing strip fails the measurement instead of reporting an unstripped size', async () => {
  const { checkout, env } = await fixture();
  const result = await spawnText(project, ['sh', script, 'x86_64', checkout], { ...env, NDK_HOME: join(checkout, 'missing') });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe('');
});
