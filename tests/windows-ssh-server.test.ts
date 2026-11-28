import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { powershell, requireOwnedWindowsRunner } from './support/windowsGui';
import { hostKeyFingerprint, offeredHostKey, openSshTools, speaksSsh, sshBanner, startOwnedSshServer, type OwnedSshServer } from './support/windowsSshServer';

const fingerprint = `SHA256:${'Ab1+/'.repeat(8)}Ab1`;

test('the host key fingerprint is read from ssh-keygen output and nothing else is accepted', () => {
  expect(hostKeyFingerprint(`256 ${fingerprint} lazysh-owned (ED25519)\r\n`)).toBe(fingerprint);
  for (const bad of ['', `3072 ${fingerprint} lazysh-owned (RSA)`, `256 SHA256:short lazysh-owned (ED25519)`, `256 MD5:${fingerprint.slice(7)} x (ED25519)`])
    expect(() => hostKeyFingerprint(bad)).toThrow('Unrecognized ssh-keygen fingerprint output');
});

test('the offered host key is read from the verbose client log and nothing else is accepted', () => {
  expect(offeredHostKey(`debug1: Remote protocol version 2.0\r\ndebug1: Server host key: ssh-ed25519 ${fingerprint}\r\ndebug1: rekey\r\n`)).toBe(fingerprint);
  for (const bad of ['', `debug1: Server host key: ssh-rsa ${fingerprint}`, `debug1: Server host key: ssh-ed25519 SHA256:short`])
    expect(() => offeredHostKey(bad)).toThrow('The server offered no Ed25519 host key');
});

test('the banner is the identification line of an OpenSSH greeting and nothing else is taken for a server', async () => {
  const greet = async (greeting: string) => {
    const listener = createServer(socket => socket.end(greeting));
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as { port: number };
    try { return [await sshBanner(port), await speaksSsh(port)] as const; } finally { listener.close(); }
  };
  expect(await greet('SSH-2.0-OpenSSH_for_Windows_9.5\r\nkex')).toEqual(['SSH-2.0-OpenSSH_for_Windows_9.5', true]);
  expect(await greet('HTTP/1.1 400 Bad Request\r\n')).toEqual([undefined, false]);
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as { port: number };
  await new Promise(resolve => closed.close(resolve));
  expect(await sshBanner(port)).toBeUndefined();
});

test('only the OpenSSH build below the system directory is ever run', () => {
  expect(openSshTools({ SystemRoot: 'D:\\Windows' })).toEqual({
    sshd: 'D:\\Windows\\System32\\OpenSSH\\sshd.exe', keygen: 'D:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe', client: 'D:\\Windows\\System32\\OpenSSH\\ssh.exe' });
});

const run = (program: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
  execFile(program, args, { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr })));

/** The real Windows `ssh.exe` against the owned server; the last argument is the remote command. */
const sshTo = (server: OwnedSshServer, args: string[]) => run(openSshTools().client, ['-p', String(server.port), '-o', 'UserKnownHostsFile=NUL', '-o', 'StrictHostKeyChecking=no',
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10', ...args.slice(0, -1), `${server.username}@127.0.0.1`, args.at(-1)!]);

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_SSH !== '1')('owned Windows OpenSSH server accepts only its key, offers its host key on loopback and leaves nothing behind', async () => {
  requireOwnedWindowsRunner();
  const service = () => powershell('(Get-Service sshd -ErrorAction SilentlyContinue).Status');
  const before = await service();
  const server = await startOwnedSshServer();
  let stopped = false;
  try {
    expect(server.port).not.toBe(22);
    // The challenge is computed by the Windows shell, so its answer is not in the text typed.
    const accepted = await sshTo(server, ['-v', '-i', server.privateKeyPath, 'set /a 1234*5678']);
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain('7006652');
    expect(offeredHostKey(accepted.stderr)).toBe(server.fingerprint);

    const wrongKey = await sshTo(server, ['-i', (await server.unauthorizedKey()).path, 'echo refused']);
    expect([wrongKey.code, wrongKey.stdout.includes('refused'), wrongKey.stderr.includes('Permission denied')]).toEqual([255, false, true]);
    const password = await sshTo(server, ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', 'echo refused']);
    expect([password.code, password.stdout.includes('refused'), password.stderr.includes('Permission denied')]).toEqual([255, false, true]);

    const listeners = JSON.parse(await powershell(`ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ${server.port} | ForEach-Object LocalAddress)`));
    expect(listeners).toEqual(['127.0.0.1']);

    await server.stop();
    stopped = true;
    expect(await speaksSsh(server.port)).toBe(false);
    await expect(lstat(server.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service()).toBe(before);
  } finally {
    if (!stopped) await server.stop().catch(error => console.error(`Owned Windows sshd cleanup failed: ${error}`));
  }
}, 180_000);

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_SSH !== '1')('a replacement owned Windows OpenSSH server takes the same port with another host key and another client key', async () => {
  requireOwnedWindowsRunner();
  const first = await startOwnedSshServer();
  await first.stop();
  const second = await startOwnedSshServer({ port: first.port });
  try {
    expect(second.port).toBe(first.port);
    expect([second.fingerprint === first.fingerprint, second.privateKey === first.privateKey]).toEqual([false, false]);
    const accepted = await sshTo(second, ['-v', '-i', second.privateKeyPath, 'set /a 1234*5678']);
    expect([accepted.code, accepted.stdout.includes('7006652')]).toEqual([0, true]);
    expect(offeredHostKey(accepted.stderr)).toBe(second.fingerprint);
  } finally {
    await second.stop().catch(error => console.error(`Owned Windows sshd cleanup failed: ${error}`));
  }
}, 180_000);
