import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { verifyRelease } from './bun-lock';

export const companionTargets = {
  'linux-agent-x64': { triple: 'x86_64-unknown-linux-musl', os: 'linux', arch: 'x64' },
  'linux-agent-arm64': { triple: 'aarch64-unknown-linux-musl', os: 'linux', arch: 'arm64' },
  'macos-agent-x64': { triple: 'x86_64-apple-darwin', os: 'darwin', arch: 'x64' },
  'macos-agent-arm64': { triple: 'aarch64-apple-darwin', os: 'darwin', arch: 'arm64' },
  'windows-agent-x64': { triple: 'x86_64-pc-windows-msvc', os: 'win32', arch: 'x64' },
} as const;
export type CompanionTarget = keyof typeof companionTargets;
export const companionMaximumBytes = 64 * 1024 * 1024;
export const artifactTargets = {
  'linux-x64': ['deb', 'AppImage'],
  'windows-x64': ['exe'],
  'macos-arm64': ['dmg', 'app.zip'],
  'macos-x64': ['dmg', 'app.zip'],
  'android-google-arm64': ['apk'],
  'android-foss-arm64': ['apk'],
  'ios-arm64': ['ipa'],
  'linux-agent-x64': ['bin'],
  'linux-agent-arm64': ['bin'],
  'macos-agent-x64': ['bin'],
  'macos-agent-arm64': ['bin'],
  'windows-agent-x64': ['exe'],
} as const;
export type ArtifactTarget = keyof typeof artifactTargets;
export const releaseTargets: ArtifactTarget[] = ['linux-x64', 'windows-x64', 'android-google-arm64', 'android-foss-arm64',
  ...Object.keys(companionTargets) as CompanionTarget[]];
type Identity = { sha: string; version: string };
type Signing = 'unsigned' | 'ad-hoc' | 'signed';
type ArtifactFile = { name: string; bytes: number; sha256: string };
export type ArtifactReceipt = Identity & {
  schema: 1; target: ArtifactTarget; signing: Signing; files: ArtifactFile[];
};
function requireArtifact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release artifacts: ${message}`);
}
function whole(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
export function artifactName(identity: Identity, target: ArtifactTarget, extension: string) {
  requireArtifact(whole(/^[a-f0-9]{40}$/, identity.sha)
    && whole(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, identity.version), 'invalid source identity');
  requireArtifact(Object.hasOwn(artifactTargets, target)
    && (artifactTargets[target] as readonly string[]).includes(extension), 'unexpected target or package');
  return `lazysh-${identity.version}-${target}.${extension}`;
}
export function validateReceipt(value: unknown, identity: Identity): ArtifactReceipt {
  const data = value as ArtifactReceipt;
  requireArtifact(data && data.schema === 1 && data.sha === identity.sha && data.version === identity.version,
    'source/version mismatch');
  requireArtifact(Object.hasOwn(artifactTargets, data.target), 'unsupported target');
  const mobile = data.target.startsWith('android-') || data.target === 'ios-arm64';
  const mac = data.target.startsWith('macos-');
  requireArtifact(mobile ? data.signing === 'signed' : mac
    ? ['signed', 'ad-hoc'].includes(data.signing) : ['signed', 'unsigned'].includes(data.signing),
  'invalid signing status; mobile packages must be signed');
  const extensions = artifactTargets[data.target];
  requireArtifact(Array.isArray(data.files) && data.files.length === extensions.length, 'incomplete package set');
  for (const [index, extension] of extensions.entries()) {
    const file = data.files[index];
    requireArtifact(file && file.name === artifactName(identity, data.target, extension)
      && Number.isSafeInteger(file.bytes) && file.bytes > 0
      && file.bytes <= (Object.hasOwn(companionTargets, data.target) ? companionMaximumBytes : 2_147_483_648)
      && whole(/^[a-f0-9]{64}$/, file.sha256), 'malformed package receipt');
  }
  return data;
}
export async function digestFile(path: string, maximumBytes = 2_147_483_648): Promise<Omit<ArtifactFile, 'name'>> {
  requireArtifact(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 2_147_483_648,
    'invalid package size bound');
  const before = await lstat(path);
  requireArtifact(before.isFile() && !before.isSymbolicLink() && before.size > 0
    && before.size <= maximumBytes, 'missing, linked or oversized package');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path);
  requireArtifact(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'package changed while hashing');
  return { bytes: before.size, sha256: digest.digest('hex') };
}
export async function stagePackages(identity: Identity, target: ArtifactTarget, signing: Signing,
  sources: string[], directory: string) {
  requireArtifact(Object.hasOwn(artifactTargets, target), 'unsupported target');
  const extensions = artifactTargets[target];
  requireArtifact(sources.length === extensions.length, 'incomplete native build');
  await mkdir(directory, { recursive: true });
  const files: ArtifactFile[] = [];
  for (const [index, extension] of extensions.entries()) {
    const name = artifactName(identity, target, extension);
    const maximum = Object.hasOwn(companionTargets, target) ? companionMaximumBytes : 2_147_483_648;
    const original = await digestFile(sources[index], maximum);
    const destination = join(directory, name);
    await copyFile(sources[index], destination);
    const copied = await digestFile(destination, maximum);
    requireArtifact(original.bytes === copied.bytes && original.sha256 === copied.sha256, 'package copy mismatch');
    files.push({ name, ...copied });
  }
  const receipt = validateReceipt({ ...identity, schema: 1, target, signing, files }, identity);
  await Bun.write(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
export async function aggregatePackages(identity: Identity, source: string, destination: string) {
  const targets = releaseTargets;
  requireArtifact((await readdir(source)).sort().join(',') === targets.map(t => `release-${t}`).sort().join(','),
    'missing or unexpected platform artifacts');
  await mkdir(destination, { recursive: true });
  const receipts: ArtifactReceipt[] = [];
  for (const target of targets) {
    const directory = join(source, `release-${target}`);
    const receiptFile = Bun.file(join(directory, 'receipt.json'));
    requireArtifact(receiptFile.size > 0 && receiptFile.size < 16_384, 'invalid receipt size');
    const receipt = validateReceipt(await receiptFile.json(), identity);
    requireArtifact(receipt.target === target, 'platform receipt substitution');
    requireArtifact((await readdir(directory)).sort().join(',')
      === ['receipt.json', ...receipt.files.map(file => file.name)].sort().join(','), 'unexpected package files');
    for (const file of receipt.files) {
      const path = join(directory, file.name);
      const actual = await digestFile(path, file.bytes);
      requireArtifact(actual.bytes === file.bytes && actual.sha256 === file.sha256, 'downloaded package digest mismatch');
      await copyFile(path, join(destination, file.name));
      requireArtifact((await digestFile(join(destination, file.name))).sha256 === file.sha256, 'aggregate copy mismatch');
    }
    receipts.push(receipt);
  }
  await Bun.write(join(destination, 'release.json'), `${JSON.stringify({ schema: 1, ...identity, platforms: receipts }, null, 2)}\n`);
  const checksums: string[] = [];
  for (const name of (await readdir(destination)).sort()) {
    requireArtifact(name === basename(name) && name !== 'SHA256SUMS', 'unsafe aggregate output');
    checksums.push(`${(await digestFile(join(destination, name))).sha256}  ${name}`);
  }
  await Bun.write(join(destination, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
}
export async function verifyAggregate(identity: Identity, directory: string) {
  const manifestFile = Bun.file(join(directory, 'release.json'));
  requireArtifact(manifestFile.size > 0 && manifestFile.size < 65_536, 'invalid aggregate manifest');
  const manifest = await manifestFile.json();
  requireArtifact(manifest.schema === 1 && manifest.sha === identity.sha && manifest.version === identity.version
    && Array.isArray(manifest.platforms) && manifest.platforms.length === releaseTargets.length,
  'invalid aggregate identity');
  const seen = new Set<string>();
  const packages: string[] = [];
  for (const value of manifest.platforms) {
    const receipt = validateReceipt(value, identity);
    requireArtifact(releaseTargets.includes(receipt.target) && !seen.has(receipt.target), 'unexpected or duplicate platform');
    seen.add(receipt.target);
    for (const file of receipt.files) {
      const actual = await digestFile(join(directory, file.name), file.bytes);
      requireArtifact(actual.sha256 === file.sha256 && actual.bytes === file.bytes, 'aggregate package changed');
      packages.push(file.name);
    }
  }
  const names = ['release.json', 'release-notes.md', 'INSTALL-AND-UPDATE.md', ...packages].sort();
  requireArtifact((await readdir(directory)).sort().join(',') === [...names, 'SHA256SUMS'].sort().join(','),
    'incomplete aggregate or unexpected files');
  const lines: string[] = [];
  for (const name of names) lines.push(`${(await digestFile(join(directory, name))).sha256}  ${name}`);
  requireArtifact(await Bun.file(join(directory, 'SHA256SUMS')).text() === `${lines.join('\n')}\n`, 'aggregate checksums changed');
}
export async function buildIdentity(root: string): Promise<Identity> {
  requireArtifact(process.env.GITHUB_REF === 'refs/heads/main'
    && ['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? ''), 'trusted main build required');
  await verifyRelease(root);
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const sha = git.stdout.toString().trim();
  requireArtifact(git.exitCode === 0 && sha === process.env.GITHUB_SHA, 'checkout differs from event');
  const version = (await Bun.file(join(root, 'package.json')).json()).version;
  const identity = { sha, version };
  artifactName(identity, 'linux-x64', 'deb');
  return identity;
}

export async function releaseNotes(root: string, version: string, initial = false) {
  const changelog = await Bun.file(join(root, 'apps/client/CHANGELOG.md')).text();
  const section = changelog.split(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm'))[1]?.split(/^## /m)[0];
  requireArtifact(section?.trim(), 'missing version changelog');
  let notes = section.trim();
  if (initial) {
    const policy = await Bun.file(join(root, '.changeset/release-policy.json')).json();
    requireArtifact(policy.initialPublication?.version === version, 'initial notes version not allowlisted');
    const current = (await Bun.file(join(root, 'CHANGELOG.md')).text()).split(/^## \[Unreleased\]\s*$/m)[1]?.split(/^## /m)[0];
    requireArtifact(current?.trim(), 'missing initial development changes');
    notes += `\n\n## Changes since version preparation\n\n${current.trim()}`;
  }
  const guide = await Bun.file(join(root, 'docs/install-and-update.md')).text();
  const status = guide.split(/^## Current native acceptance status\s*$/m);
  requireArtifact(status.length === 2, 'missing or ambiguous native acceptance status');
  const sectionStatus = status[1].split(/^## /m)[0].trim();
  requireArtifact(sectionStatus, 'empty native acceptance status');
  notes += `\n\n## Current native acceptance status\n\n${sectionStatus}`;
  return `${notes}\n\nSee the attached installation guide and release.json for architecture, signing and channel limitations.\n`;
}

if (import.meta.main) {
  const root = process.cwd();
  const identity = await buildIdentity(root);
  const [command, directory] = process.argv.slice(2);
  requireArtifact(directory, 'private output directory required');
  if (command === 'identity') {
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, 'identity.json'), JSON.stringify(identity));
  } else if (command === 'aggregate') {
    await aggregatePackages(identity, directory, process.argv[4]);
  } else if (command === 'verify') {
    await verifyAggregate(identity, directory);
  } else if (command === 'notes') {
    await Bun.write(join(directory, 'release-notes.md'), await releaseNotes(root, identity.version, process.env.LAZYSH_RELEASE_INITIAL === 'true'));
    await copyFile(join(root, 'docs/install-and-update.md'), join(directory, 'INSTALL-AND-UPDATE.md'));
  } else {
    requireArtifact(command === 'stage', 'unknown command');
    await stagePackages(identity, process.argv[4] as ArtifactTarget, process.argv[5] as Signing,
      process.argv.slice(6), directory);
  }
}
