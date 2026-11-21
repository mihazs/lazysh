import { afterAll, expect, test as bunTest } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitFixtureRoots, project } from './support/gitFixture';

/**
 * The host script behind "install and remove the managed Herdr over the connected SSH session". It is executed here
 * exactly as sshd's shell receives it (`sh -c <script> lazysh-managed-herdr ACTION ARGUMENTS`) on a private host: a
 * private home with a stock Herdr (binary, configuration, state, a running server) that no action may touch.
 * macOS cannot be exercised on this runner; its branch is simulated with BSD-shaped `stat` and `uname` shims.
 */
const script = await readFile(resolve(project, 'apps/client/src-tauri/src/companion/install/managed_herdr.sh'), 'utf8');
const SH = Bun.which('sh')!;
const roots = gitFixtureRoots('lazysh-managed-herdr-');
afterAll(() => roots.cleanup());
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const linux = process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64');
const test = linux ? bunTest : bunTest.skip;
const arm = process.arch === 'arm64';
const TARGET = `linux-herdr-${arm ? 'arm64' : 'x64'}`;
const OTHER = `linux-herdr-${arm ? 'x64' : 'arm64'}`;
const STOCK = '#!/bin/sh\necho stock herdr\n';

/**
 * A real static executable for this CPU that exits with `code` whatever it is given, so `--version` is a real self test
 * on every Linux runner. `padding` makes a different file of the same program. Not a Herdr: the script pins, not parses.
 */
function elf(code: number, padding = 0) {
  const program = arm
    ? Buffer.from([code << 5, 0x00, 0x80, 0xd2, 0xa8, 0x0b, 0x80, 0xd2, 0x01, 0x00, 0x00, 0xd4])
    : Buffer.from([0xbf, code, 0, 0, 0, 0xb8, 0x3c, 0, 0, 0, 0x0f, 0x05]);
  const size = 120 + program.length + padding;
  const file = Buffer.alloc(size);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(file);
  file.writeUInt16LE(2, 16); file.writeUInt16LE(arm ? 0xb7 : 0x3e, 18); file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(0x400078n, 24); file.writeBigUInt64LE(64n, 32);
  file.writeUInt16LE(64, 52); file.writeUInt16LE(56, 54); file.writeUInt16LE(1, 56);
  file.writeUInt32LE(1, 64); file.writeUInt32LE(5, 68);
  file.writeBigUInt64LE(0x400000n, 80); file.writeBigUInt64LE(0x400000n, 88);
  file.writeBigUInt64LE(BigInt(size), 96); file.writeBigUInt64LE(BigInt(size), 104); file.writeBigUInt64LE(0x1000n, 112);
  program.copy(file, 120);
  return file;
}
const working = elf(0), failing = elf(1);
const TOOLS = ['uname', 'id', 'stat', 'mkdir', 'mktemp', 'find', 'cp', 'mv', 'rm', 'rmdir', 'chmod', 'env', 'sleep', 'tr', 'od', 'sha256sum', 'shasum'];

async function host(tools = TOOLS) {
  const { root } = await roots.create();
  const home = await mkdtemp(join(root, 'home-'));
  const data = join(home, '.local/share');
  const managed = join(data, 'lazysh/herdr');
  const toolbox = join(home, 'toolbox');
  await mkdir(toolbox);
  for (const name of tools) {
    const found = Bun.which(name);
    if (found) await symlink(found, join(toolbox, name));
  }
  // What a user already has and no managed action may change: a stock Herdr, its configuration, its state and a running server.
  const stock = join(home, '.local/bin/herdr');
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await writeFile(stock, STOCK, { mode: 0o755 });
  const kept = {
    [join(home, '.config/herdr/config.toml')]: 'default = "stock"\n',
    [join(home, '.local/state/herdr/session.json')]: '{"sessions":["stock"]}',
    [join(home, '.local/state/lazysh-herdr/session.json')]: '{"sessions":["managed"]}',
    [join(data, 'lazysh/companion/lazysh-agent')]: 'companion that must stay',
    [stock]: STOCK,
  };
  for (const [path, text] of Object.entries(kept)) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  await chmod(stock, 0o755);
  const server = Bun.spawn(['sleep', '600'], { stdout: 'ignore', stderr: 'ignore' });
  await writeFile(join(home, '.local/state/herdr/server.pid'), String(server.pid));
  kept[join(home, '.local/state/herdr/server.pid')] = String(server.pid);
  return { home, data, managed, binary: join(managed, 'lazysh-herdr'), toolbox, kept, server };
}
type Host = Awaited<ReturnType<typeof host>>;

/** Everything the host kept is byte for byte what it was, and its server is still the same running process. */
async function untouched(h: Host) {
  for (const [path, text] of Object.entries(h.kept)) expect(await readFile(path, 'utf8')).toBe(text);
  expect(() => process.kill(h.server.pid, 0)).not.toThrow();
  expect(h.server.exitCode).toBeNull();
  h.server.kill();
}
async function stage(h: Host, bytes: Buffer, name = 'lazysh-herdr') {
  const directory = join(h.home, `.lazysh-install-${crypto.randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
type Pin = { sha: string; bytes: number };
const pin = (bytes: Buffer): Pin => ({ sha: sha(bytes), bytes: bytes.length });

async function run(h: Host, args: string[], options: { path?: string; text?: string; env?: Record<string, string>; signal?: () => Promise<void> } = {}) {
  const child = Bun.spawn([SH, '-c', options.text ?? script, 'lazysh-managed-herdr', ...args], {
    env: { PATH: options.path ?? h.toolbox, HOME: h.home, ...options.env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  await options.signal?.();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return { code, stderr, result: JSON.parse(lines[0]) as Record<string, any> };
}
const inspectArgs = (h: Host, staged: string, p: Pin, target = TARGET) => ['inspect', h.managed, target, p.sha, String(p.bytes), staged];
const inspect = (h: Host, staged: string, p: Pin, target = TARGET, options = {}) => run(h, inspectArgs(h, staged, p, target), options);
const install = (h: Host, staged: string, p: Pin, plan: string, target = TARGET, options = {}) => run(h, ['install', h.managed, target, p.sha, String(p.bytes), staged, plan], options);
async function plan(h: Host, staged: string, p: Pin, target = TARGET) {
  const planned = await inspect(h, staged, p, target);
  expect(planned.code).toBe(0);
  return planned.result.plan as string;
}
const failed = (outcome: Awaited<ReturnType<typeof run>>, code: number, kind: string) => {
  expect(outcome.code).toBe(code);
  expect(outcome.result).toMatchObject({ schemaVersion: 1, outcome: 'failed', exitCode: code, error: { kind } });
};
/** The managed directory as a previous install would have left it: this user's, closed to everyone else. */
async function privateDirectory(h: Host) {
  await mkdir(h.managed, { recursive: true, mode: 0o700 });
  await chmod(h.managed, 0o700);
}
/** Nothing of an interrupted or refused run is left in the managed directory but what was there before. */
async function residue(h: Host) {
  return (await readdir(h.managed).catch(() => [] as string[])).filter((name) => name.startsWith('.'));
}

test('inspect plans the install and changes nothing on the host', async () => {
  const h = await host(), bytes = working, p = pin(bytes);
  const staged = await stage(h, bytes);
  const before = await readdir(h.home);
  const planned = await inspect(h, staged, p);
  expect(planned.code).toBe(0);
  expect(planned.result).toMatchObject({ schemaVersion: 1, action: 'inspect', outcome: 'planned', existing: { state: 'missing' } });
  expect(planned.result.plan).toMatch(/^[0-9a-f]{64}$/);
  expect(await readdir(h.home)).toEqual(before);
  await expect(lstat(h.managed)).rejects.toThrow();
  expect(await plan(h, staged, p)).toBe(planned.result.plan);
  const padded = elf(0, 8);
  expect(await plan(h, await stage(h, padded), pin(padded))).not.toBe(planned.result.plan);
  await untouched(h);
});

test('install publishes exactly the pinned executable as a private file, then reuses it, and leaves stock Herdr alone', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  // A run that was killed outright left staging behind; the next one clears only that, never other files.
  await privateDirectory(h);
  await mkdir(join(h.managed, '.work.killed'));
  await writeFile(join(h.managed, '.work.killed/new'), 'half a copy');
  await writeFile(join(h.managed, 'notes'), 'not ours to delete');
  const done = await install(h, staged, p, await plan(h, staged, p));
  expect(done.code).toBe(0);
  expect(await readdir(h.managed)).toEqual(expect.arrayContaining(['lazysh-herdr', 'notes']));
  expect(await readFile(join(h.managed, 'notes'), 'utf8')).toBe('not ours to delete');
  expect(done.result).toMatchObject({ outcome: 'installed', existing: { state: 'present', sha256: p.sha, bytes: p.bytes } });
  expect(sha(await readFile(h.binary))).toBe(p.sha);
  expect((await stat(h.binary)).mode & 0o777).toBe(0o700);
  expect((await stat(h.managed)).mode & 0o777).toBe(0o700);
  expect(await residue(h)).toEqual([]);
  expect(await readFile(staged)).toEqual(working);
  const written = (await stat(h.binary)).mtimeMs;
  const again = await install(h, staged, p, await plan(h, staged, p));
  expect(again.result).toMatchObject({ outcome: 'reused' });
  expect((await stat(h.binary)).mtimeMs).toBe(written);
  await untouched(h);
});

test('install replaces an older managed executable in one step and removal then deletes only that file', async () => {
  const h = await host(), older = working, newer = elf(0, 16);
  const first = await stage(h, older);
  expect((await install(h, first, pin(older), await plan(h, first, pin(older)))).code).toBe(0);
  const staged = await stage(h, newer), p = pin(newer);
  const upgrade = await install(h, staged, p, await plan(h, staged, p));
  expect(upgrade.result).toMatchObject({ outcome: 'installed' });
  expect(await readFile(h.binary)).toEqual(newer);
  expect(await residue(h)).toEqual([]);
  await writeFile(join(h.managed, 'sibling-note'), 'not ours to delete');
  const removed = await run(h, ['remove', h.managed]);
  expect(removed.code).toBe(0);
  expect(removed.result).toMatchObject({ action: 'remove', outcome: 'removed' });
  await expect(lstat(h.binary)).rejects.toThrow();
  expect(await readFile(join(h.managed, 'sibling-note'), 'utf8')).toBe('not ours to delete');
  expect((await run(h, ['remove', h.managed])).result).toMatchObject({ outcome: 'absent' });
  await untouched(h);
});

test('remove on a host that never installed anything does nothing and creates nothing', async () => {
  const h = await host();
  const before = await readdir(h.data);
  expect((await run(h, ['remove', h.managed])).result).toMatchObject({ outcome: 'absent' });
  expect(await readdir(h.data)).toEqual(before);
  await untouched(h);
});

test('a staged file that is not the pinned one is refused before anything is published', async () => {
  const h = await host(), p = pin(working);
  const flipped = Buffer.from(working);
  flipped[flipped.length - 1] ^= 1;
  const staged = await stage(h, flipped);
  failed(await inspect(h, staged, p), 5, 'stagedMismatch');
  const good = await stage(h, working);
  const planned = await plan(h, good, p);
  failed(await install(h, staged, p, planned), 5, 'stagedMismatch');
  failed(await install(h, good, { ...p, bytes: p.bytes + 1 }, planned), 5, 'stagedMismatch');
  await expect(lstat(h.binary)).rejects.toThrow();
  // The staged file must be the private file the app created, not any file the plan names.
  const loose = await stage(h, working);
  await chmod(loose, 0o644);
  failed(await inspect(h, loose, p), 5, 'stagedMismatch');
  await untouched(h);
});

test('an executable for another CPU is refused, and so is a target that is not this host', async () => {
  const h = await host();
  const foreign = Buffer.from(working);
  foreign[18] = arm ? 0x3e : 0xb7;
  foreign[19] = 0;
  const staged = await stage(h, foreign);
  failed(await inspect(h, staged, pin(foreign)), 6, 'architectureMismatch');
  const text = await stage(h, Buffer.from('#!/bin/sh\necho not an executable\n'));
  failed(await inspect(h, text, pin(Buffer.from('#!/bin/sh\necho not an executable\n'))), 6, 'architectureMismatch');
  const good = await stage(h, working);
  failed(await inspect(h, good, pin(working), OTHER), 3, 'unsupportedHost');
  failed(await inspect(h, good, pin(working), 'macos-herdr-arm64'), 3, 'unsupportedHost');
  failed(await inspect(h, good, pin(working), 'linux-herdr-riscv'), 2, 'usage');
  await expect(lstat(h.managed)).rejects.toThrow();
  await untouched(h);
});

test('a plan made before the host changed is refused and publishes nothing', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  const stale = await plan(h, staged, p);
  // Another client installed a different managed executable after the plan was made.
  const other = elf(0, 8);
  await privateDirectory(h);
  await writeFile(h.binary, other, { mode: 0o700 });
  failed(await install(h, staged, p, stale), 7, 'stalePlan');
  expect(await readFile(h.binary)).toEqual(other);
  expect(await residue(h)).toEqual([]);
  failed(await install(h, staged, p, 'f'.repeat(64)), 7, 'stalePlan');
  expect((await install(h, staged, p, await plan(h, staged, p))).result).toMatchObject({ outcome: 'installed' });
  expect(await readFile(h.binary)).toEqual(working);
  await untouched(h);
});

test('an unsafe destination is refused and nothing it points at is ever written', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  const stock = join(h.home, '.local/bin/herdr');
  // The destination is a symbolic link to the stock executable.
  await privateDirectory(h);
  await symlink(stock, h.binary);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  failed(await install(h, staged, p, 'a'.repeat(64)), 4, 'unsafeLocation');
  failed(await run(h, ['remove', h.managed]), 4, 'unsafeLocation');
  expect((await lstat(h.binary)).isSymbolicLink()).toBe(true);
  await rm(h.binary);
  // Even a link to this user's own private executable is not an owned managed binary.
  const elsewhere = join(h.home, 'private-binary');
  await writeFile(elsewhere, working, { mode: 0o700 });
  await symlink(elsewhere, h.binary);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  failed(await run(h, ['remove', h.managed]), 4, 'unsafeLocation');
  expect(await readFile(elsewhere)).toEqual(working);
  await rm(h.binary);
  // The destination is a directory, or an executable other users could replace.
  await mkdir(h.binary);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  await rm(h.binary, { recursive: true });
  await writeFile(h.binary, working, { mode: 0o755 });
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  failed(await run(h, ['remove', h.managed]), 4, 'unsafeLocation');
  expect(await readFile(h.binary)).toEqual(working);
  await rm(h.binary);
  // The managed directory itself is writable by others, or is a link to somewhere else.
  await chmod(h.managed, 0o770);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  await chmod(h.managed, 0o700);
  await rm(h.managed, { recursive: true });
  await symlink(join(h.home, '.config'), h.managed);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  failed(await install(h, staged, p, 'a'.repeat(64)), 4, 'unsafeLocation');
  expect(await readdir(join(h.home, '.config'))).toEqual(['herdr']);
  await rm(h.managed);
  // An ancestor that is a link or that others can write to.
  const moved = join(h.data, 'elsewhere');
  await mkdir(moved);
  await symlink(moved, join(h.data, 'lazysh-link'));
  failed(await run(h, ['install', join(h.data, 'lazysh-link/lazysh/herdr'), TARGET, p.sha, String(p.bytes), staged, 'a'.repeat(64)]), 4, 'unsafeLocation');
  await chmod(join(h.data, 'lazysh'), 0o777);
  failed(await inspect(h, staged, p), 4, 'unsafeLocation');
  expect(await readdir(moved)).toEqual([]);
  await chmod(join(h.data, 'lazysh'), 0o700);
  await untouched(h);
});

test('an executable that does not run on this host is never published', async () => {
  const h = await host();
  const staged = await stage(h, failing);
  const planned = await plan(h, staged, pin(failing));
  failed(await install(h, staged, pin(failing), planned), 9, 'selfTestFailed');
  await expect(lstat(h.binary)).rejects.toThrow();
  expect(await residue(h)).toEqual([]);
  // A working managed executable already there is kept when its replacement does not run.
  const good = await stage(h, working);
  expect((await install(h, good, pin(working), await plan(h, good, pin(working)))).code).toBe(0);
  const again = await stage(h, failing);
  failed(await install(h, again, pin(failing), await plan(h, again, pin(failing))), 9, 'selfTestFailed');
  expect(await readFile(h.binary)).toEqual(working);
  expect(await residue(h)).toEqual([]);
  await untouched(h);
});

/** A tool placed first on PATH (before `base`) that stands in for one the script calls, to make one step fail or stall. */
async function shim(h: Host, name: string, body: string, base = h.toolbox) {
  const path = join(h.home, `shim-${name}`);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${path}:${base}`;
}

test('an interrupted copy or publication fails without touching what was installed', async () => {
  const h = await host(), p = pin(working);
  const first = await stage(h, working);
  expect((await install(h, first, p, await plan(h, first, p))).code).toBe(0);
  const newer = elf(0, 32), np = pin(newer);
  const staged = await stage(h, newer);
  const planned = await plan(h, staged, np);
  // The copy dies after writing part of the bytes.
  failed(await install(h, staged, np, planned, TARGET, { path: await shim(h, 'cp', `${Bun.which('head')} -c 100 "$1" > "$2"; exit 1`) }), 5, 'stagedMismatch');
  expect(await readFile(h.binary)).toEqual(working);
  expect(await residue(h)).toEqual([]);
  // The final rename fails.
  failed(await install(h, staged, np, planned, TARGET, { path: await shim(h, 'mv', 'exit 1') }), 11, 'installedMismatch');
  expect(await readFile(h.binary)).toEqual(working);
  expect(await residue(h)).toEqual([]);
  // The same install, with nothing failing, then goes through.
  expect((await install(h, staged, np, planned)).result).toMatchObject({ outcome: 'installed' });
  expect(await readFile(h.binary)).toEqual(newer);
  expect(await residue(h)).toEqual([]);
  await untouched(h);
});

test('cancelling an install stops it, cleans up and publishes nothing', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  const planned = await plan(h, staged, p);
  const marker = join(h.home, 'running');
  // The self test stalls; the app disconnects, which the host sees as a terminating signal.
  const stalled = await shim(h, 'env', `: > "${marker}"; exec sleep 30`);
  const child = Bun.spawn([SH, '-c', script, 'lazysh-managed-herdr', 'install', h.managed, TARGET, p.sha, String(p.bytes), staged, planned], {
    env: { PATH: stalled, HOME: h.home }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  for (let waited = 0; !(await Bun.file(marker).exists()); waited += 50) {
    expect(waited).toBeLessThan(10_000);
    await Bun.sleep(50);
  }
  child.kill('SIGTERM');
  const code = await child.exited;
  const output = (await new Response(child.stdout).text()).trim();
  expect(code).toBe(143);
  expect(JSON.parse(output)).toMatchObject({ outcome: 'failed', exitCode: 143 });
  await expect(lstat(h.binary)).rejects.toThrow();
  expect(await residue(h)).toEqual([]);
  expect(await readFile(staged)).toEqual(working);
  await untouched(h);
});

test('a run that finds a live lock is refused as busy, and a stale lock is taken over', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  const planned = await plan(h, staged, p);
  await privateDirectory(h);
  await mkdir(join(h.managed, '.lock'));
  failed(await install(h, staged, p, planned), 8, 'hostBusy');
  failed(await run(h, ['remove', h.managed]), 8, 'hostBusy');
  await expect(lstat(h.binary)).rejects.toThrow();
  const old = new Date(Date.now() - 3_600_000);
  await utimes(join(h.managed, '.lock'), old, old);
  expect((await install(h, staged, p, planned)).result).toMatchObject({ outcome: 'installed' });
  expect(await residue(h)).toEqual([]);
  await untouched(h);
});

test('a host without a SHA-256 tool is told so instead of installing unchecked bytes', async () => {
  const h = await host(TOOLS.filter((name) => !name.startsWith('sha')));
  const staged = await stage(h, working);
  failed(await inspect(h, staged, pin(working)), 10, 'hostToolMissing');
  await untouched(h);
});

test('arguments that are not exactly what the app sends are usage errors that change nothing', async () => {
  const h = await host(), p = pin(working);
  const staged = await stage(h, working);
  const ok = inspectArgs(h, staged, p);
  const cases: string[][] = [
    [], ['unknown'], ['inspect'], ['remove'], ['remove', join(h.home, 'elsewhere')], ['remove', `${h.managed}/../herdr`], ['remove', `${h.managed}/`],
    ['remove', 'relative/lazysh/herdr'], ['remove', `${h.managed}\n`],
    [...ok.slice(0, 3), 'F'.repeat(64), ...ok.slice(4)], [...ok.slice(0, 3), 'abc', ...ok.slice(4)], [...ok.slice(0, 4), '0', staged], [...ok.slice(0, 4), '99999999999', staged],
    [...ok.slice(0, 5), join(h.home, 'lazysh-herdr')], [...ok.slice(0, 5), `${staged}/../x/lazysh-herdr`],
    ['install', ...ok.slice(1), 'short'], ['install', ...ok.slice(1)], [...ok, 'extra'],
  ];
  for (const args of cases) {
    const outcome = await run(h, args);
    expect(outcome.code).toBe(2);
    expect(outcome.result).toMatchObject({ outcome: 'failed', error: { kind: 'usage' } });
  }
  await expect(lstat(h.managed)).rejects.toThrow();
  await untouched(h);
});

test('the other Linux CPU is chosen by the host, not by the file: an arm64 host takes only an arm64 executable (uname simulated)', async () => {
  const h = await host();
  const path = await shim(h, 'uname', `case "$1" in -s) echo Linux;; -m) echo aarch64;; esac`);
  const arm64 = Buffer.from(working), x64 = Buffer.from(working);
  arm64.writeUInt16LE(0xb7, 18);
  x64.writeUInt16LE(0x3e, 18);
  expect((await inspect(h, await stage(h, arm64), pin(arm64), 'linux-herdr-arm64', { path })).result).toMatchObject({ outcome: 'planned' });
  failed(await inspect(h, await stage(h, x64), pin(x64), 'linux-herdr-arm64', { path }), 6, 'architectureMismatch');
  failed(await inspect(h, await stage(h, arm64), pin(arm64), 'linux-herdr-x64', { path }), 3, 'unsupportedHost');
  await untouched(h);
});

test('the macOS branch reads BSD stat and Mach-O headers (simulated with shims; no Apple hardware ran it)', async () => {
  const h = await host();
  const bsd = await shim(h, 'stat', `case "$1" in -f) shift; shift; exec ${Bun.which('stat')} -c '%u %a %h %s' "$@";; *) exec ${Bun.which('stat')} "$@";; esac`);
  const path = await shim(h, 'uname', `case "$1" in -s) echo Darwin;; -m) echo arm64;; esac`, bsd);
  const header = (cpu: number) => Buffer.from([0xcf, 0xfa, 0xed, 0xfe, cpu, 0, 0, 1, ...new Array(32).fill(0)]);
  const arm64 = header(0x0c), x64 = header(0x07);
  const planned = await inspect(h, await stage(h, arm64), pin(arm64), 'macos-herdr-arm64', { path });
  expect(planned.result).toMatchObject({ outcome: 'planned', existing: { state: 'missing' } });
  failed(await inspect(h, await stage(h, x64), pin(x64), 'macos-herdr-arm64', { path }), 6, 'architectureMismatch');
  failed(await inspect(h, await stage(h, arm64), pin(arm64), 'macos-herdr-x64', { path }), 3, 'unsupportedHost');
  failed(await inspect(h, await stage(h, Buffer.from(working)), pin(working), 'macos-herdr-arm64', { path }), 6, 'architectureMismatch');
  await untouched(h);
});
