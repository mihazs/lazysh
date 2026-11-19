import {expect, test} from 'bun:test';
import {localSyncSelection, ownedSyncEmulator, prepareSyncDevice} from './owned-sync-emulator';
import type {attestQrCamera} from '../../../../tests/support/androidQrOwnership';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hosted = {CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner',
  LAZYSH_ANDROID_QR_EMULATOR_PID_FILE: '/runner/lazysh-qr-emulator.pid'};

test('sync acceptance rejects local and incorrectly nominated devices before attestation', async () => {
  let calls = 0;
  const attest = (async () => { calls++; return {check: async () => {}}; }) as typeof attestQrCamera;
  for (const env of [{}, {...hosted, RUNNER_ENVIRONMENT: 'self-hosted'}, {...hosted, GITHUB_ACTIONS: 'false'},
    {...hosted, LAZYSH_ANDROID_QR_EMULATOR_PID_FILE: '/other/pid'}]) {
    await expect(ownedSyncEmulator(env, attest)).rejects.toThrow('owned GitHub-hosted emulator');
  }
  expect(calls).toBe(0);
  const admitted = await ownedSyncEmulator(hosted, attest);
  expect(calls).toBe(1);
  await admitted.check();
});

test('sync acceptance propagates a failed emulator attestation', async () => {
  const attest = (async () => { throw new Error('ownership failed'); }) as typeof attestQrCamera;
  await expect(ownedSyncEmulator(hosted, attest)).rejects.toThrow('ownership failed');
});

test('device setup happens only after admission for the sync case or an ambiguous override', async () => {
  const events: string[] = [];
  const admit = async () => { events.push('admit'); return {check: async () => {}}; };
  const setup = async () => { events.push('setup'); return 'device'; };
  const sync = resolve(import.meta.dir, '../specs/regression/sync/1540-encrypted-sync-webdav.e2e.ts');
  const other = resolve(import.meta.dir, 'owned-sync-emulator.test.ts');
  await prepareSyncDevice(hosted, [sync], [], setup, admit);
  expect(events).toEqual(['admit', 'setup']);
  events.length = 0;
  await expect(prepareSyncDevice({}, [other], ['--spec'], setup,
    async () => { events.push('reject'); throw new Error('not owned'); })).rejects.toThrow('not owned');
  expect(events).toEqual(['reject']);
  events.length = 0;
  expect(localSyncSelection([sync, other], {})).toEqual([other]);
  await prepareSyncDevice({}, [other], [], setup, admit);
  await prepareSyncDevice(hosted, [other], [], setup, admit);
  expect(events).toEqual(['setup', 'setup']);
  events.length = 0;
  await prepareSyncDevice({}, [other], ['--suite', 'smoke'], setup, admit, {suite: ['smoke'], suites: {smoke: [other]}});
  await prepareSyncDevice({}, [other], ['--suite', 'smoke'], setup, admit, {suite: ['smoke'], suites: {smoke: [resolve(import.meta.dir, '../specs/smoke/**/*.e2e.ts')]}});
  await prepareSyncDevice({}, [other], ['--spec', other], setup, admit, {spec: [other]});
  await prepareSyncDevice({}, [pathToFileURL(other).href], [], setup, admit);
  expect(events).toEqual(['setup', 'setup', 'setup', 'setup']);
  events.length = 0;
  await prepareSyncDevice({}, [other], ['--spec', sync], setup, admit, {spec: [sync]});
  await prepareSyncDevice({}, [pathToFileURL(sync).href], [], setup, admit);
  await prepareSyncDevice({}, [other], ['--suite', 'missing'], setup, admit, {suite: ['missing']});
  expect(events).toEqual(['admit', 'setup', 'admit', 'setup', 'admit', 'setup']);
});

test('WDIO cannot proceed to a session after a pre-session safety failure', () => {
  const root = resolve(import.meta.dir, '../../../..');
  const helper = pathToFileURL(join(import.meta.dir, 'owned-sync-emulator.ts')).href;
  const script = `import {executeHooksWithArgs} from '@wdio/utils';
    import {failClosedBeforeSession} from ${JSON.stringify(helper)};
    await executeHooksWithArgs('beforeSession', [() => failClosedBeforeSession(async () => { throw new Error('lost'); })], []);
    console.log('SESSION_STARTED');`;
  const child = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', cwd: root});
  expect(child.status).toBe(1);
  expect(child.stdout).not.toContain('SESSION_STARTED');
  expect(child.stderr).toContain('refusing to start the session');
});

test('a real WDIO worker sends no session request when pre-session admission fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazysh-wdio-gate-'));
  const requests: string[] = [];
  // Only WebDriver traffic counts: other local processes may probe a loopback port.
  const server = createServer((req, res) => {
    if (req.headers['user-agent']?.startsWith('webdriver/')) requests.push(`${req.method} ${req.url}`);
    res.writeHead(500).end('{}');
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const root = resolve(import.meta.dir, '../../../..');
  const port = (server.address() as {port: number}).port;
  try {
    const spec = join(dir, 'gate.e2e.js'), config = join(dir, 'wdio.conf.ts');
    await writeFile(spec, "describe('gate', () => { it('would create a session', () => {}); });\n");
    const helper = pathToFileURL(join(import.meta.dir, 'owned-sync-emulator.ts')).href;
    const run = async (selected: string, fail: boolean) => {
      await writeFile(config, `import {failClosedBeforeSession, prepareSyncDevice} from ${JSON.stringify(helper)};\nexport const config = {
        runner: 'local', framework: 'mocha', reporters: [], logLevel: 'error', hostname: '127.0.0.1', port: ${port}, path: '/',
        connectionRetryCount: 0, connectionRetryTimeout: 1000, specs: [${JSON.stringify(spec)}],
        capabilities: [{browserName: 'chrome'}], maxInstances: 1,
        beforeSession: (_config, _caps, specs) => failClosedBeforeSession(async () => {
          await prepareSyncDevice({}, specs, [], async () => {}); ${fail ? "throw new Error('lost');" : ''} }) };\n`);
      const child = spawn(join(root, 'node_modules/.bin/wdio'), ['run', config, '--spec', selected], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', data => { output += String(data); });
      child.stderr.on('data', data => { output += String(data); });
      return new Promise<{code: number | null; output: string}>((done, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('WDIO gate timed out')); }, 40_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); done({code, output}); });
      });
    };
    expect((await run(spec, false)).code).toBe(1);
    expect(requests).toContain('POST /session');
    requests.length = 0;
    const sync = resolve(import.meta.dir, '../specs/regression/sync/1540-encrypted-sync-webdav.e2e.ts');
    const rejected = await run(sync, false);
    expect(rejected.code).toBe(1);
    expect(rejected.output).toContain('refusing to start the session');
    expect(requests).toEqual([]);
    expect((await run(spec, true)).code).toBe(1);
    expect(requests).toEqual([]);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(dir, {recursive: true, force: true});
  }
}, 90_000);
