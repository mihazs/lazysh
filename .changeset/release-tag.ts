import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { androidVersionCode, verifyRelease } from './bun-lock';

export type ReleasePolicy = {
  enabled: boolean;
  fossPushAccepted: boolean;
  officialSubmissionPrerequisitesAccepted: boolean;
  recipeSha256: string;
};
export type Candidate = { sha: string; version: string; versionCode: number; tag: string };
function requireGate(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release gate: ${message}`);
}
export function releaseEnabled(policy: ReleasePolicy) {
  return policy.enabled === true && policy.fossPushAccepted === true
    && policy.officialSubmissionPrerequisitesAccepted === true;
}
export function candidate(input: {
  sha: string; ref: string; event: string; version: string; parentVersion: string; pending: string[];
}): Candidate {
  requireGate(input.ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(input.event), 'main event required');
  requireGate(/^[a-f0-9]{40}$/.test(input.sha), 'exact commit required');
  const versionCode = androidVersionCode(input.version);
  const previousCode = androidVersionCode(input.parentVersion);
  requireGate(Bun.semver.order(input.version, input.parentVersion) > 0 && versionCode > previousCode,
    'stable version transition from first parent required');
  requireGate(input.pending.length === 0, 'pending Changesets');
  return { sha: input.sha, version: input.version, versionCode, tag: `v${input.version}` };
}

function reviewedRecipe(template: string, policy: ReleasePolicy) {
  requireGate(createHash('sha256').update(template).digest('hex') === policy.recipeSha256, 'unreviewed recipe template');
  const before = Bun.YAML.parse(template) as any;
  requireGate(before.Builds?.length === 1 && before.AutoUpdateMode === 'None'
    && before.UpdateCheckMode === 'None', 'manual single-build recipe required');
  return before;
}
export function candidateRecipe(template: string, policy: ReleasePolicy, next: Candidate) {
  const before = reviewedRecipe(template, policy);
  const substitute = (text: string, pattern: RegExp, value: string) => {
    requireGate([...text.matchAll(pattern)].length === 1, 'ambiguous recipe selector');
    return text.replace(pattern, value);
  };
  let result = substitute(template, /^    commit: [a-f0-9]{40}$/gm, `    commit: ${next.sha}`);
  for (const [field, value] of [['versionName', next.version], ['versionCode', String(next.versionCode)]]) {
    result = substitute(result, new RegExp(`^  - ${field}: .+$|^    ${field}: .+$`, 'gm'),
      `${field === 'versionName' ? '  - ' : '    '}${field}: ${value}`);
  }
  result = substitute(result, /^CurrentVersion: .+$/gm, `CurrentVersion: ${next.version}`);
  result = substitute(result, /^CurrentVersionCode: .+$/gm, `CurrentVersionCode: ${next.versionCode}`);
  const after = Bun.YAML.parse(result) as any;
  requireGate(after.Builds[0].commit === next.sha && after.Builds[0].versionName === next.version
    && after.Builds[0].versionCode === next.versionCode, 'candidate source selectors mismatch');
  const selectorsRemoved = (data: any) => {
    const copy = structuredClone(data);
    delete copy.CurrentVersion;
    delete copy.CurrentVersionCode;
    for (const key of ['commit', 'versionName', 'versionCode']) delete copy.Builds[0][key];
    return JSON.stringify(copy);
  };
  requireGate(selectorsRemoved(before) === selectorsRemoved(after), 'build recipe changed');
  return result;
}

export function requireCleanSourceScan(data: any, versionCode: string) {
  requireGate(/^[1-9]\d*$/.test(versionCode), 'invalid scan version');
  const receipt = data?.['app.lazysh.client']?.[versionCode];
  requireGate(receipt && Array.isArray(receipt.errors) && receipt.errors.length === 0,
    'missing or failed candidate source scan');
}

// Never update/delete refs: concurrent creation can only converge on this exact commit.
export async function createStableTag(next: Candidate, policy: ReleasePolicy, buildResult: string,
  request: (path: string, body?: unknown) => Promise<Response>) {
  requireGate(releaseEnabled(policy), 'automatic tags disabled');
  requireGate(buildResult === 'success', 'successful source build and scans required');
  requireGate(/^[a-f0-9]{40}$/.test(next.sha) && next.tag === `v${next.version}`
    && next.versionCode === androidVersionCode(next.version), 'invalid tag candidate');
  const main = await request('git/ref/heads/main');
  requireGate(main.ok && (await main.json() as any).object?.sha === next.sha, 'main advanced or unavailable');
  const path = `git/ref/tags/${next.tag}`;
  const sameCommit = async (response: Response) => {
    requireGate(response.ok, 'cannot read tag');
    const data = await response.json() as any;
    requireGate(data.ref === `refs/tags/${next.tag}` && data.object?.type === 'commit'
      && data.object.sha === next.sha, 'tag collision');
    return 'existing';
  };
  const existing = await request(path);
  if (existing.ok) return sameCommit(existing);
  requireGate(existing.status === 404, 'cannot inspect tag');
  const created = await request('git/refs', { ref: `refs/tags/${next.tag}`, sha: next.sha });
  if (created.status === 422) return sameCommit(await request(path));
  requireGate(created.status === 201, 'tag creation failed');
  await sameCommit(created);
  return 'created';
}

async function currentCandidate(root: string) {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    requireGate(result.exitCode === 0, 'cannot resolve candidate history');
    return result.stdout.toString().trim();
  };
  requireGate(git(['rev-parse', 'HEAD']) === process.env.GITHUB_SHA, 'checkout differs from event');
  await verifyRelease(root);
  return candidate({ sha: process.env.GITHUB_SHA!, ref: process.env.GITHUB_REF!, event: process.env.GITHUB_EVENT_NAME!,
    version: (await Bun.file(join(root, 'package.json')).json()).version,
    parentVersion: JSON.parse(git(['show', 'HEAD^:package.json'])).version,
    pending: (await readdir(join(root, '.changeset'))).filter(name => name.endsWith('.md') && name !== 'README.md') });
}

if (import.meta.main) {
  const root = process.cwd();
  const policy: ReleasePolicy = await Bun.file(join(root, '.changeset/release-policy.json')).json();
  const output = async (key: string, value: string) => {
    requireGate(process.env.GITHUB_OUTPUT, 'GitHub output required');
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  if (!releaseEnabled(policy)) {
    requireGate(process.argv[2] === 'prepare', 'automatic tags disabled');
    await output('enabled', 'false');
    console.log('Automatic tags disabled: #344 and official submission prerequisites require separate review.');
  } else if (process.argv[2] === 'scan') {
    requireCleanSourceScan(await Bun.file(process.argv[3]).json(), process.argv[4]);
  } else if (process.argv[2] === 'provision') {
    const data = reviewedRecipe(await Bun.file(join(root, 'fdroid/metadata/app.lazysh.client.yml')).text(), policy);
    requireGate(Array.isArray(data.Builds[0].sudo) && data.Builds[0].sudo.every((value: unknown) => typeof value === 'string'),
      'missing reviewed provisioning');
    console.log(data.Builds[0].sudo.join('\n'));
  } else {
    const next = await currentCandidate(root);
    if (process.argv[2] === 'prepare') {
      const directory = process.env.LAZYSH_RELEASE_DIRECTORY;
      requireGate(directory, 'private output directory required');
      await mkdir(join(directory, 'metadata'), { recursive: true });
      const recipe = candidateRecipe(await Bun.file(join(root, 'fdroid/metadata/app.lazysh.client.yml')).text(), policy, next);
      await Bun.write(join(directory, 'metadata/app.lazysh.client.yml'), recipe);
      await output('enabled', 'true');
      await output('versionCode', String(next.versionCode));
    } else {
      requireGate(process.argv[2] === 'tag' && process.env.GH_TOKEN, 'tag command requires authentication');
      requireGate(process.env.GITHUB_REPOSITORY === 'mihazs/lazysh', 'unexpected repository');
      const request = (path: string, body?: unknown) => fetch(`https://api.github.com/repos/mihazs/lazysh/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      console.log(await createStableTag(next, policy, process.env.LAZYSH_RELEASE_BUILD_RESULT ?? '', request));
    }
  }
}
