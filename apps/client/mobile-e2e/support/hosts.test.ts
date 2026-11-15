import {afterEach, beforeEach, expect, test} from 'bun:test';
import {access, readFile, stat} from 'node:fs/promises';
import {rm} from 'node:fs/promises';
import {OwnedProcess} from '../../../../tests/support/ownedProcess';
import {SshFixture, listening} from '../../../../tests/support/sshFixture';
import {adbFor} from './device';
import {createFakeAdb} from './fakeAdb';
import {defaultHostKinds, hostKinds, hostName, readEndpoint, startHosts, type Fixture} from './hosts';

const SERIAL = 'fake:5555';
const LIVE: Record<string, string> = {HERDR_SOCKET_PATH: '/live/herdr.sock', HERDR_ENV: '1', HERDR_PANE_ID: 'p-live', HERDR_TAB_ID: 't-live', HERDR_WORKSPACE_ID: 'w-live', TMUX: '/live/tmux,1,0'};
let fake: Awaited<ReturnType<typeof createFakeAdb>>;
const exists = (path: string) => access(path).then(() => true, () => false);
const reverses = async () => (await fake.read()).reverses;

beforeEach(async () => { fake = await createFakeAdb(); Object.assign(process.env, LIVE); });
afterEach(async () => { for (const name of Object.keys(LIVE)) delete process.env[name]; await rm(fake.directory, {recursive: true, force: true}); });

const stub = (port: number, events: string[], name: string, failure?: string): Fixture => ({
  ssh: {port, username: 'tester', fingerprint: 'SHA256:x', privateKey: 'KEY', prompt: 'P>'},
  stop: async () => { events.push(`${name}:stop reverses=${(await reverses()).length}`); if (failure) throw new Error(failure); },
});

test('the endpoint file is private, the real sshd is forwarded through adb and everything is gone after stop', async () => {
  const hosts = await startHosts({adb: adbFor(SERIAL, fake.binary), kinds: ['ssh'], fixtures: {ssh: async () => { const ssh = await SshFixture.start(); return {ssh, stop: () => ssh.stop()}; }}});
  const endpoint = await readEndpoint('ssh', hosts.endpointFile);
  expect((await stat(hosts.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(hosts.endpointFile)).mode & 0o777).toBe(0o600);
  expect(endpoint).toMatchObject({kind: 'ssh', host: '127.0.0.1', fingerprint: expect.stringMatching(/^SHA256:/), privateKey: expect.stringContaining('PRIVATE KEY')});
  expect(await reverses()).toEqual([`tcp:${endpoint.port}`]);
  expect(await listening(endpoint.port)).toBe(true);
  await hosts.stop();
  expect(await listening(endpoint.port)).toBe(false);
  expect(await exists(hosts.directory)).toBe(false);
  expect(await reverses()).toEqual([]);
});

test('no live Herdr or tmux variable reaches a fixture child, and the caller gets them back', async () => {
  let childKeys: string[] = [];
  const hosts = await startHosts({adb: adbFor(SERIAL, fake.binary), kinds: ['ssh'], fixtures: {ssh: async () => {
    const child = new OwnedProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))']);
    childKeys = JSON.parse(await child.finish('environment probe', 5000)) as string[];
    return stub(4101, [], 'ssh');
  }}});
  expect(childKeys.length).toBeGreaterThan(0);
  expect(childKeys.filter(key => key in LIVE)).toEqual([]);
  expect(process.env.HERDR_SOCKET_PATH).toBeUndefined();
  await hosts.stop();
  expect(Object.fromEntries(Object.keys(LIVE).map(key => [key, process.env[key]]))).toEqual(LIVE);
});

test('teardown removes the forwards first, stops the last fixture first, keeps going after a failure and reports it', async () => {
  const events: string[] = [];
  const hosts = await startHosts({adb: adbFor(SERIAL, fake.binary), kinds: ['ssh', 'herdr'], fixtures: {
    ssh: async () => stub(4201, events, 'ssh'), herdr: async () => stub(4202, events, 'herdr', 'herdr did not retire'),
  }});
  expect(await reverses()).toEqual(['tcp:4201', 'tcp:4202']);
  await expect(hosts.stop()).rejects.toThrow('Owned host teardown failed (1): herdr did not retire');
  expect(events).toEqual(['herdr:stop reverses=0', 'ssh:stop reverses=0']);
  expect(await exists(hosts.directory)).toBe(false);
});

test('a fixture that fails to start leaves nothing behind', async () => {
  const events: string[] = [];
  const before = await readFile(fake.directory + '/device.json', 'utf8');
  await expect(startHosts({adb: adbFor(SERIAL, fake.binary), kinds: ['ssh', 'tmux'], fixtures: {
    ssh: async () => stub(4301, events, 'ssh'), tmux: async () => { throw new Error('tmux binary missing'); },
  }})).rejects.toThrow('tmux binary missing');
  expect(events).toEqual(['ssh:stop reverses=0']);
  expect(await reverses()).toEqual([]);
  expect(process.env.HERDR_SOCKET_PATH).toBe(LIVE.HERDR_SOCKET_PATH);
  expect(JSON.parse(before).reverses).toEqual([]);
});

test('host names carry the run nonce, and the kinds of a run are validated', () => {
  expect(hostName('smoke', 'a1b2')).toBe('e2e-a1b2-smoke');
  expect(() => hostName('smoke', undefined)).toThrow('LAZYSH_E2E_NONCE is unset');
  expect(hostKinds('ssh, tmux')).toEqual(['ssh', 'tmux']);
  expect(() => hostKinds('ssh,zellij')).toThrow('Unknown LAZYSH_E2E_HOSTS entries: zellij');
});

test('Herdr joins the default hosts only when all three of its binaries are given', () => {
  const tools = {LAZYSH_TEST_HERDR: '/h', LAZYSH_TEST_AGENT_BIN: '/a', LAZYSH_TEST_RECEIVER_BIN: '/r'};
  expect(defaultHostKinds({})).toBe('ssh');
  expect(defaultHostKinds({...tools, LAZYSH_TEST_RECEIVER_BIN: ''})).toBe('ssh');
  expect(defaultHostKinds(tools)).toBe('ssh,herdr');
});
