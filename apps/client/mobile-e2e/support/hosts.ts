import {randomBytes} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HerdrFixture, herdrTools} from '../../../../tests/support/androidHerdr';
import {TmuxFixture} from '../../../../tests/support/androidTmux';
import {SshFixture} from '../../../../tests/support/sshFixture';
import type {Adb} from './device';

// Owned SSH, Herdr and tmux hosts for the suite: the fixtures of the instrumented and desktop suites, started in onPrepare
// and reached from the guest through `adb reverse`. Nothing here ever touches a personal Herdr, tmux or SSH server.

export type HostKind = 'ssh' | 'sftp' | 'herdr' | 'herdr-agents' | 'tmux';
export const HOST_KINDS: readonly HostKind[] = ['ssh', 'sftp', 'herdr', 'herdr-agents', 'tmux'];
/** What a spec needs to reach one owned host. `privateKey` is a secret: never log it or put it on a screen that is captured. */
/** `home` is the host's home and working directory, where `~` resolves. */
export interface Endpoint {kind: HostKind; host: string; port: number; username: string; fingerprint: string; privateKey: string; prompt: string; home: string}
export interface Fixture {ssh: Pick<SshFixture, 'port' | 'username' | 'fingerprint' | 'privateKey' | 'prompt' | 'directory'>; stop(): Promise<void>}
export type FixtureFactories = Partial<Record<HostKind, () => Promise<Fixture>>>;

// Variables that point at a live Herdr or tmux. They are removed from this process while the fixtures run, so no child can inherit them.
const LIVE_VARIABLES = ['HERDR_SOCKET_PATH', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'TMUX', 'TMUX_PANE'] as const;

export const defaultFixtures: FixtureFactories = {
  ssh: async () => { const ssh = await SshFixture.start(); return {ssh, stop: () => ssh.stop()}; },
  // An SSH host with the SFTP subsystem (Files) and the long shell budget of the companion fixtures, not the 90 s of a plain shell.
  sftp: async () => { const ssh = await SshFixture.start(undefined, {companion: true}); return {ssh, stop: () => ssh.stop()}; },
  herdr: async () => { const herdr = await HerdrFixture.start(herdrTools()); return {ssh: herdr.ssh, stop: () => herdr.stop()}; },
  // Stock Herdr with a Codex conversation, a blocked and a Claude agent, and a recorded account report (see `agentsFixture`).
  'herdr-agents': async () => {
    const herdr = await HerdrFixture.start(herdrTools(), undefined, false, true);
    try { await herdr.startAgents(); } catch (error) { await herdr.stop().catch(() => undefined); throw error; }
    return {ssh: herdr.ssh, stop: () => herdr.stop()};
  },
  tmux: async () => { const tmux = await TmuxFixture.start(); return {ssh: tmux.ssh, stop: () => tmux.stop()}; },
};

export interface OwnedHosts {
  /** Per-run mode-0700 directory; holds the mode-0600 endpoint file. */
  directory: string;
  endpointFile: string;
  nonce: string;
  fixtures: Partial<Record<HostKind, Fixture>>;
  /** Removes the reverse forwards, stops the fixtures last-started first, deletes the directory, restores the environment. */
  stop(): Promise<void>;
}

export interface StartOptions {
  adb: Adb;
  kinds: readonly HostKind[];
  fixtures?: FixtureFactories;
}

export async function startHosts({adb, kinds, fixtures = defaultFixtures}: StartOptions): Promise<OwnedHosts> {
  const saved = Object.fromEntries(LIVE_VARIABLES.map(name => [name, process.env[name]]));
  for (const name of LIVE_VARIABLES) delete process.env[name];
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-mobile-e2e-run-'));
  const nonce = randomBytes(4).toString('hex');
  const started: [HostKind, Fixture][] = [], reversed: number[] = [];
  const stop = async () => {
    const failures: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    for (const port of reversed.splice(0)) await attempt(() => adb('reverse', '--remove', `tcp:${port}`));
    for (const [, fixture] of started.splice(0).reverse()) await attempt(() => fixture.stop());
    await attempt(() => rm(directory, {recursive: true, force: true}));
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    if (failures.length) throw new Error(`Owned host teardown failed (${failures.length}): ${failures.map(error => (error as Error).message).join('; ')}`);
  };
  try {
    await chmod(directory, 0o700);
    const endpoints: Partial<Record<HostKind, Endpoint>> = {};
    for (const kind of kinds) {
      const start = fixtures[kind];
      if (!start) throw new Error(`No fixture for the ${kind} host`);
      const fixture = await start();
      started.push([kind, fixture]);
      const {ssh} = fixture;
      // --no-rebind: never replace a forward somebody else owns.
      await adb('reverse', '--no-rebind', `tcp:${ssh.port}`, `tcp:${ssh.port}`);
      reversed.push(ssh.port);
      endpoints[kind] = {kind, host: '127.0.0.1', port: ssh.port, username: ssh.username, fingerprint: ssh.fingerprint, privateKey: ssh.privateKey, prompt: ssh.prompt, home: ssh.directory};
    }
    const endpointFile = join(directory, 'endpoints.json');
    await writeFile(endpointFile, JSON.stringify({nonce, endpoints}), {mode: 0o600});
    return {directory, endpointFile, nonce, fixtures: Object.fromEntries(started) as OwnedHosts['fixtures'], stop};
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

/** Worker side: where the launcher put the endpoints. */
export const ENDPOINTS_ENV = 'LAZYSH_E2E_ENDPOINTS';

export async function readEndpoint(kind: HostKind = 'ssh', file = process.env[ENDPOINTS_ENV]): Promise<Endpoint> {
  if (!file) throw new Error(`No owned hosts: the launcher did not start any (${ENDPOINTS_ENV} is unset; see LAZYSH_E2E_HOSTS)`);
  const endpoint = (JSON.parse(await readFile(file, 'utf8')) as {endpoints: Partial<Record<HostKind, Endpoint>>}).endpoints[kind];
  if (!endpoint) throw new Error(`The run did not start an owned ${kind} host (LAZYSH_E2E_HOSTS)`);
  return endpoint;
}

/** The per-run nonce the launcher chose; it makes host names and typed text unique to this run. */
export const runNonce = (nonce = process.env.LAZYSH_E2E_NONCE) => {
  if (!nonce) throw new Error('LAZYSH_E2E_NONCE is unset: owned hosts were not started');
  return nonce;
};

/** A per-run unique host name, so tests never collide with each other or with a leftover from an earlier run. */
export const hostName = (label: string, nonce = runNonce()) => `e2e-${nonce}-${label}`;

/** The hosts a run starts when LAZYSH_E2E_HOSTS is unset: SSH and SSH with SFTP, plus both Herdr hosts when the three binaries are given (the Agent view specs need them). */
export const defaultHostKinds = (env: NodeJS.ProcessEnv = process.env) =>
  ['LAZYSH_TEST_HERDR', 'LAZYSH_TEST_AGENT_BIN', 'LAZYSH_TEST_RECEIVER_BIN'].every(name => env[name]) ? 'ssh,sftp,herdr,herdr-agents' : 'ssh,sftp';

export function hostKinds(value = process.env.LAZYSH_E2E_HOSTS ?? defaultHostKinds()): HostKind[] {
  const kinds = value.split(',').map(kind => kind.trim()).filter(Boolean);
  const unknown = kinds.filter(kind => !(HOST_KINDS as readonly string[]).includes(kind));
  if (unknown.length) throw new Error(`Unknown LAZYSH_E2E_HOSTS entries: ${unknown.join(', ')} (use ${HOST_KINDS.join(', ')})`);
  return kinds as HostKind[];
}
