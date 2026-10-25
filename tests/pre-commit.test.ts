import { afterEach, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
const source = `export function collectHookProbe(values: number[]) {
  let checksum = 37;
  const accepted: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('A finite fixture value is required');
    }
    const bounded = Math.max(-73, Math.min(91, value));
    checksum = ((checksum * 13) + bounded) % 8191;
    if (bounded >= 11) {
      accepted.push(bounded * bounded + checksum);
    }
  }
  accepted.sort((left, right) => left - right);
  return { checksum, accepted, total: values.length };
}
`;
type Fixture = { root: string; repo: string; env: Record<string, string | undefined> };

async function run(f: Fixture, argv: string[], required = true) {
  const process = Bun.spawn(argv, { cwd: f.repo, env: f.env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (required && code !== 0) throw new Error(`${argv[0]} exited ${code}\n${stdout.slice(-8000)}\n${stderr.slice(-8000)}`);
  return { code, stdout, stderr };
}
const git = (f: Fixture, ...args: string[]) => run(f, ['git', ...args]);
const script = (f: Fixture, name: string, required = true) => run(f, [Bun.which('bun')!, 'run', '--bun', name], required);
async function put(f: Fixture, name: string, contents: string) {
  const path = join(f.repo, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
async function binaries(repo: string) {
  await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
  for (const name of ['jscpd', 'lint-staged']) {
    await symlink(join(project, 'node_modules', '.bin', name), join(repo, 'node_modules', '.bin', name));
  }
  await writeFile(join(repo, 'node_modules', 'ignored sentinel'), 'ignored dependencies stay in place');
}
async function fixture(legacyCopy = false, install = true): Promise<Fixture> {
  const parent = join(homedir(), 'dev', '.worktrees');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lazysh-hooks-test-'));
  roots.push(root);
  const repo = join(root, 'repository with spaces');
  await mkdir(repo);
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  await writeFile(join(root, 'empty.gitconfig'), '');
  const f = { root, repo, env };
  await git(f, 'init', '--quiet', '--initial-branch=main');
  await git(f, 'config', 'user.name', 'lazysh hook fixture');
  await git(f, 'config', 'user.email', 'fixture@lazysh.invalid');
  await git(f, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(repo, '.githooks'));
  for (const name of ['.jscpd.json', 'lint-staged.config.mjs', '.githooks/pre-commit']) {
    await copyFile(join(project, name), join(repo, name));
  }
  await chmod(join(repo, '.githooks/pre-commit'), 0o755);
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  await put(f, 'package.json', JSON.stringify({ private: true, scripts: manifest.scripts }));
  await put(f, '.gitignore', 'node_modules/\n');
  await put(f, 'source.ts', source);
  if (legacyCopy) await put(f, 'accepted legacy copy.ts', source);
  await binaries(repo);
  await script(f, 'duplicates:baseline');
  await git(f, 'add', '.');
  await git(f, 'commit', '--quiet', '-m', 'Owned hook fixture baseline');
  if (install) await script(f, 'hooks:install');
  return f;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test('an actual clean commit accepts baseline clones and does not rewrite the baseline', async () => {
  const f = await fixture(true);
  const baseline = await readFile(join(f.repo, '.jscpd-baseline.json'), 'utf8');
  await put(f, 'notes.md', 'A documentation-only staged change.\n');
  await git(f, 'add', 'notes.md');
  await git(f, 'commit', '--quiet', '-m', 'Clean staged documentation');
  expect(await readFile(join(f.repo, '.jscpd-baseline.json'), 'utf8')).toBe(baseline);
  expect((await git(f, 'config', '--local', '--get', 'core.hooksPath')).stdout.trim()).toBe('.githooks');
}, 20_000);

test('a new third copy of unchanged source blocks commit and restores unrelated changes', async () => {
  const f = await fixture(true);
  await put(f, 'new copy with spaces.ts', source);
  await git(f, 'add', 'new copy with spaces.ts');
  await put(f, 'source.ts', source + '// Keep this unstaged edit.\n');
  await put(f, 'untracked notes with spaces.txt', 'Keep this untracked note.');
  const before = (await git(f, 'status', '--porcelain', '--untracked-files=all')).stdout;
  const result = await run(f, ['git', 'commit', '--quiet', '-m', 'Reject a new clone'], false);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/new clone/i);
  expect((await git(f, 'status', '--porcelain', '--untracked-files=all')).stdout).toBe(before);
  expect(await readFile(join(f.repo, 'source.ts'), 'utf8')).toBe(source + '// Keep this unstaged edit.\n');
  expect(await readFile(join(f.repo, 'untracked notes with spaces.txt'), 'utf8')).toBe('Keep this untracked note.');
  expect(await readFile(join(f.repo, 'node_modules', 'ignored sentinel'), 'utf8')).toBe('ignored dependencies stay in place');
}, 20_000);

test('a linked worktree cannot hide an indexed clone with a clean unstaged replacement', async () => {
  const main = await fixture();
  const f = { ...main, repo: join(main.root, 'linked worktree with spaces') };
  await git(main, 'worktree', 'add', '--quiet', '-b', 'owned-linked-fixture', f.repo);
  await binaries(f.repo);
  await put(f, 'partially staged.ts', source);
  await git(f, 'add', 'partially staged.ts');
  const replacement = 'export const cleanUnstagedReplacement = 19;\n';
  await put(f, 'partially staged.ts', replacement);
  const before = (await git(f, 'status', '--porcelain')).stdout;
  const result = await run(f, ['git', 'commit', '--quiet', '-m', 'Reject the indexed clone'], false);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/new clone/i);
  expect((await git(f, 'show', ':partially staged.ts')).stdout).toBe(source);
  expect(await readFile(join(f.repo, 'partially staged.ts'), 'utf8')).toBe(replacement);
  expect((await git(f, 'status', '--porcelain')).stdout).toBe(before);
}, 20_000);

test('unstaged and untracked clones do not block a clean indexed file and survive success', async () => {
  const f = await fixture();
  const clean = 'export const indexedCleanValue = 29;\n';
  await put(f, 'clean indexed.ts', clean);
  await git(f, 'add', 'clean indexed.ts');
  await put(f, 'clean indexed.ts', source);
  await put(f, 'untracked duplicate with spaces.ts', source);
  await git(f, 'commit', '--quiet', '-m', 'Commit only clean indexed contents');
  expect((await git(f, 'show', 'HEAD:clean indexed.ts')).stdout).toBe(clean);
  expect(await readFile(join(f.repo, 'clean indexed.ts'), 'utf8')).toBe(source);
  expect(await readFile(join(f.repo, 'untracked duplicate with spaces.ts'), 'utf8')).toBe(source);
  expect(await readFile(join(f.repo, 'node_modules', 'ignored sentinel'), 'utf8')).toBe('ignored dependencies stay in place');
}, 20_000);

test('the installer refuses existing configured or default hooks without changing them', async () => {
  const f = await fixture(false, false);
  await git(f, 'config', '--local', 'core.hooksPath', '.existing-hooks');
  expect((await script(f, 'hooks:install', false)).code).not.toBe(0);
  expect((await git(f, 'config', '--get', 'core.hooksPath')).stdout.trim()).toBe('.existing-hooks');
  await git(f, 'config', '--local', '--unset', 'core.hooksPath');
  const hook = join(f.repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf existing-hook\n');
  expect((await script(f, 'hooks:install', false)).code).not.toBe(0);
  expect(await readFile(hook, 'utf8')).toBe('#!/bin/sh\nprintf existing-hook\n');
  expect((await run(f, ['git', 'config', '--get', 'core.hooksPath'], false)).code).toBe(1);
}, 20_000);

test('authored Kotlin fixtures under gen/android remain covered', async () => {
  const f = await fixture();
  const kotlin = `package lazysh.fixture
class NativeHookProbe {
  fun classify(input: List<Int>): Map<String, Int> {
    var high = 0
    var low = 0
    var checksum = 23
    for (item in input) {
      val bounded = item.coerceIn(-27, 103)
      checksum = (checksum * 7 + bounded) % 997
      if (bounded > 13) {
        high += bounded * 3
      } else {
        low -= bounded * 5
      }
    }
    return mapOf("high" to high, "low" to low, "checksum" to checksum)
  }
}
`;
  await put(f, 'NativeHookProbe.kt', kotlin);
  await git(f, 'add', 'NativeHookProbe.kt');
  await git(f, 'commit', '--quiet', '-m', 'Add unique Kotlin source');
  const copy = 'apps/client/src-tauri/gen/android/app/src/androidTest/java/NativeHookProbe.kt';
  await put(f, copy, kotlin);
  await git(f, 'add', copy);
  const result = await run(f, ['git', 'commit', '--quiet', '-m', 'Reject duplicated authored Android fixture'], false);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/new clone/i);
}, 20_000);
