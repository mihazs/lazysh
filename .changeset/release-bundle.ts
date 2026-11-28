import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildIdentity, companionMaximumBytes, digestFile, validateReceipt, type CompanionTarget, type Identity } from './release-artifacts';

/**
 * Every desktop package ships the companion of its own platform beside the app (a Tauri
 * `bundle.externalBin` entry). Tauri names the staged file after the host triple it builds for,
 * which is not always the triple the companion was compiled for (Linux ships a static musl build).
 */
export const desktopCompanions = {
  'linux-x64': { companion: 'linux-agent-x64', triple: 'x86_64-unknown-linux-gnu' },
  'windows-x64': { companion: 'windows-agent-x64', triple: 'x86_64-pc-windows-msvc' },
  'macos-arm64': { companion: 'macos-agent-arm64', triple: 'aarch64-apple-darwin' },
  'macos-x64': { companion: 'macos-agent-x64', triple: 'x86_64-apple-darwin' },
} as const satisfies Record<string, { companion: CompanionTarget; triple: string }>;
export type DesktopTarget = keyof typeof desktopCompanions;
export type PublishedCompanion = { target: CompanionTarget; file: string; bytes: number; sha256: string };

function requireBundle(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release bundle: ${message}`);
}
/** Where Tauri looks for the sidecar, relative to `apps/client/src-tauri` (see `tauri.bundled-agent.conf.json`). */
export const sidecarPath = (desktop: DesktopTarget) =>
  `binaries/lazysh-agent-${desktopCompanions[desktop].triple}${desktop === 'windows-x64' ? '.exe' : ''}`;

/** The companion the release staged for a desktop target: its receipt bound to this build, and the bytes the receipt names. */
export async function publishedCompanion(identity: Identity, desktop: DesktopTarget, directory: string): Promise<PublishedCompanion> {
  requireBundle(Object.hasOwn(desktopCompanions, desktop), 'unsupported desktop target');
  const { companion } = desktopCompanions[desktop];
  const receiptFile = Bun.file(join(directory, 'receipt.json'));
  requireBundle(receiptFile.size > 0 && receiptFile.size < 16_384, 'invalid companion receipt size');
  const receipt = validateReceipt(await receiptFile.json(), identity);
  requireBundle(receipt.target === companion, 'companion receipt is for another platform');
  const [staged] = receipt.files;
  requireBundle((await readdir(directory)).sort().join(',') === ['receipt.json', staged.name].sort().join(','),
    'unexpected companion files');
  const file = join(directory, staged.name);
  const actual = await digestFile(file, companionMaximumBytes);
  requireBundle(actual.bytes === staged.bytes && actual.sha256 === staged.sha256, 'companion differs from its receipt');
  return { target: companion, file, ...actual };
}
async function placeSidecar(source: { file: string; bytes: number; sha256: string }, desktop: DesktopTarget, root: string) {
  const destination = join(root, 'apps/client/src-tauri', sidecarPath(desktop));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source.file, destination);
  await chmod(destination, 0o755);
  const copied = await digestFile(destination, companionMaximumBytes);
  requireBundle(copied.bytes === source.bytes && copied.sha256 === source.sha256, 'staged sidecar differs from the published companion');
  return destination;
}
/** Copies the published companion to the sidecar path, byte for byte; the Tauri build then packages that file. */
export async function stageSidecar(identity: Identity, desktop: DesktopTarget, directory: string, root: string) {
  const published = await publishedCompanion(identity, desktop, directory);
  return { ...published, destination: await placeSidecar(published, desktop, root) };
}
/** The desktop target of the machine running this, which is the one Tauri names the sidecar for. */
export function hostDesktop(platform = process.platform, arch = process.arch): DesktopTarget {
  const target = `${platform}-${arch}`;
  const desktop = { 'linux-x64': 'linux-x64', 'win32-x64': 'windows-x64', 'darwin-arm64': 'macos-arm64', 'darwin-x64': 'macos-x64' }[target];
  requireBundle(desktop, `unsupported desktop host ${target}`);
  return desktop as DesktopTarget;
}
/**
 * For the checks that package the app on every main push: stages the companion this checkout just
 * built (a release build, `target/release`), which has no release receipt to verify.
 */
export async function stageBuiltSidecar(root: string, desktop = hostDesktop()) {
  const file = join(root, 'target/release', desktop === 'windows-x64' ? 'lazysh-agent.exe' : 'lazysh-agent');
  let actual;
  try { actual = await digestFile(file, companionMaximumBytes); }
  catch { requireBundle(false, 'no built companion to stage in target/release'); }
  const built = { file, ...actual };
  return { ...built, destination: await placeSidecar(built, desktop, root) };
}
/** Requires the file inside a package to be exactly the published companion. */
export async function requireBundled(path: string, published: PublishedCompanion, where: string) {
  let actual;
  try { actual = await digestFile(path, companionMaximumBytes); }
  catch { requireBundle(false, `${where} has no lazysh-agent`); }
  requireBundle(actual.bytes === published.bytes && actual.sha256 === published.sha256,
    `${where} lazysh-agent differs from the published companion`);
}

/** The content hash of every loaded section of a little-endian ELF64 image, by name. */
export function elfSections(image: Buffer) {
  requireBundle(image.length > 64 && image.readUInt32BE(0) === 0x7f454c46 && image[4] === 2 && image[5] === 1, 'not an ELF64 image');
  const table = Number(image.readBigUInt64LE(0x28)), entry = image.readUInt16LE(0x3a), count = image.readUInt16LE(0x3c);
  const header = (index: number) => {
    const at = table + index * entry;
    requireBundle(at + 64 <= image.length, 'truncated ELF section table');
    return { name: image.readUInt32LE(at), type: image.readUInt32LE(at + 4), flags: Number(image.readBigUInt64LE(at + 8)),
      offset: Number(image.readBigUInt64LE(at + 24)), size: Number(image.readBigUInt64LE(at + 32)) };
  };
  const names = header(image.readUInt16LE(0x3e));
  const sections = new Map<string, string>();
  for (let index = 1; index < count; index++) {
    const section = header(index);
    // SHT_NOBITS (8) holds no bytes; SHF_ALLOC (2) marks what the loader maps.
    if (section.type === 8 || !(section.flags & 2)) continue;
    const start = names.offset + section.name;
    requireBundle(section.offset + section.size <= image.length, 'truncated ELF section');
    sections.set(image.toString('latin1', start, image.indexOf(0, start)),
      createHash('sha256').update(image.subarray(section.offset, section.offset + section.size)).digest('hex'));
  }
  return sections;
}
// linuxdeploy adds a RUNPATH to every executable in an AppImage's usr/bin, which rewrites only these two.
const rewrittenByLinuxdeploy = new Set(['.dynamic', '.dynstr']);
/** Like `requireBundled` for an AppImage: the published executable with only its dynamic section rewritten. */
export async function requireBundledImage(path: string, published: PublishedCompanion, where: string) {
  let actual;
  try { actual = await digestFile(path, companionMaximumBytes); }
  catch { requireBundle(false, `${where} has no lazysh-agent`); }
  if (actual.bytes === published.bytes && actual.sha256 === published.sha256) return;
  const bundled = elfSections(Buffer.from(await Bun.file(path).arrayBuffer()));
  const original = elfSections(Buffer.from(await Bun.file(published.file).arrayBuffer()));
  for (const name of new Set([...bundled.keys(), ...original.keys()])) {
    requireBundle(rewrittenByLinuxdeploy.has(name) || bundled.get(name) === original.get(name),
      `${where} lazysh-agent differs from the published companion in ${name}`);
  }
}

if (import.meta.main) {
  const [command, target, directory] = process.argv.slice(2);
  const root = resolve('.');
  if (command === 'stage-built') {
    const staged = await stageBuiltSidecar(root);
    console.info(`Built companion staged: bytes=${staged.bytes} sha256=${staged.sha256}`);
  } else {
    requireBundle(command === 'stage' && Object.hasOwn(desktopCompanions, target) && directory,
      'usage: stage <desktop target> <companion artifact directory> | stage-built');
    const staged = await stageSidecar(await buildIdentity(root), target as DesktopTarget, resolve(directory), root);
    console.info(`Bundled companion staged: ${target} bytes=${staged.bytes} sha256=${staged.sha256}`);
  }
}
