import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const client = join(import.meta.dir, '..', '..');
const SERIAL = `launch-test-${process.pid}:5555`;
const lock = join('/tmp', `lazysh-mobile-e2e-${process.getuid?.() ?? 'user'}`, `lazysh-mobile-e2e-${SERIAL.replace(/[^\w.-]/g, '_')}.lock`);
let sdk: string, marker: string;

// A run whose device lock another run holds must end at once and name the holder, instead of starting workers that fail on missing hosts.
beforeEach(async () => {
  sdk = await mkdtemp(join(tmpdir(), 'lazysh-launch-test-'));
  marker = join(sdk, 'worker-started');
  await mkdir(join(sdk, 'specs'));
  await mkdir(join(lock, '..'), {recursive: true, mode: 0o700});
  // This test process is a live owner, started three minutes ago.
  await writeFile(lock, JSON.stringify({pid: process.pid, started: new Date(Date.now() - 3 * 60_000).toISOString()}), {mode: 0o600});
});
afterEach(async () => { await Promise.all([rm(sdk, {recursive: true, force: true}), rm(lock, {force: true})]); });

test('a device lock that stays held fails the whole run, naming the holder, before any worker or Appium starts', async () => {
  const spec = join(sdk, 'specs', 'marker.e2e.ts');
  await writeFile(spec, `import {writeFileSync} from 'node:fs'; describe('worker', () => { it('runs', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); }); });`);
  const run = Bun.spawn(['bun', 'run', 'wdio', 'run', 'mobile-e2e/wdio.android.conf.ts', '--spec', spec], {
    cwd: client, stdout: 'pipe', stderr: 'pipe',
    env: {...process.env, ANDROID_SERIAL: SERIAL, ANDROID_HOME: sdk, LAZYSH_E2E_LOCK_TIMEOUT_S: '2', LAZYSH_E2E_HOSTS: ''},
  });
  const [out, code] = await Promise.all([new Response(run.stdout).text().then(async text => text + await new Response(run.stderr).text()), run.exited]);
  expect(code).not.toBe(0);
  expect(out).toContain('Device is busy');
  expect(out).toContain(`pid ${process.pid}`);
  expect(out).toContain('3 min ago');
  expect(await Bun.file(marker).exists()).toBe(false);
}, 90_000);
