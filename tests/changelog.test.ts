import { afterEach, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import changelog from '../.changeset/changelog.mjs';
import { changelogSection } from '../.changeset/changelog-model.mjs';
import { fastlaneChangelog, rotate } from '../.changeset/changelog-rotate';
import { releaseNotes } from '../.changeset/release-artifacts';
import { fragmentProblems } from '../.changeset/lint-fragments';
import { previewPending } from '../.changeset/changelog-preview';
import { gitFixtureRoots, project as source } from './support/gitFixture';

const roots = gitFixtureRoots('lazysh-changelog-');
afterEach(roots.cleanup);
const scratch = async () => (await roots.create()).root;

/** Runs `use` inside a throwaway repository holding one empty commit per subject, as the generator finds them. */
async function inRepositoryWith(subjects: string[], use: (commits: string[]) => Promise<void>) {
  const { root: directory, env } = await roots.create();
  const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: directory, env, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
  git('init', '-q', '-b', 'main');
  const commits = subjects.map(subject => (git('commit', '-q', '--allow-empty', '-m', subject), git('rev-parse', 'HEAD')));
  const previous = process.cwd();
  process.chdir(directory);
  try {
    await use(commits);
  } finally {
    process.chdir(previous);
  }
}
const line = (summary: string, bump = 'patch', commit?: string) => changelog.getReleaseLine({ summary, commit } as never, bump as never, {});

test('a structured fragment is one typed line with collapsed details; a legacy one gets a headline and an inferred type', async () => {
  expect(await line('feat(ssh): Keep the host binding\n\nWhy it matters.\n\n- one\n- two'))
    .toBe('- feat(ssh): Keep the host binding\n\n  <details><summary>Details</summary>\n\n  Why it matters.\n\n  - one\n  - two\n\n  </details>');
  expect(await line('docs: Explain the changelog')).toBe('- docs: Explain the changelog');
  expect(await line('Fix the scroll position after a resize. It jumped to the top. No defaults change.'))
    .toBe('- fix: Fix the scroll position after a resize\n\n  <details><summary>Details</summary>\n\n  It jumped to the top. No defaults change.\n\n  </details>');
  expect(await line('Show the pane title in the tab strip.', 'minor')).toBe('- feat: Show the pane title in the tab strip');
  expect(await line('Show the pane title in the tab strip.', 'patch')).toBe('- change: Show the pane title in the tab strip');
  const long = await line(`Keep every saved host reachable ${'after a restart that restores all of its sessions '.repeat(4)}in the same order.`);
  expect(long.split('\n')[0].length).toBeLessThanOrEqual(120);
  expect(long.split('\n')[0]).toMatch(/…$/);
  expect(long).toContain('in the same order.\n\n  </details>');
  expect(await changelog.getDependencyReleaseLine([], [{ name: '@lazysh/common', newVersion: '1.0.0' }] as never, {})).toBe('');
});

test('the pull request is linked from the squash commit subject and omitted when the commit is unknown', () => inRepositoryWith(
  ['fix(ssh): keep the binding (#412)', 'chore: a commit with no pull request number'], async ([squashed, plain]) => {
    expect(await line('fix(ssh): Keep the binding', 'patch', squashed)).toBe('- fix(ssh): Keep the binding ([#412](https://github.com/mihazs/lazysh/pull/412))');
    expect(await line('fix(ssh): Keep the binding', 'patch', plain)).toBe('- fix(ssh): Keep the binding');
    expect(await line('fix(ssh): Keep the binding', 'patch', '0'.repeat(40))).toBe('- fix(ssh): Keep the binding');
  }));

const accepted = {
  structured: '---\n"@lazysh/client": patch\n---\n\nfix(ssh): Keep the binding\n\nDetails.\n',
  scopeless: '---\n"@lazysh/client": minor\n"@lazysh/agent": minor\n---\n\nfeat!: Rename the export\n',
  empty: '---\n---\n',
};
const rejected: [string, string, RegExp][] = [
  ['free text', '---\n"@lazysh/client": patch\n---\n\nKeep the binding.\n', /first line must be "type\(scope\): headline"/],
  ['unknown type', '---\n"@lazysh/client": patch\n---\n\nchange: Keep the binding\n', /type of feat, fix/],
  ['long headline', `---\n"@lazysh/client": patch\n---\n\nfix: ${'Keep the binding '.repeat(8)}\n`, /headline is \d+ characters/],
  ['details without a blank line', '---\n"@lazysh/client": patch\n---\n\nfix: Keep the binding\nBecause.\n', /blank line/],
  ['no summary', '---\n"@lazysh/client": patch\n---\n', /no summary/],
  ['bad bump', '---\n"@lazysh/client": huge\n---\n\nfix: Keep the binding\n', /expected "package-name"/],
  ['no frontmatter', 'fix: Keep the binding\n', /frontmatter/],
];
test.each(Object.entries(accepted))('the fragment linter accepts a %s fragment', (_name, content) => {
  expect(fragmentProblems(content)).toEqual([]);
});
test.each(rejected)('the fragment linter rejects %s with the line to fix', (_name, content, message) => {
  const [problem] = fragmentProblems(content);
  expect(problem.message).toMatch(message);
  expect(problem.line).toBeGreaterThan(0);
});

test('the linter script exits non-zero with file:line errors for a bad fragment and ignores README.md', async () => {
  const directory = await scratch();
  await Bun.write(join(directory, 'bad.md'), '---\n"@lazysh/client": patch\n---\n\nKeep the binding.\n');
  await Bun.write(join(directory, 'good.md'), accepted.structured);
  await Bun.write(join(directory, 'README.md'), 'Not a fragment.\n');
  const run = (...files: string[]) => Bun.spawnSync(['bun', join(source, '.changeset/lint-fragments.ts'), ...files.map(file => join(directory, file))],
    { stdout: 'pipe', stderr: 'pipe' });
  const failed = run('good.md', 'bad.md', 'README.md');
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr.toString()).toContain(`${join(directory, 'bad.md')}:5: the first line must be`);
  expect(failed.stderr.toString()).not.toContain('good.md');
  expect(failed.stderr.toString()).not.toContain('README.md:');
  expect(run('good.md', 'README.md').exitCode).toBe(0);
});

test('pending fragments are previewed grouped like release notes, empty fragments skipped', async () => {
  const directory = await scratch();
  await Bun.write(join(directory, 'a.md'), '---\n"@lazysh/client": minor\n---\n\nfeat(agents): Switch a session to its live view\n');
  await Bun.write(join(directory, 'b.md'), '---\n"@lazysh/client": patch\n---\n\nFix the toolbar overlap. It hid the keys.\n');
  await Bun.write(join(directory, 'c.md'), '---\n---\n');
  const preview = await previewPending(directory);
  expect(preview).toBe('2 pending changes\n\n## New\n\n- **agents:** Switch a session to its live view\n\n## Fixed\n\n'
    + '- Fix the toolbar overlap\n\n  <details><summary>Details</summary>\n\n  It hid the keys.\n\n  </details>\n');
  expect(await previewPending(await scratch())).toContain('No pending changes');
});

async function notesFor(clientChangelog: string, published: string[], version: string) {
  const root = await scratch();
  await mkdir(join(root, 'apps/client'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await Bun.write(join(root, 'apps/client/CHANGELOG.md'), clientChangelog);
  await Bun.write(join(root, 'docs/install-and-update.md'), '# Install\n\n## Current native acceptance status\n\nPhone acceptance is pending.\n');
  return releaseNotes(root, version, false, published);
}

test('the real 1.80.0 to 1.80.2 changelog sections become grouped, hash-free, dependency-free release notes', async () => {
  const real = await Bun.file(join(source, 'apps/client/CHANGELOG.md')).text();
  const sections = ['1.80.2', '1.80.1', '1.80.0'].map(version => `## ${version}\n${changelogSection(real, version)}`);
  const notes = await notesFor(`# @lazysh/client\n\n${sections.join('')}`, ['1.79.7'], '1.80.2');
  const order = ['Includes the unpublished versions 1.80.0 and 1.80.1.', '\n## New\n', '\n## Improved\n', '\n## Under the hood\n',
    '\n## Current native acceptance status\n', 'Phone acceptance is pending.', 'See the attached installation guide'].map(text => notes.indexOf(text));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  for (const empty of ['## Fixed', '## Documentation', 'Also included', '### Patch Changes', '### Minor Changes']) expect(notes).not.toContain(empty);
  expect(notes).not.toMatch(/^- [0-9a-f]{7}: /m);
  expect(notes).not.toMatch(/@lazysh\/[\w-]+@\d/);
  expect(notes.match(/^- /gm)).toHaveLength(9);
  expect(notes).toContain('- Add the Host browser switch to host settings\n\n  <details><summary>Details</summary>');
});

test('generated lines regroup by type with scope, pull request link and collapsed details', () => inRepositoryWith(['feat: ship (#9)'], async ([commit]) => {
  const bullets = await Promise.all([
    ['feat(agents): Switch a session to its live view\n\nOff by default.', 'minor'], ['fix(ssh): Keep the binding', 'patch'],
    ['docs: Explain the changelog', 'patch'], ['ci(windows): Run the real cases', 'patch'], ['perf(files): Open large folders faster', 'patch'],
    ['Keep the toolbar visible', 'patch'],
  ].map(([summary, bump]) => line(summary, bump, commit)));
  const notes = await notesFor(`# @lazysh/client\n\n## 2.0.0\n\n### Minor Changes\n\n${bullets.join('\n')}\n`, [], '2.0.0');
  expect([...notes.matchAll(/^## (.+)$/gm)].map(match => match[1]))
    .toEqual(['New', 'Improved', 'Fixed', 'Documentation', 'Under the hood', 'Current native acceptance status']);
  const pr = '([#9](https://github.com/mihazs/lazysh/pull/9))';
  expect(notes).toContain(`## New\n\n- **agents:** Switch a session to its live view ${pr}\n\n  <details><summary>Details</summary>\n\n  Off by default.`);
  expect(notes).toContain(`## Improved\n\n- **files:** Open large folders faster ${pr}\n- Keep the toolbar visible`);
  expect(notes).toContain(`## Fixed\n\n- **ssh:** Keep the binding ${pr}`);
}));

const rootChangelog = `# Changelog

## [Unreleased]

Pending changes live in the fragments.

### Changed

- Changed the export format.

### Fixed

- Fix the pane title (#1). It
  was stale.

### Added

- Add a tab strip.

Extra prose that stays.

## [1.0.0] - 2026-01-01

### New

- Keep this old release line.

## Development history (unversioned)

- Show an older entry.
- Fix an older bug.
`;

test('rotating a release moves the Unreleased bullets into its section, classified, and leaves the history untouched', () => {
  const entry = (details: string) => `- feat(agents): Switch a session ([#5](https://github.com/mihazs/lazysh/pull/5))\n\n  <details><summary>Details</summary>\n\n  ${details}\n\n  </details>\n`;
  const section = `### Minor Changes\n\n${entry('Off by default.')}${entry('Same headline from a second fragment of the pull request.')}`;
  const rotated = rotate(rootChangelog, section, '1.1.0', '2026-02-03');
  expect(rotated).toContain('## [Unreleased]\n\nPending changes live in the fragments.\n\nExtra prose that stays.\n\n## [1.1.0] - 2026-02-03\n\n### New\n\n');
  expect(rotated).toContain('- **agents:** Switch a session ([#5](https://github.com/mihazs/lazysh/pull/5))\n- Add a tab strip.\n\n### Improved\n\n- Changed the export format.\n\n### Fixed\n\n- Fix the pane title (#1). It\n  was stale.\n\n## [1.0.0]');
  expect(rotated.slice(rotated.indexOf('## [1.0.0]'))).toBe(rootChangelog.slice(rootChangelog.indexOf('## [1.0.0]')));
  expect(rotated).not.toContain('<details>');
  const bullets = (text: string) => text.match(/^- /gm)?.length ?? 0;
  expect(bullets(rotated)).toBe(bullets(rootChangelog) + 1);
  expect(() => rotate(rotated, section, '1.1.0', '2026-02-03')).toThrow('already has a section');
  expect(() => rotate('# Changelog\n', section, '1.1.0', '2026-02-03')).toThrow('no "## [Unreleased]"');
});

test('an entry that is only in another package changelog reaches the release notes and the root changelog once', async () => {
  const root = await scratch();
  const shared = '- 1111111: feat(agents): Switch a session ([#5](https://github.com/mihazs/lazysh/pull/5))\n';
  const companion = '- 2222222: feat(companion): Stream agent status ([#7](https://github.com/mihazs/lazysh/pull/7))\n';
  const skipped = '- 3333333: fix(ios): Run idb ui subcommands\n';
  const files = {
    'apps/client/CHANGELOG.md': `# @lazysh/client\n\n## 1.1.0\n\n### Minor Changes\n\n${shared}\n## 1.0.1\n\n### Patch Changes\n\n- Updated dependencies\n\n## 1.0.0\n\n- Older.\n`,
    'apps/agent/CHANGELOG.md': `# @lazysh/agent\n\n## 1.1.0\n\n### Minor Changes\n\n${shared}${companion}\n## 1.0.1\n\n### Patch Changes\n\n${skipped}\n## 1.0.0\n\n- feat: Older companion.\n\n## 0.9.0\n\n- feat: Only the companion has this version.\n`,
    'docs/install-and-update.md': '# Install\n\n## Current native acceptance status\n\nPhone acceptance is pending.\n',
    'CHANGELOG.md': rootChangelog,
  };
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  const count = (text: string, part: string) => text.split(part).length - 1;
  const notes = await releaseNotes(root, '1.1.0', false, ['1.0.0']);
  expect(notes).toContain('Includes the unpublished version 1.0.1.');
  for (const line of ['**agents:** Switch a session', '**companion:** Stream agent status', '**ios:** Run idb ui subcommands']) expect(count(notes, line)).toBe(1);
  expect(notes).not.toContain('Older companion');
  await expect(releaseNotes(root, '0.9.0')).rejects.toThrow('missing version changelog');
  const rotated = Bun.spawnSync(['bun', join(source, '.changeset/changelog-rotate.ts'), '1.1.0', '2026-02-03'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(rotated.exitCode).toBe(0);
  const section = changelogSection((await Bun.file(join(root, 'CHANGELOG.md')).text()).replace('## [1.1.0] - 2026-02-03', '## 1.1.0'), '1.1.0')!;
  for (const line of ['**agents:** Switch a session', '**companion:** Stream agent status']) expect(count(section, line)).toBe(1);
  expect(section).not.toContain('idb ui');
});

test('F-Droid release notes keep user-facing headlines within 500 characters', () => {
  const section = [
    '- docs(readme): explain setup',
    ...Array.from({ length: 30 }, (_, i) => `- fix(ssh): keep host binding number ${i} across a restored connection ([#${i}](https://github.com/mihazs/lazysh/pull/${i}))`),
  ].join('\n');
  const notes = fastlaneChangelog(section, '1.2.3');
  expect(notes.length).toBeLessThanOrEqual(501);
  expect(notes).toStartWith('- keep host binding number 0 across a restored connection\n');
  expect(notes).not.toContain('explain setup');
  expect(notes).toEndWith('Full notes: https://github.com/mihazs/lazysh/releases/tag/v1.2.3\n');
  expect(fastlaneChangelog('- chore(ci): bump runners', '1.2.4')).toStartWith('Maintenance release.\n');
});
