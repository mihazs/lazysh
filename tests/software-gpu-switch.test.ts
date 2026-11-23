import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project, spawnText } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'software-gpu-switch.sh');
const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));

const withSwitch = Buffer.concat([Buffer.alloc(64, 1), Buffer.from('LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU\0'), Buffer.alloc(64, 2)]);
const without = Buffer.alloc(200, 3);

/** An APK is a zip with the library of each ABI under lib/; python's zipfile makes one on any runner. */
async function apk(libraries: Record<string, Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-gpu-switch-test-'));
  temporary.push(root);
  for (const [abi, bytes] of Object.entries(libraries)) {
    await mkdir(join(root, 'lib', abi), { recursive: true });
    await writeFile(join(root, 'lib', abi, 'liblazysh_lib.so'), bytes);
  }
  await writeFile(join(root, 'classes.dex'), 'dex');
  const file = join(root, 'app.apk');
  expect((await spawnText(root, ['python3', '-m', 'zipfile', '-c', file, 'lib', 'classes.dex'])).code).toBe(0);
  return { root, file };
}

test('a debug library carries the switch and a release APK, in every ABI, does not', async () => {
  const debug = await apk({ x86_64: withSwitch });
  expect(await spawnText(project, ['sh', script, 'present', join(debug.root, 'lib/x86_64/liblazysh_lib.so')])).toMatchObject({ code: 0 });
  const release = await apk({ 'arm64-v8a': without, 'x86_64': without });
  expect(await spawnText(project, ['sh', script, 'absent', release.file])).toMatchObject({ code: 0 });
});

test('the wrong answer fails and names the artifact, for either expectation', async () => {
  const leaking = await apk({ 'arm64-v8a': without, 'x86_64': withSwitch });
  const absent = await spawnText(project, ['sh', script, 'absent', leaking.file]);
  expect(absent.code).toBe(1);
  expect(absent.stderr).toContain('lib/x86_64/liblazysh_lib.so: the switch is present, it must be absent');
  const control = await spawnText(project, ['sh', script, 'present', join(leaking.root, 'lib/arm64-v8a/liblazysh_lib.so')]);
  expect(control.code).toBe(1);
  expect(control.stderr).toContain('the switch is absent, it must be present');
});

test('an APK or path with no library is a failure, never a pass', async () => {
  const empty = await apk({});
  expect((await spawnText(project, ['sh', script, 'absent', empty.file])).code).toBe(1);
  const missing = await spawnText(project, ['sh', script, 'absent', join(empty.root, 'nothing.so')]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('No library at');
});
