import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { descendantsOf, freePorts, killOwned, launch, processTable, requireOwnedWindowsRunner, until, type ProcessRow } from './windowsGui';

const execute = promisify(execFile);

/** The SHA-256 fingerprint `ssh-keygen -l -E sha256` prints for an Ed25519 key, the one the application shows for review. */
export function hostKeyFingerprint(output: string) {
  const match = /^256 (SHA256:[A-Za-z0-9+/]{43}) .* \(ED25519\)$/m.exec(output.replaceAll('\r', '').trim());
  if (!match) throw new Error('Unrecognized ssh-keygen fingerprint output');
  return match[1];
}

/** `ssh -v` names the host key it was offered; it is the key the client would ask to trust. */
export function offeredHostKey(verbose: string) {
  const match = /^debug1: Server host key: ssh-ed25519 (SHA256:[A-Za-z0-9+/]{43})$/m.exec(verbose.replaceAll('\r', ''));
  if (!match) throw new Error('The server offered no Ed25519 host key');
  return match[1];
}

/** The Windows OpenSSH build the hosted image installs as a Windows capability; only these exact files are ever run. */
export function openSshTools(env: NodeJS.ProcessEnv = process.env) {
  const directory = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH');
  return { sshd: win32.join(directory, 'sshd.exe'), keygen: win32.join(directory, 'ssh-keygen.exe'), client: win32.join(directory, 'ssh.exe') };
}

/** The key text as the application's key field holds it: Windows ssh-keygen writes CRLF line ends. */
const readPrivateKey = async (path: string) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');

/** One ssh-keygen run; the passphrase is empty because the key exists only for this server and dies with it. */
async function generate(keygen: string, path: string) {
  await execute(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'lazysh-owned', '-f', path], { timeout: 30_000, windowsHide: true });
}

/** The identification line (`SSH-2.0-OpenSSH_for_Windows_...`) of whatever accepts a TCP connection on loopback and speaks SSH, or undefined; reads no more than the banner. */
export async function sshBanner(port: number) {
  return new Promise<string | undefined>(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (banner?: string) => { socket.destroy(); resolve(banner); };
    socket.setTimeout(2000, () => done());
    socket.once('error', () => done());
    socket.once('data', chunk => done(String(chunk).startsWith('SSH-2.0-OpenSSH') ? String(chunk).split(/\r?\n/)[0] : undefined));
  });
}
export const speaksSsh = async (port: number) => (await sshBanner(port)) !== undefined;

export interface OwnedSshServer {
  port: number;
  username: string;
  /** OpenSSH-format private key text that the server accepts for `username`. */
  privateKey: string;
  privateKeyPath: string;
  /** `SHA256:` fingerprint of the server's host key. */
  fingerprint: string;
  /** The server's identification line, which names its OpenSSH build. */
  banner: string;
  directory: string;
  /** A fresh throwaway key (OpenSSH-format text and its file) that this server does not authorize. */
  unauthorizedKey(): Promise<{ path: string; privateKey: string }>;
  stop(): Promise<void>;
  output(): string;
}

/**
 * `options.port` binds that loopback port instead of a fresh one, so a second server (a new host key and a new client key) can replace
 * a stopped one at the same address.
 *
 * A second sshd (the Windows OpenSSH build the image already carries) started as an ordinary process by the job's own user.
 * It listens on a fresh loopback port, accepts one throwaway Ed25519 key for that user and nothing else, and never touches the
 * machine's `sshd` service, its configuration or `administrators_authorized_keys`. Everything it creates lives in one fresh
 * directory below `RUNNER_TEMP` that `stop()` removes after killing exactly the processes below this server.
 */
export async function startOwnedSshServer(options: { port?: number } = {}): Promise<OwnedSshServer> {
  requireOwnedWindowsRunner();
  const tools = openSshTools();
  for (const tool of [tools.sshd, tools.keygen, tools.client])
    if (!(await lstat(tool).then(stat => stat.isFile(), () => false))) throw new Error(`The Windows OpenSSH Server capability is not installed (${tool})`);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP!, 'lazysh-ssh-'));
  const username = userInfo().username;
  let server: ReturnType<typeof launch> | undefined;
  let owner: ProcessRow | undefined;
  const stop = async () => {
    if (owner) await killOwned(owner);
    else server?.child.kill();
    if (owner) await until('owned sshd retirement', async () => {
      const rows = await processTable();
      return rows.some(row => row.pid === owner!.pid && row.created === owner!.created) || descendantsOf(rows, owner!).length ? undefined : true;
    }, 15_000);
    await rm(directory, { recursive: true, maxRetries: 10, retryDelay: 500 });
  };
  try {
    const hostKey = join(directory, 'host_key'), clientKey = join(directory, 'client_key'), authorized = join(directory, 'authorized_keys');
    await generate(tools.keygen, hostKey);
    await generate(tools.keygen, clientKey);
    await writeFile(authorized, await readFile(`${clientKey}.pub`));
    // sshd refuses a host key that any other principal can read.
    await execute('icacls.exe', [hostKey, '/inheritance:r', '/grant', 'SYSTEM:F', '/grant', 'Administrators:F'], { timeout: 30_000, windowsHide: true });
    const fingerprint = hostKeyFingerprint((await execute(tools.keygen, ['-l', '-E', 'sha256', '-f', `${hostKey}.pub`], { timeout: 30_000, windowsHide: true })).stdout);
    const port = options.port ?? (await freePorts(1))[0];
    const config = join(directory, 'sshd_config');
    const slashes = (path: string) => path.replaceAll('\\', '/');
    // StrictModes is off because the files are private to a directory this process just created, not to a profile.
    await writeFile(config, [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${slashes(hostKey)}`, `AuthorizedKeysFile ${slashes(authorized)}`,
      `PidFile ${slashes(join(directory, 'sshd.pid'))}`, 'AuthenticationMethods publickey', 'PubkeyAuthentication yes',
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'StrictModes no', 'MaxAuthTries 3', 'LogLevel VERBOSE', ''].join('\n'));
    server = launch(tools.sshd, ['-D', '-e', '-f', config]);
    const started = server;
    owner = await until('sshd process identity', async () => (await processTable()).find(row => row.pid === started.child.pid));
    const banner = await until('sshd readiness', () => sshBanner(port));
    let unauthorized = 0;
    const unauthorizedKey = async () => {
      const path = join(directory, `unauthorized_key_${++unauthorized}`);
      await generate(tools.keygen, path);
      return { path, privateKey: await readPrivateKey(path) };
    };
    return { port, username, privateKey: await readPrivateKey(clientKey), privateKeyPath: clientKey, fingerprint, banner, directory, unauthorizedKey, stop, output: () => started.output() };
  } catch (error) {
    console.error(`Owned Windows sshd failed to start; output:\n${server?.output().slice(-4000) ?? ''}`);
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Owned Windows sshd startup and cleanup failed'); }
    throw error;
  }
}
