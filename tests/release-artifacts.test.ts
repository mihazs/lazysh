import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePackages, artifactName, artifactTargets, digestFile, stagePackages,
  validateReceipt, type ArtifactTarget } from '../.changeset/release-artifacts';
import { signingProfiles, iosBundleIds } from '../.changeset/release-apple';
import { javaProperty } from '../.changeset/release-android';
import { publishInstallationSet } from '../.changeset/release-publish';
import type { ReleasePolicy } from '../.changeset/release-tag';

const identity = { sha: 'a'.repeat(40), version: '0.22.0' };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-release-artifacts-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function platform(root: string, target: ArtifactTarget) {
  const sources: string[] = [];
  for (const extension of artifactTargets[target]) {
    const path = join(root, `${target}.${extension}`);
    await Bun.write(path, `owned unit fixture ${target} ${extension}`);
    sources.push(path);
  }
  return stagePackages(identity, target, target.startsWith('macos-') ? 'ad-hoc'
    : target.startsWith('linux-') || target.startsWith('windows-') ? 'unsigned' : 'signed',
  sources, join(root, 'incoming', `release-${target}`));
}
test('aggregation requires every platform and preserves exact bytes with checksums', () => fixture(async root => {
  for (const target of Object.keys(artifactTargets) as ArtifactTarget[]) await platform(root, target);
  const output = join(root, 'complete');
  await aggregatePackages(identity, join(root, 'incoming'), output);
  const manifest = await Bun.file(join(output, 'release.json')).json();
  expect(manifest.sha).toBe(identity.sha);
  expect(manifest.platforms).toHaveLength(7);
  for (const receipt of manifest.platforms) for (const file of receipt.files) {
    expect(await Bun.file(join(output, file.name)).text()).toBe(
      await Bun.file(join(root, 'incoming', `release-${receipt.target}`, file.name)).text());
  }
  const lines = (await Bun.file(join(output, 'SHA256SUMS')).text()).trim().split('\n');
  expect(lines).toHaveLength(11);
  for (const line of lines) {
    const [hash, name] = line.split('  ');
    expect((await digestFile(join(output, name))).sha256).toBe(hash);
  }
}));
test('download tampering and missing platforms cannot become a release', () => fixture(async root => {
  for (const target of Object.keys(artifactTargets) as ArtifactTarget[]) await platform(root, target);
  const source = join(root, 'incoming');
  const file = join(source, 'release-ios-arm64', artifactName(identity, 'ios-arm64', 'ipa'));
  await Bun.write(file, 'tampered');
  await expect(aggregatePackages(identity, source, join(root, 'bad'))).rejects.toThrow('digest mismatch');
  await rm(join(source, 'release-ios-arm64'), { recursive: true });
  await expect(aggregatePackages(identity, source, join(root, 'missing'))).rejects.toThrow('missing or unexpected');
}));
test('source substitutions, unsigned mobile, duplicate packages and path traversal fail closed', () => fixture(async root => {
  const receipt = await platform(root, 'android-google-arm64');
  for (const changed of [
    { ...receipt, sha: 'b'.repeat(40) }, { ...receipt, version: '0.23.0' },
    { ...receipt, signing: 'unsigned' }, { ...receipt, files: [...receipt.files, ...receipt.files] },
    { ...receipt, files: [{ ...receipt.files[0], name: '../private.apk' }] },
    { ...receipt, files: [{ ...receipt.files[0], bytes: 0 }] },
    { ...receipt, files: [{ ...receipt.files[0], sha256: 'x'.repeat(64) }] },
  ]) expect(() => validateReceipt(changed, identity)).toThrow('Release artifacts:');
  expect(() => artifactName({ ...identity, version: '0.22.0\n' }, 'ios-arm64', 'ipa')).toThrow();
}));
test('extra files and substituted receipt targets are rejected', () => fixture(async root => {
  for (const target of Object.keys(artifactTargets) as ArtifactTarget[]) await platform(root, target);
  const directory = join(root, 'incoming', 'release-linux-x64');
  await Bun.write(join(directory, 'private-key'), 'not a release asset');
  await expect(aggregatePackages(identity, join(root, 'incoming'), join(root, 'extra'))).rejects.toThrow('unexpected package');
  await rm(join(directory, 'private-key'));
  await Bun.write(join(directory, 'receipt.json'), JSON.stringify(await platform(root, 'windows-x64')));
  await expect(aggregatePackages(identity, join(root, 'incoming'), join(root, 'substituted'))).rejects.toThrow('substitution');
}));
test('linked, empty and missing native outputs cannot be staged', () => fixture(async root => {
  const source = join(root, 'source');
  const linked = join(root, 'linked');
  await Bun.write(source, 'owned fixture');
  await symlink(source, linked);
  for (const path of [linked, join(root, 'missing')]) await expect(digestFile(path)).rejects.toThrow();
  await Bun.write(source, '');
  await expect(digestFile(source)).rejects.toThrow('missing, linked or oversized');
  await mkdir(join(root, 'directory'));
  await expect(digestFile(join(root, 'directory'))).rejects.toThrow('missing, linked or oversized');
}));

test('Java signing properties preserve separators, whitespace, controls and surrogate pairs', () => {
  const original = ' 🔐=a:b\\c\n\r\t#! é ';
  const encoded = javaProperty(original);
  expect(encoded).not.toMatch(/[\r\n]/);
  expect(encoded.replace(/\\u([0-9a-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).toBe(original);
  expect(encoded).toContain('\\ud83d\\udd10');
});
test('Apple export requires exactly four bounded canonical profile encodings', () => {
  const valid = Object.fromEntries(iosBundleIds.map(id => [id, Buffer.from(id).toString('base64')]));
  expect(signingProfiles(valid)).toEqual(valid);
  for (const value of [null, [], {}, { ...valid, extra: 'aA==' }, { ...valid, [iosBundleIds[0]]: 'aA==\n' },
    { ...valid, [iosBundleIds[0]]: 'a'.repeat(524_292) }]) expect(() => signingProfiles(value)).toThrow();
});

const policy: ReleasePolicy = await Bun.file(new URL('../.changeset/release-policy.json', import.meta.url)).json();
const next = { ...identity, tag: `v${identity.version}`, versionCode: 22_000 };
async function installationSet(root: string) {
  for (const target of Object.keys(artifactTargets) as ArtifactTarget[]) await platform(root, target);
  const destination = join(root, 'installation-set');
  await mkdir(destination);
  for (const name of ['release-notes.md', 'INSTALL-AND-UPDATE.md']) await Bun.write(join(destination, name), `owned ${name}`);
  await aggregatePackages(identity, join(root, 'incoming'), destination);
  return destination;
}
async function publication(root: string, failure?: string, enabled = true) {
  const directory = await installationSet(root);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let tagReads = 0;
  const request = async (path: string, method: string, body?: unknown) => {
    calls.push({ path, method, body });
    if (path === 'git/ref/heads/main') return Response.json({ object: { sha: identity.sha } });
    if (path === `git/ref/tags/${next.tag}`) return Response.json({ ref: `refs/tags/${next.tag}`,
      object: { type: 'commit', sha: failure === 'tag' || failure === 'changed-tag' && tagReads++ > 0 ? 'b'.repeat(40) : identity.sha } });
    if (path === `releases/tags/${next.tag}`) return Response.json({}, { status: failure === 'existing' ? 200 : 404 });
    if (path === 'releases') return Response.json({ id: 8, draft: true, tag_name: next.tag }, { status: 201 });
    if (method === 'UPLOAD') {
      if (failure === 'upload') return Response.json({}, { status: 500 });
      const file = body as Blob;
      const hash = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
      return Response.json({ name: new URL(`https://uploads.github.com/${path}`).searchParams.get('name'),
        state: 'uploaded', size: file.size, digest: `sha256:${failure === 'digest' ? '0'.repeat(64) : hash}` }, { status: 201 });
    }
    if (method === 'PATCH') return Response.json({ id: 8, draft: false, tag_name: next.tag });
    throw new Error('Unexpected fixture API call');
  };
  const result = publishInstallationSet(next, enabled ? { ...policy, enabled: true, fossPushAccepted: true,
    officialSubmissionPrerequisitesAccepted: true } : policy, directory, request, async sha => {
    expect(sha).toBe(identity.sha);
    if (failure === 'main') throw new Error('superseded');
  });
  return { calls, result };
}
test('publication uploads a complete digest-acknowledged draft before making it public', () => fixture(async root => {
  const { calls, result } = await publication(root);
  await result;
  const uploads = calls.filter(call => call.method === 'UPLOAD');
  expect(uploads).toHaveLength(14);
  expect(calls.find(call => call.path === 'releases')?.body).toMatchObject({ draft: true, target_commitish: identity.sha });
  expect(calls.at(-1)).toEqual({ path: 'releases/8', method: 'PATCH', body: { draft: false } });
}));
test.each(['tag', 'changed-tag', 'existing', 'upload', 'digest', 'main'])(
  'uncertain or invalid release state cannot publish or overwrite: %s', failure => fixture(async root => {
    const { calls, result } = await publication(root, failure);
    await expect(result).rejects.toThrow();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(calls.every(call => !['DELETE', 'PUT'].includes(call.method))).toBe(true);
  }));
test('checked-in disabled policy rejects all publication APIs', () => fixture(async root => {
  const { calls, result } = await publication(root, undefined, false);
  await expect(result).rejects.toThrow('disabled');
  expect(calls).toEqual([]);
}));
