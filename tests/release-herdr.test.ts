import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePackages, artifactName, artifactTargets, releaseTargets, stagePackages, type ArtifactTarget } from '../.changeset/release-artifacts';
import { bindHerdr, verifyPublishedHerdr } from '../.changeset/release-herdr';

const identity = { sha: 'a'.repeat(40), version: '0.22.0' }, tag = 'v0.22.0';
const upstream = { sourceCommit: '2'.repeat(40), manifestSha256: '3'.repeat(64) };
const hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
// A 64-byte x86-64 ELF header is all the published check reads of the executable.
const elf = (padding = 'executable') => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, ...Array(9).fill(0), 3, 0, 62, 0]), Buffer.alloc(44), Buffer.from(padding)]);
const receiptFor = (binary: Uint8Array, checkout = identity.sha) => ({ schemaVersion: 1, target: 'x86_64-unknown-linux-gnu', profile: 'release', features: ['lazysh-managed'],
  sourceCommit: upstream.sourceCommit, manifestSha256: upstream.manifestSha256, checkout, binarySha256: hex(binary) });
const inventory = (checkout = identity.sha) => ({ schemaVersion: 1, build: { target: 'x86_64-unknown-linux-gnu', features: ['lazysh-managed'], checkout },
  upstream: { commit: upstream.sourceCommit, sourceManifestSha256: upstream.manifestSha256 } });
const noticeText = (sha = identity.sha) => `Corresponding source: https://github.com/mihazs/lazysh/tree/${sha}/packages/herdr-guard\n`;

test('the receipt, the notice inventory and the tag source must describe the same executable bytes', () => {
  const binary = elf(), good = [identity, receiptFor(binary), inventory(), hex(binary), upstream] as const;
  bindHerdr(...good);
  const rejected = (receipt: object, notices: object, digest = hex(binary), pinned: typeof upstream | undefined = upstream) =>
    expect(() => bindHerdr(identity, { ...receiptFor(binary), ...receipt }, { ...inventory(), ...notices }, digest, pinned)).toThrow('Release Herdr:');
  rejected({ checkout: 'b'.repeat(40) }, {});
  rejected({}, {}, hex('other bytes'));
  rejected({ profile: 'debug' }, {});
  rejected({ features: [] }, {});
  rejected({}, { build: { ...inventory().build, checkout: 'b'.repeat(40) } });
  rejected({}, { build: { ...inventory().build, features: ['lazysh-managed', 'extra'] } });
  rejected({}, { upstream: { ...inventory().upstream, commit: '4'.repeat(40) } });
  rejected({}, { upstream: { ...inventory().upstream, sourceManifestSha256: '5'.repeat(64) } });
  rejected({ sourceCommit: '4'.repeat(40) }, { upstream: { ...inventory().upstream, commit: '4'.repeat(40) } });
});

type Published = { binary: Buffer; notices: object; text: string; receipt: object; sha: string; tagSha: string };
/** A release as GitHub serves it: the aggregate of every target, with the Herdr files replaced by `options`. */
async function publish(root: string, options: Partial<Published> = {}) {
  const binary = options.binary ?? elf(), sha = options.sha ?? identity.sha;
  const contents: Record<string, string | Uint8Array> = {
    json: JSON.stringify(options.notices ?? inventory()), txt: options.text ?? noticeText(), 'receipt.json': JSON.stringify(options.receipt ?? receiptFor(binary)), bin: binary };
  for (const target of releaseTargets) {
    const sources: string[] = [];
    for (const extension of artifactTargets[target]) {
      const path = join(root, `${target}.${extension}`);
      await Bun.write(path, target.includes('herdr') ? contents[extension] : `fixture ${target} ${extension}`);
      sources.push(path);
    }
    await stagePackages({ ...identity, sha }, target, target.startsWith('macos-') ? 'ad-hoc' : target.startsWith('android-') ? 'signed' : 'unsigned', sources, join(root, 'incoming', `release-${target}`));
  }
  const assets = join(root, 'assets');
  await aggregatePackages({ ...identity, sha }, join(root, 'incoming'), assets);
  const url = (name: string) => `https://github.com/mihazs/lazysh/releases/download/${tag}/${name}`;
  const release = { tag_name: tag, draft: false, prerelease: false, assets: await Promise.all((await readdir(assets)).map(async name => {
    const bytes = new Uint8Array(await Bun.file(join(assets, name)).arrayBuffer());
    return { name, size: bytes.length, digest: `sha256:${hex(bytes)}`, state: 'uploaded', browser_download_url: url(name) };
  })) };
  const served = new Map<string, Uint8Array | object>([['https://api.github.com/repos/mihazs/lazysh/releases/tags/' + tag, release],
    ['https://api.github.com/repos/mihazs/lazysh/git/ref/tags/' + tag, { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: options.tagSha ?? sha } }]]);
  for (const name of await readdir(assets)) served.set(url(name), new Uint8Array(await Bun.file(join(assets, name)).arrayBuffer()));
  const transport = (async (input: string) => {
    const body = served.get(input);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body instanceof Uint8Array ? body : JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { transport, served, release, url };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-release-herdr-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('the release names the executable and its notice bundle as two receipts under the updater contract', () => {
  expect(artifactName(identity, 'linux-herdr-x64', 'bin')).toBe('lazysh-0.22.0-linux-herdr-x64.bin');
  expect(artifactTargets['linux-herdr-x64']).toEqual(['bin']);
  expect(artifactTargets['linux-herdr-notices-x64'].map(extension => artifactName(identity, 'linux-herdr-notices-x64', extension))).toEqual([
    'lazysh-0.22.0-linux-herdr-notices-x64.json', 'lazysh-0.22.0-linux-herdr-notices-x64.txt', 'lazysh-0.22.0-linux-herdr-notices-x64.receipt.json']);
});

test('a complete public release with both Herdr assets verifies against its tag', () => fixture(async root => {
  const { transport } = await publish(root);
  expect(await verifyPublishedHerdr(tag, identity.sha, transport)).toEqual(identity);
}));

test.each([
  ['an executable that is not an x86-64 ELF', { binary: Buffer.from('#!/bin/sh\n'.padEnd(80)) }, 'ELF architecture mismatch'],
  ['notices of another checkout', { notices: inventory('b'.repeat(40)) }, 'notices do not describe this build'],
  ['a receipt for different executable bytes', { receipt: receiptFor(elf('other')) }, 'does not bind these bytes'],
  ['notice text naming another commit', { text: noticeText('b'.repeat(40)) }, 'notice text'],
])('%s is refused after publication', (_, options, message) => fixture(async root => {
  const { transport } = await publish(root, options as Partial<Published>);
  await expect(verifyPublishedHerdr(tag, identity.sha, transport)).rejects.toThrow(new RegExp(message));
}));

test('a tag on another commit, a changed asset and a missing asset are refused', () => fixture(async root => {
  const { transport, served, release, url } = await publish(root);
  await expect(verifyPublishedHerdr(tag, 'c'.repeat(40), transport)).rejects.toThrow('tag does not identify');
  const executable = url('lazysh-0.22.0-linux-herdr-x64.bin');
  const original = served.get(executable)!;
  served.set(executable, Buffer.concat([original as Uint8Array, Buffer.from('x')]));
  await expect(verifyPublishedHerdr(tag, identity.sha, transport)).rejects.toThrow('download');
  served.set(executable, original);
  release.assets = release.assets.filter(asset => !asset.name.endsWith('notices-x64.txt'));
  await expect(verifyPublishedHerdr(tag, identity.sha, transport)).rejects.toThrow('not published exactly once');
  await expect(verifyPublishedHerdr('v0.22', identity.sha, transport)).rejects.toThrow('invalid tag');
}));

// A just-published release can answer 403 or 404 for a moment (and a shared runner address can be rate limited); the publish job must not
// end red for a release that is correct (#2995).
test('a release that answers 403 for a moment after publication still verifies, and a persistent 403 still fails', () => fixture(async root => {
  const { transport } = await publish(root);
  const calls = new Map<string, number>();
  const flaky = (async (input: string, init?: RequestInit) => {
    const seen = (calls.get(input) ?? 0) + 1;
    calls.set(input, seen);
    return seen <= 2 ? new Response('forbidden', { status: 403 }) : (transport as any)(input, init);
  }) as unknown as typeof fetch;
  expect(await verifyPublishedHerdr(tag, identity.sha, flaky, [0, 0, 0, 0])).toEqual(identity);
  expect([...calls.values()].every(count => count === 3)).toBe(true);
  let attempts = 0;
  const denied = (async () => { attempts += 1; return new Response('forbidden', { status: 403 }); }) as unknown as typeof fetch;
  await expect(verifyPublishedHerdr(tag, identity.sha, denied, [0, 0, 0, 0])).rejects.toThrow('download failed (403)');
  expect(attempts).toBe(5);
}));
test('a wrong digest is judged on the first answer without retries', () => fixture(async root => {
  const { transport, served, url } = await publish(root);
  const executable = url('lazysh-0.22.0-linux-herdr-x64.bin');
  served.set(executable, Buffer.concat([served.get(executable) as Uint8Array, Buffer.from('x')]));
  let requests = 0;
  const counting = (async (input: string, init?: RequestInit) => { requests += 1; return (transport as any)(input, init); }) as unknown as typeof fetch;
  await expect(verifyPublishedHerdr(tag, identity.sha, counting, [1_000_000])).rejects.toThrow('download');
  expect(requests).toBeLessThan(20);
}));
