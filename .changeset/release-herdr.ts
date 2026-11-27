import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactName, artifactTargets, buildIdentity, digestFile, packageMaximumBytes, stagePackages, validateReceipt, type ArtifactTarget,
  type Identity } from './release-artifacts';
import { companionFormat } from './release-companion';

// The managed Herdr as a verified release asset (#1758): the release-profile executable, its notice inventory and the build
// receipt that binds both to the source identity of the tag. Contract: packages/herdr-upstream/PROVENANCE.md.
export const herdrTargets = ['linux-herdr-x64', 'linux-herdr-notices-x64'] as const satisfies readonly ArtifactTarget[];
const buildTarget = 'x86_64-unknown-linux-gnu', features = ['lazysh-managed'];
const repository = 'https://api.github.com/repos/mihazs/lazysh';

function requireHerdr(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release Herdr: ${message}`);
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The receipt of the exact bytes, the notice inventory of the same build and the tag's identity must name one source, one
 * target and one feature set. `pinned` (staging only) adds the upstream commit and manifest digest the repository records.
 */
export function bindHerdr(identity: Identity, receipt: any, notices: any, binarySha256: string,
  pinned?: { sourceCommit: string; manifestSha256: string }) {
  requireHerdr(receipt?.schemaVersion === 1 && receipt.profile === 'release' && receipt.target === buildTarget
    && same(receipt.features, features), 'unexpected build receipt');
  requireHerdr(receipt.checkout === identity.sha && receipt.binarySha256 === binarySha256, 'receipt does not bind these bytes to the tag source');
  requireHerdr(notices?.schemaVersion === 1 && notices.build?.checkout === identity.sha && notices.build.target === receipt.target
    && same(notices.build.features, receipt.features), 'notices do not describe this build');
  requireHerdr(notices.upstream?.commit === receipt.sourceCommit && notices.upstream.sourceManifestSha256 === receipt.manifestSha256,
    'notices name a different Herdr source than the receipt');
  if (pinned) requireHerdr(receipt.sourceCommit === pinned.sourceCommit && receipt.manifestSha256 === pinned.manifestSha256,
    'receipt names an unpinned Herdr source');
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string>; cleared?: boolean; stdout?: string } = {}) {
  const child = Bun.spawn(command, { cwd: options.cwd, env: { ...(options.cleared ? {} : process.env), ...options.env }, stdout: options.stdout ? Bun.file(options.stdout) : 'inherit', stderr: 'inherit' });
  requireHerdr(await child.exited === 0, `${command.slice(0, 2).join(' ')} failed`);
}

/** Seal the built executable: notices, receipt, binding, a header and self test, then the two staged receipts. */
export async function stageHerdr(root: string, executable: string, directory: string) {
  const identity = await buildIdentity(root);
  const herdr = join(root, 'packages/herdr-upstream'), manifest = join(herdr, 'SOURCE-MANIFEST.sha256');
  const reviewed = await Bun.file(join(root, '.github/herdr-notices/reviewed.json')).json();
  const work = await mkdtemp(join(tmpdir(), 'lazysh-herdr-release-'));
  try {
    const metadata = join(work, 'cargo-metadata.json'), notices = join(work, 'notices'), receipt = join(work, 'receipt.json');
    await run(['cargo', '+1.96.1', 'metadata', '--locked', '--format-version', '1', '--filter-platform', buildTarget, '--features', features.join(',')],
      { cwd: herdr, stdout: metadata });
    await run([process.execPath, join(root, '.github/scripts/herdr-notices.ts'), '--repo', root, '--checkout', identity.sha, '--metadata', metadata,
      '--zig-packages', join(herdr, 'vendor/libghostty-vt/zig-pkg'), '--target', buildTarget, '--features', features.join(','), '--out', notices]);
    await run(['sh', join(root, '.github/scripts/herdr-release-receipt.sh'), executable, manifest, receipt],
      { env: { HERDR_SOURCE_COMMIT: reviewed.upstream.commit, HERDR_FEATURES: features.join(' '), GITHUB_SHA: identity.sha } });
    const binary = await digestFile(executable, packageMaximumBytes('linux-herdr-x64', 'bin'));
    bindHerdr(identity, await Bun.file(receipt).json(), await Bun.file(join(notices, 'notices.json')).json(), binary.sha256,
      { sourceCommit: reviewed.upstream.commit, manifestSha256: sha256(new Uint8Array(await Bun.file(manifest).arrayBuffer())) });
    companionFormat('linux-agent-x64', new Uint8Array(await Bun.file(executable).slice(0, 65_536).arrayBuffer()));
    // The host script runs the same check in a cleared environment before it publishes the executable on a host.
    const home = join(work, 'home');
    await mkdir(home);
    await run([executable, '--version'], { cleared: true, env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', LC_ALL: 'C' } });
    await stagePackages(identity, 'linux-herdr-x64', 'unsigned', [executable], join(directory, 'release-linux-herdr-x64'));
    await stagePackages(identity, 'linux-herdr-notices-x64', 'unsigned', [join(notices, 'notices.json'), join(notices, 'NOTICES.txt'), receipt],
      join(directory, 'release-linux-herdr-notices-x64'));
    return identity;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export type Transport = typeof fetch;
async function download(url: string, maximum: number, transport: Transport) {
  const response = await transport(url, { headers: { Accept: 'application/vnd.github+json' } });
  requireHerdr(response.ok, `download failed (${response.status})`);
  const declared = response.headers.get('content-length');
  requireHerdr(declared === null || (/^\d+$/.test(declared) && Number(declared) <= maximum), 'download declares an oversized body');
  // shortcut: the body is buffered whole and checked afterwards; the declared bound and a 64 MiB cap keep that small.
  const bytes = new Uint8Array(await response.arrayBuffer());
  requireHerdr(bytes.length > 0 && bytes.length <= maximum, 'empty or oversized download');
  return bytes;
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * After publication: the public release, its tag and `release.json` must agree, and the downloaded executable, notice
 * inventory, notice text and build receipt must match the receipts and GitHub's own digests. `expectedSha` pins the
 * candidate that this run published.
 */
export async function verifyPublishedHerdr(tag: string, expectedSha?: string, transport: Transport = (...args) => fetch(...args)) {
  requireHerdr(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag), 'invalid tag');
  const json = async (url: string) => JSON.parse(text(await download(url, 262_144, transport)));
  const release = await json(`${repository}/releases/tags/${tag}`);
  requireHerdr(release?.tag_name === tag && release.draft === false && release.prerelease === false && Array.isArray(release.assets), 'public release');
  const ref = await json(`${repository}/git/ref/tags/${tag}`);
  const sha = ref?.object?.sha as string;
  requireHerdr(ref.ref === `refs/tags/${tag}` && ref.object.type === 'commit' && /^[a-f0-9]{40}$/.test(sha) && (!expectedSha || sha === expectedSha),
    'tag does not identify the published source');
  const identity = { sha, version: tag.slice(1) };
  const fetched = async (name: string, maximum: number, size?: number, digest?: string) => {
    const assets = release.assets.filter((asset: any) => asset?.name === name);
    requireHerdr(assets.length === 1, `asset ${name} is not published exactly once`);
    const [asset] = assets;
    requireHerdr(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maximum
      && /^sha256:[a-f0-9]{64}$/.test(asset.digest) && asset.browser_download_url === `https://github.com/mihazs/lazysh/releases/download/${tag}/${name}`
      && (size === undefined || asset.size === size) && (digest === undefined || asset.digest === `sha256:${digest}`), `asset ${name} identity`);
    const bytes = await download(asset.browser_download_url, maximum, transport);
    requireHerdr(bytes.length === asset.size && `sha256:${sha256(bytes)}` === asset.digest, `asset ${name} download digest`);
    return bytes;
  };
  const manifest = JSON.parse(text(await fetched('release.json', 65_536)));
  requireHerdr(manifest?.schema === 1 && manifest.sha === sha && manifest.version === identity.version && Array.isArray(manifest.platforms), 'release.json identity');
  const files = new Map<string, Uint8Array>();
  for (const target of herdrTargets) {
    const entries = manifest.platforms.filter((value: any) => value?.target === target);
    requireHerdr(entries.length === 1, `release.json lists ${target} exactly once`);
    const receipt = validateReceipt(entries[0], identity);
    for (const [index, file] of receipt.files.entries()) files.set(file.name,
      await fetched(file.name, packageMaximumBytes(target, artifactTargets[target][index]), file.bytes, file.sha256));
  }
  const name = (target: ArtifactTarget, extension: string) => artifactName(identity, target, extension);
  const executable = files.get(name('linux-herdr-x64', 'bin'))!;
  companionFormat('linux-agent-x64', executable.subarray(0, 65_536));
  const notices = JSON.parse(text(files.get(name('linux-herdr-notices-x64', 'json'))!));
  const receipt = JSON.parse(text(files.get(name('linux-herdr-notices-x64', 'receipt.json'))!));
  bindHerdr(identity, receipt, notices, sha256(executable));
  requireHerdr(text(files.get(name('linux-herdr-notices-x64', 'txt'))!).includes(`https://github.com/mihazs/lazysh/tree/${sha}/packages/herdr-guard`),
    'notice text does not name the tag source');
  return identity;
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'stage') {
    requireHerdr(args[0] && process.env.CARGO_TARGET_DIR, 'output directory and Cargo target directory required');
    const identity = await stageHerdr(process.cwd(), join(process.env.CARGO_TARGET_DIR!, 'release/herdr'), args[0]);
    console.info(`Herdr release staging passed: ${identity.version} ${identity.sha}`);
  } else {
    requireHerdr(mode === 'verify-published' && args[0], 'unknown command');
    const identity = await verifyPublishedHerdr(args[0], args[1]);
    console.info(`Published Herdr assets verified: ${args[0]} ${identity.sha}`);
  }
}
