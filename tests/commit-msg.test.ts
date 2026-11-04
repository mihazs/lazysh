import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFixtureRoots, project, spawnText as run } from './support/gitFixture';

const hook = join(project, '.githooks', 'commit-msg');
const check = join(project, '.githooks', 'conventional-check');
const roots = gitFixtureRoots('lazysh-commit-msg-test-');
afterAll(() => roots.cleanup());

async function repository() {
  const { root, env } = await roots.create();
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.githooks'), { recursive: true });
  await writeFile(join(repo, '.githooks', 'commit-msg'), await Bun.file(hook).text(), { mode: 0o755 });
  const git = (...args: string[]) => run(repo, ['git', ...args], env);
  await git('init', '-q', '-b', 'main');
  await git('config', 'core.hooksPath', '.githooks');
  return { repo, git };
}
const header = (text: string) => run(project, ['sh', hook, '--header', text]);

test.each([
  'feat: add a toolbar',
  'fix(ssh): preserve the original host binding',
  'feat(sync)!: change the export format',
  'chore(release): version lazysh packages',
  'revert: undo the font change',
  'test(android-ime): observe paired edits',
])('accepts %p', async text => {
  expect((await header(text)).code).toBe(0);
});

test.each([
  "Merge remote-tracking branch 'origin/main' into fix/x",
  'Merge pull request #1 from mihazs/fix/x',
  'Revert "feat: add a toolbar"',
  'feature: add a toolbar',
  'fix: ',
  'fix:missing space',
  'Fix(ssh): uppercase type',
  'fix(SSH Host): spaces in scope',
  '',
])('rejects %p with guidance', async text => {
  const result = await header(text);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Conventional Commits');
});

test('the installed hook rejects a non-conforming git commit and accepts a conforming one', async () => {
  const { repo, git } = await repository();
  await writeFile(join(repo, 'a.txt'), 'a');
  await git('add', 'a.txt');
  const rejected = await git('commit', '-q', '-m', 'Update a file');
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain('Not a Conventional Commits header: Update a file');
  expect((await git('rev-list', '--all')).stdout).toBe('');
  const accepted = await git('commit', '-q', '-m', 'docs: add a file\n\nBody text.');
  expect(accepted.code).toBe(0);
  expect((await git('log', '--format=%s')).stdout.trim()).toBe('docs: add a file');
});

test('the pull request check reports every non-conforming title and commit in the range', async () => {
  const { repo, git } = await repository();
  await git('commit', '-q', '--allow-empty', '-m', 'chore: base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('commit', '-q', '--allow-empty', '-m', 'fix: valid change');
  await git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'wip');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const failing = await run(repo, ['sh', check, 'Bad title', base, head]);
  expect(failing.code).toBe(1);
  expect(failing.stderr).toContain('Not a Conventional Commits header: Bad title');
  expect(failing.stderr).toMatch(/Commit [0-9a-f]+ is not a Conventional Commits header: wip/);
  expect(failing.stderr).not.toContain('valid change');
  await git('reset', '-q', '--hard', 'HEAD~1');
  const passing = await run(repo, ['sh', check, 'fix: valid change', base, (await git('rev-parse', 'HEAD')).stdout.trim()]);
  expect(passing.code).toBe(0);
});
