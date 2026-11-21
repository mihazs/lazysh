import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFixtureRoots, project, spawnText as run } from './support/gitFixture';

const check = join(project, '.githooks', 'regression-check');
const template = await Bun.file(join(project, '.github', 'pull_request_template.md')).text();
const roots = gitFixtureRoots('lazysh-regression-check-test-');
afterAll(() => roots.cleanup());

const pr = (title: string, body: string, ...range: string[]) => run(project, ['sh', check, 'pr', title, body, ...range]);
const section = (box: string) => `## Regression test\n\n<!-- instructions -->\n\n${box}\n\n## Release impact\n`;
const ticked = {
  added: '- [x] **Added**. Test: `e2e/terminal-swiftkey.spec.ts` "Backspace after a toolbar key"',
  applicable: '- [x] **Not applicable**. Reason: `TerminalPane.test.tsx` already failed on the parent commit',
};

test.each(['feat: add a toolbar', 'docs: clarify setup', 'chore(release): version lazysh packages', 'fixup: squash me', 'fixes: nothing', 'test(e2e): add a spec'])(
  'a pull request that is not a fix passes without any section: %p', async title => {
    expect((await pr(title, '')).code).toBe(0);
  });

test.each(['fix: stop the crash', 'fix(ssh): keep the host binding', 'fix!: change the format', 'fix(sync)!: change the format'])(
  'a fix without the section fails and points to the rule: %p', async title => {
    const result = await pr(title, 'Just a description.');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must tick "Added" or "Not applicable"');
    expect(result.stderr).toContain('AGENTS.md');
  });

test('the untouched pull request template does not satisfy a fix', async () => {
  expect((await pr('fix: x', template)).code).toBe(1);
  // Ticking a box without filling in the answer is still not an answer.
  for (const [box, message] of [['Added', 'Test:'], ['Not applicable', 'Reason:']] as const) {
    const edited = template.replace(`- [ ] **${box}**`, `- [x] **${box}**`);
    const result = await pr('fix: x', edited);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  }
});

test.each([
  ['an added test', ticked.added],
  ['a reason it is not applicable', ticked.applicable],
  ['an asterisk bullet and a capital X', ticked.added.replace('- [x]', '* [X]')],
])('a fix that records %s passes, with Windows line endings too', async (_, box) => {
  expect((await pr('fix(ssh): keep the binding', section(box))).code).toBe(0);
  expect((await pr('fix(ssh): keep the binding', section(box).replaceAll('\n', '\r\n'))).code).toBe(0);
});

test('an empty or too short answer is rejected, and an unticked box never counts', async () => {
  for (const box of ['- [x] **Added**. Test: ', '- [x] **Added**', '- [x] **Not applicable**. Reason: n/a', '- [ ] **Added**. Test: `a.test.ts` "x"']) {
    expect((await pr('fix: x', section(box))).code, box).toBe(1);
  }
});

test('ticking both boxes fails; text inside HTML comments never counts as an answer', async () => {
  const both = await pr('fix: x', section(`${ticked.added}\n${ticked.applicable}`));
  expect(both.code).toBe(1);
  expect(both.stderr).toContain('not several');
  const hidden = `<!--\n${ticked.added}\n-->\n<!-- ${ticked.applicable} -->`;
  expect((await pr('fix: x', hidden)).code).toBe(1);
});

async function repository(files: Record<string, string>) {
  const { root, env } = await roots.create();
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) => run(repo, ['git', ...args], env);
  const write = async (name: string, text: string) => { await mkdir(dirname(join(repo, name)), { recursive: true }); await writeFile(join(repo, name), text); };
  await git('init', '-q', '-b', 'main');
  await write('seed.txt', 'seed');
  await git('add', '-A'); await git('commit', '-q', '-m', 'chore: base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const [name, text] of Object.entries(files)) await write(name, text);
  await git('add', '-A'); await git('commit', '-q', '--allow-empty', '-m', 'fix: change');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  return { repo, base, head, rerun: (title: string, body: string) => run(repo, ['sh', check, 'pr', title, body, base, head]) };
}

test('an added regression test needs its row in the index within the same range', async () => {
  const without = await repository({ 'apps/client/src/a.test.ts': 'test' });
  const rejected = await without.rerun('fix: x', section(ticked.added));
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain('docs/regression-tests.md');
  // A not-applicable reason needs no row.
  expect((await without.rerun('fix: x', section(ticked.applicable))).code).toBe(0);
  const withRow = await repository({ 'apps/client/src/a.test.ts': 'test', 'docs/regression-tests.md': '| row |' });
  expect((await withRow.rerun('fix: x', section(ticked.added))).code).toBe(0);
});

test('the index lists each Appium regression spec with its issue and fails on one that is not linked', async () => {
  const files = {
    'docs/regression-tests.md': '| [#1402](https://github.com/mihazs/lazysh/issues/1402) | row |\n| [#99](https://github.com/mihazs/lazysh/pull/99) | row |',
    'apps/client/mobile-e2e/specs/regression/scroll/1402-herdr-swipe.e2e.ts': 'x',
    'apps/client/mobile-e2e/specs/regression/scroll/99-another.e2e.ts': 'x',
  };
  const { repo } = await repository(files);
  const index = (...extra: string[]) => run(repo, ['sh', check, 'index', ...extra]);
  const listed = await index();
  expect(listed.code).toBe(0);
  expect(listed.stdout.trim().split('\n')).toEqual([
    '#99 apps/client/mobile-e2e/specs/regression/scroll/99-another.e2e.ts',
    '#1402 apps/client/mobile-e2e/specs/regression/scroll/1402-herdr-swipe.e2e.ts',
  ]);
  await writeFile(join(repo, 'apps/client/mobile-e2e/specs/regression/scroll/1403-unlinked.e2e.ts'), 'x');
  await writeFile(join(repo, 'apps/client/mobile-e2e/specs/regression/scroll/unnamed.e2e.ts'), 'x');
  const broken = await index();
  expect(broken.code).toBe(1);
  expect(broken.stdout).toContain('#1403 apps/client/mobile-e2e/specs/regression/scroll/1403-unlinked.e2e.ts MISSING');
  expect(broken.stderr).toContain('#1403 has no link in docs/regression-tests.md');
  expect(broken.stderr).toContain('unnamed.e2e.ts is not named <issue>-<behaviour>.e2e.ts');
});

test('an unknown subcommand is a usage error', async () => {
  expect((await run(project, ['sh', check, 'bogus'])).code).toBe(2);
});
