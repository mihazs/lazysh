import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFixtureRoots, project, spawnText as run } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'native-changes.sh');
const roots = gitFixtureRoots('lazysh-native-changes-test-');
afterAll(() => roots.cleanup());

/** Commit `paths` on top of a base commit and classify the range as the checks workflow does. */
async function classify(paths: string[], event = 'pull_request') {
  const { root, env } = await roots.create();
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) => run(repo, ['git', ...args], env);
  await git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'seed.txt'), 'seed');
  await git('add', '.'); await git('commit', '-q', '-m', 'chore: base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const path of paths) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `change ${path}`);
  }
  await git('add', '.'); await git('commit', '-q', '--allow-empty', '-m', 'docs: change');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const result = await run(repo, ['sh', script], { ...env, EVENT: event, BASE: base, HEAD: head });
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

test.each([
  [['docs/connections.md']],
  [['README.md', 'CHANGELOG.md', '.changeset/docs-note.md']],
  [['.github/ISSUE_TEMPLATE/bug.md', '.github/pull_request_template.md']],
])('a documentation-only pull request skips native jobs: %p', async paths => {
  expect(await classify(paths)).toBe('native=false');
});

test.each([
  [['apps/client/src/App.tsx']],
  [['docs/connections.md', 'apps/agent/src/main.rs']],
  [['apps/client/CHANGELOG.md']],
  [['.github/workflows/checks.yml']],
  [['.changeset/release-policy.json']],
  [[]],
])('any other change runs native jobs: %p', async paths => {
  expect(await classify(paths)).toBe('native=true');
});

test('pushes always run native jobs, even for documentation', async () => {
  expect(await classify(['docs/connections.md'], 'push')).toBe('native=true');
});

test('an unreadable range fails toward running native jobs', async () => {
  const { root, env } = await roots.create();
  const result = await run(root, ['sh', script], { ...env, EVENT: 'pull_request', BASE: 'deadbeef', HEAD: 'feedface' });
  expect(result.stdout.trim()).toBe('native=true');
});
