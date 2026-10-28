import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { currentCandidate, releaseEnabled, requireCurrentRelease, type Candidate, type ReleasePolicy } from './release-tag';
import { digestFile, verifyAggregate } from './release-artifacts';

type Request = (path: string, method: string, body?: unknown) => Promise<Response>;
export async function publishInstallationSet(next: Candidate, policy: ReleasePolicy, directory: string,
  request: Request, admitMain: (sha: string) => Promise<void>) {
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`Release publication: ${message}`);
  };
  check(releaseEnabled(policy), 'disabled by GitHub release policy');
  await verifyAggregate(next, directory);
  const main = await request('git/ref/heads/main', 'GET');
  check(main.ok, 'cannot observe main');
  await admitMain((await main.json() as any).object?.sha);
  const tag = await request(`git/ref/tags/${next.tag}`, 'GET');
  check(tag.ok, 'verified tag must already exist');
  const target = await tag.json() as any;
  check(target.ref === `refs/tags/${next.tag}` && target.object?.type === 'commit' && target.object.sha === next.sha,
    'tag does not identify verified source');
  const previous = await request(`releases/tags/${next.tag}`, 'GET');
  check(previous.status === 404, 'release exists or cannot be inspected; no replacement or automatic replay');
  const created = await request('releases', 'POST', { tag_name: next.tag, target_commitish: next.sha,
    name: `lazysh ${next.version}`, body: await Bun.file(join(directory, 'release-notes.md')).text(),
    draft: true, prerelease: false });
  check(created.status === 201, 'cannot create draft release');
  const release = await created.json() as any;
  check(Number.isSafeInteger(release.id) && release.id > 0 && release.draft === true && release.tag_name === next.tag,
    'unexpected draft identity');
  // Failed uploads intentionally leave a draft for explicit operator inspection.
  // Never publish a partial set, replace bytes or silently repeat an uncertain call.
  for (const name of (await readdir(directory)).sort()) {
    const response = await request(`releases/${release.id}/assets?name=${encodeURIComponent(name)}`, 'UPLOAD', Bun.file(join(directory, name)));
    check(response.status === 201, 'asset upload failed; draft retained');
    const asset = await response.json() as any;
    check(asset.name === name && asset.state === 'uploaded'
      && asset.size === Bun.file(join(directory, name)).size
      && asset.digest === `sha256:${(await digestFile(join(directory, name))).sha256}`,
    'asset acknowledgement mismatch; draft retained');
  }
  const finalTag = await request(`git/ref/tags/${next.tag}`, 'GET');
  const finalTarget = finalTag.ok ? await finalTag.json() as any : null;
  check(finalTarget?.object?.type === 'commit' && finalTarget.object.sha === next.sha, 'tag changed; draft retained');
  const final = await request(`releases/${release.id}`, 'PATCH', { draft: false });
  check(final.ok, 'publication outcome uncertain; inspect exact release before any further action');
  const published = await final.json() as any;
  check(published.id === release.id && published.draft === false && published.tag_name === next.tag,
    'publication acknowledgement mismatch');
}
if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory || !process.env.GH_TOKEN || process.env.GITHUB_REPOSITORY !== 'mihazs/lazysh') {
    throw new Error('Release publication requires owned directory, repository and authentication');
  }
  const root = process.cwd();
  const next = await currentCandidate(root);
  if (!next) throw new Error('Release version transition required');
  const policy = await Bun.file(join(root, '.changeset/release-policy.json')).json();
  const request: Request = (path, method, body) => fetch(
    `https://${method === 'UPLOAD' ? 'uploads' : 'api'}.github.com/repos/mihazs/lazysh/${path}`, {
      method: method === 'UPLOAD' ? 'POST' : method, redirect: 'error',
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': method === 'UPLOAD'
          ? 'application/octet-stream' : 'application/json' } : {}) },
      body: method === 'UPLOAD' ? body as Blob : body ? JSON.stringify(body) : undefined,
    });
  await publishInstallationSet(next, policy, directory, request, sha => requireCurrentRelease(root, next, sha));
}
