import { expect, test } from 'bun:test';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestFile, stagePackages, companionTargets, type CompanionTarget } from '../.changeset/release-artifacts';
import { desktopCompanions, elfSections, publishedCompanion, requireBundled, sidecarPath, stageSidecar, type DesktopTarget } from '../.changeset/release-bundle';
import { appImageCompanion, debCompanion, installCompanion, requireDebianRuntime } from '../.changeset/release-platform';
import { spawnText } from './support/gitFixture';

const identity = { sha: 'a'.repeat(40), version: '0.23.0' };
const bytes = (label: string) => Buffer.from(`owned companion ${label}`);
async function owned(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-bundle-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
/** What the companion job uploads for a target: the executable and its receipt, as `stagePackages` writes them. */
async function stagedCompanion(root: string, target: CompanionTarget, content = bytes(target)) {
  const source = join(root, `source-${target}`);
  await writeFile(source, content);
  const directory = join(root, `release-${target}`);
  await stagePackages(identity, target, target.startsWith('macos-') ? 'ad-hoc' : 'unsigned', [source], directory);
  return directory;
}
const desktops = Object.keys(desktopCompanions) as DesktopTarget[];

test('each desktop platform stages exactly the companion built for it, named the way the Tauri bundler looks for it', () => owned(async root => {
  expect(desktops.map(sidecarPath)).toEqual([
    'binaries/lazysh-agent-x86_64-unknown-linux-gnu',
    'binaries/lazysh-agent-x86_64-pc-windows-msvc.exe',
    'binaries/lazysh-agent-aarch64-apple-darwin',
    'binaries/lazysh-agent-x86_64-apple-darwin',
  ]);
  for (const desktop of desktops) {
    const { companion } = desktopCompanions[desktop];
    const directory = await stagedCompanion(root, companion);
    const staged = await stageSidecar(identity, desktop, directory, join(root, desktop));
    expect(staged.destination).toBe(join(root, desktop, 'apps/client/src-tauri', sidecarPath(desktop)));
    expect(await Bun.file(staged.destination).bytes()).toEqual(new Uint8Array(bytes(companion)));
    expect((await Bun.file(staged.destination).stat()).mode & 0o111).not.toBe(0);
    expect(await digestFile(staged.destination)).toEqual({ bytes: staged.bytes, sha256: staged.sha256 });
    // A companion built for another platform never stands in for this one.
    const other = desktops.find(candidate => candidate !== desktop)!;
    await expect(publishedCompanion(identity, other, directory)).rejects.toThrow('another platform');
  }
  // The Tauri host triple differs from the compile triple only on Linux, where the static musl build ships.
  expect(companionTargets[desktopCompanions['linux-x64'].companion].triple).toBe('x86_64-unknown-linux-musl');
}));

test('the Tauri overlay config names the sidecar every desktop platform stages', async () => {
  const config = await Bun.file(join(import.meta.dir, '../apps/client/src-tauri/tauri.bundled-agent.conf.json')).json();
  expect(config).toEqual({ bundle: { externalBin: ['binaries/lazysh-agent'] } });
  // Tauri appends `-<host triple>` (and `.exe` on Windows) to each externalBin entry to find the file to package.
  for (const desktop of desktops) {
    expect(sidecarPath(desktop)).toBe(`${config.bundle.externalBin[0]}-${desktopCompanions[desktop].triple}${desktop === 'windows-x64' ? '.exe' : ''}`);
  }
});

test('a staged companion from another source or version, with tampered bytes or extra files is refused before any build', () => owned(async root => {
  const directory = await stagedCompanion(root, 'linux-agent-x64');
  await expect(publishedCompanion({ ...identity, sha: 'b'.repeat(40) }, 'linux-x64', directory)).rejects.toThrow('source/version mismatch');
  await expect(publishedCompanion({ ...identity, version: '0.24.0' }, 'linux-x64', directory)).rejects.toThrow('source/version mismatch');
  await writeFile(join(directory, 'stray'), 'x');
  await expect(publishedCompanion(identity, 'linux-x64', directory)).rejects.toThrow('unexpected companion files');
  await rm(join(directory, 'stray'));
  await writeFile(join(directory, `lazysh-${identity.version}-linux-agent-x64.bin`), 'tampered after the receipt');
  await expect(stageSidecar(identity, 'linux-x64', directory, join(root, 'out'))).rejects.toThrow('differs from its receipt');
  expect(await Bun.file(join(root, 'out', 'apps/client/src-tauri', sidecarPath('linux-x64'))).exists()).toBe(false);
}));

test('a package whose companion is missing, linked or different from the published one is rejected', () => owned(async root => {
  const published = await publishedCompanion(identity, 'linux-x64', await stagedCompanion(root, 'linux-agent-x64'));
  const inside = join(root, 'package-lazysh-agent');
  await expect(requireBundled(inside, published, 'package')).rejects.toThrow('package has no lazysh-agent');
  await writeFile(inside, bytes('linux-agent-x64'));
  await requireBundled(inside, published, 'package');
  await writeFile(inside, bytes('a different version'));
  await expect(requireBundled(inside, published, 'package')).rejects.toThrow('differs from the published companion');
  await rm(inside);
  await symlink(published.file, inside);
  await expect(requireBundled(inside, published, 'package')).rejects.toThrow('package has no lazysh-agent');
}));

test('the Debian Depends field must offer both protobuf-lite package names', async () => {
  // The Depends field the v1.102.x packages carried.
  expect(() => requireDebianRuntime('libwebkit2gtk-4.1-0, libgtk-3-0')).toThrow('omits protobuf-lite runtime providers');
  expect(() => requireDebianRuntime('libgtk-3-0, libprotobuf-lite32t64')).toThrow('omits protobuf-lite runtime providers');
  requireDebianRuntime('libwebkit2gtk-4.1-0, libgtk-3-0, libprotobuf-lite32t64 | libprotobuf-lite32');
  requireDebianRuntime('libgtk-3-0, libprotobuf-lite32 (>= 3.21) | libprotobuf-lite32t64 (>= 3.21)');
  // The packaging configuration feeds the same check.
  const configuration = await Bun.file(new URL('../apps/client/src-tauri/tauri.linux.conf.json', import.meta.url)).json();
  requireDebianRuntime(configuration.bundle.linux.deb.depends.join(', '));
});

const dpkg = Bun.which('dpkg-deb');
async function debWith(root: string, files: Record<string, Buffer>) {
  const tree = join(root, 'deb-tree');
  await mkdir(join(tree, 'DEBIAN'), { recursive: true });
  await writeFile(join(tree, 'DEBIAN/control'), 'Package: lazysh\nVersion: 0.23.0\nArchitecture: amd64\nMaintainer: owned\nDescription: owned fixture\n');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(tree, path, '..'), { recursive: true });
    await writeFile(join(tree, path), content);
    await chmod(join(tree, path), 0o755);
  }
  const deb = join(root, 'lazysh.deb');
  const built = await spawnText(root, ['dpkg-deb', '--build', '--root-owner-group', tree, deb]);
  expect(built.code).toBe(0);
  return deb;
}
test.skipIf(!dpkg)('a real Debian package must install the published companion in /usr/bin', () => owned(async root => {
  const published = await publishedCompanion(identity, 'linux-x64', await stagedCompanion(root, 'linux-agent-x64'));
  await debCompanion(await debWith(root, { 'usr/bin/lazysh': bytes('app'), 'usr/bin/lazysh-agent': bytes('linux-agent-x64') }), published);
  await rm(join(root, 'deb-tree'), { recursive: true });
  await expect(debCompanion(await debWith(root, { 'usr/bin/lazysh': bytes('app') }), published)).rejects.toThrow('Debian package has no lazysh-agent');
  await rm(join(root, 'deb-tree'), { recursive: true });
  await expect(debCompanion(await debWith(root, { 'usr/bin/lazysh-agent': bytes('another build') }), published))
    .rejects.toThrow('Debian package lazysh-agent differs from the published companion');
}));

// A stand-in for an AppImage: like the real runtime, `--appimage-extract` writes `squashfs-root/` into the working directory.
async function appImageWith(root: string, name: string, agent?: string, mode = '755') {
  const image = join(root, `${name}.AppImage`);
  await writeFile(image, `#!/bin/sh
[ "$1" = --appimage-extract ] || exit 2
mkdir -p squashfs-root/usr/bin && printf app > squashfs-root/usr/bin/lazysh
${agent ? `install -m ${mode} "${agent}" squashfs-root/usr/bin/lazysh-agent` : ''}
`);
  await chmod(image, 0o755);
  return image;
}
// A real ELF executable the machine has, with one section of a copy rewritten the way a packaging tool would.
const objcopy = Bun.which('objcopy');
const shell = process.platform === 'linux' ? await realpath(Bun.which('sh')!) : '';
async function rewritten(root: string, name: string, section: string) {
  const dumped = join(root, `${name}.section`), copy = join(root, name);
  expect((await spawnText(root, [objcopy!, '--dump-section', `${section}=${dumped}`, shell, '/dev/null'])).code).toBe(0);
  const bytes = Buffer.from(await Bun.file(dumped).arrayBuffer());
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(dumped, bytes);
  expect((await spawnText(root, [objcopy!, '--update-section', `${section}=${dumped}`, shell, copy])).code).toBe(0);
  return copy;
}
test.skipIf(process.platform !== 'linux' || !objcopy)('an AppImage must carry the published companion, whose dynamic section its tooling rewrites, and nothing else changed', () => owned(async root => {
  const file = join(root, 'published-source');
  await copyFile(shell, file);
  const directory = join(root, 'release-linux-agent-x64');
  await stagePackages(identity, 'linux-agent-x64', 'unsigned', [file], directory);
  const published = await publishedCompanion(identity, 'linux-x64', directory);
  expect([...elfSections(Buffer.from(await Bun.file(shell).arrayBuffer())).keys()]).toContain('.text');
  await appImageCompanion(await appImageWith(root, 'untouched', shell), published);
  // linuxdeploy sets a RUNPATH: only .dynamic and .dynstr change.
  await appImageCompanion(await appImageWith(root, 'runpath', await rewritten(root, 'runpath', '.dynstr')), published);
  await expect(appImageCompanion(await appImageWith(root, 'code', await rewritten(root, 'code', '.text')), published))
    .rejects.toThrow('differs from the published companion in .text');
  await expect(appImageCompanion(await appImageWith(root, 'empty'), published)).rejects.toThrow('AppImage has no lazysh-agent');
  await expect(appImageCompanion(await appImageWith(root, 'plain', shell, '644'), published)).rejects.toThrow('not executable');
  await writeFile(join(root, 'text'), 'a script is no executable image');
  await expect(appImageCompanion(await appImageWith(root, 'script', join(root, 'text')), published)).rejects.toThrow('not an ELF64 image');
}));

test.skipIf(process.platform !== 'linux')('the final AppImage companion must execute and report the release version', () => owned(async root => {
  const published = async (script: string) => {
    const directory = await stagedCompanion(root, 'linux-agent-x64', Buffer.from(script));
    return publishedCompanion(identity, 'linux-x64', directory);
  };

  const broken = await published('#!/bin/sh\nexit 139\n');
  await expect(appImageCompanion(await appImageWith(root, 'crashes', broken.file), broken, identity.version))
    .rejects.toThrow('Release validation failed: lazysh-agent');

  const working = await published('#!/bin/sh\nprintf "lazysh-agent 0.23.0\\n"\n');
  const image = await appImageWith(root, 'working', working.file);
  await appImageCompanion(image, working, identity.version);
  await expect(appImageCompanion(image, working, '0.23.1')).rejects.toThrow('AppImage companion version mismatch');
}));

test('the published companion is installed executable even when its downloaded copy kept no mode', () => owned(async root => {
  const source = join(root, 'downloaded-companion'), destination = join(root, 'squashfs-companion');
  await writeFile(source, 'companion');
  await chmod(source, 0o644);
  await writeFile(destination, 'rewritten by linuxdeploy');
  await chmod(destination, 0o755);
  await installCompanion(source, destination);
  expect((await lstat(destination)).mode & 0o111).not.toBe(0);
  expect(await readFile(destination, 'utf8')).toBe('companion');
}));
