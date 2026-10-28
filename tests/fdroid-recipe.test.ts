import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const checkout = new URL('../', import.meta.url).pathname;
const cli = process.env.LAZYSH_FDROID_CLI ?? 'fdroid';
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

function invoke(directory: string, args: string[]) {
  const result = Bun.spawnSync(args, {
    cwd: directory, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  expect({ status: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({ status: 0 });
  if (args.includes('scanner')) expect(result.stdout.toString().trim(), result.stderr.toString()).not.toBe('{}');
  return result.stdout.toString().trim();
}

test('official fdroidserver parses and lints the pinned source-build recipe', () => {
  for (const args of [['readmeta'], ['lint', 'app.lazysh.client']]) {
    invoke(join(checkout, 'fdroid'), [cli, ...args]);
  }
});

test('recipe versions describe the exact public source commit rather than a moving release', async () => {
  const metadata = Bun.YAML.parse(await Bun.file(join(checkout, 'fdroid/metadata/app.lazysh.client.yml')).text()) as any;
  const [build] = metadata.Builds;
  expect(build.commit).toMatch(/^[a-f0-9]{40}$/);
  const properties = invoke(checkout, ['git', 'show', `${build.commit}:apps/client/android-version.properties`]);
  expect(properties).toBe(`versionName=${build.versionName}\nversionCode=${build.versionCode}`);
});

test('actual source scanner reports a native archive and clears only after source removal', async () => {
  const parent = join(homedir(), 'dev/.worktrees');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lazysh-fdroid-fixture-'));
  temporary.push(root);
  const source = join(root, 'source');
  const data = join(root, 'data');
  await mkdir(source);
  await mkdir(join(data, 'metadata'), { recursive: true });
  await cp(join(checkout, 'fdroid/config'), join(data, 'config'), { recursive: true });
  await writeFile(join(source, 'README.md'), 'Owned source-scanner acceptance fixture.\n');
  await writeFile(join(source, 'gradlew'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(source, 'unbuilt.a'), '!<arch>\n');
  invoke(source, ['git', 'init', '--quiet']);
  const publish = async (message: string) => {
    invoke(source, ['git', 'add', '.']);
    invoke(source, ['git', '-c', 'user.name=lazysh fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', message]);
    const commit = invoke(source, ['git', 'rev-parse', 'HEAD']);
    await writeFile(join(data, 'metadata/app.lazysh.fixture.yml'), `License: MIT\nRepoType: git\nRepo: file://${source}\nBuilds:\n  - versionName: '1.0'\n    versionCode: 1\n    commit: ${commit}\n    output: nonexistent.apk\n    build: exit 1\nAutoUpdateMode: None\nUpdateCheckMode: None\n`);
  };
  const scan = () => JSON.parse(invoke(data, [cli, 'scanner', '--verbose', '--exit-code', '--json', 'app.lazysh.fixture:1']))['app.lazysh.fixture']['1'];
  await publish('include owned archive');
  expect(scan().errors).toContainEqual(['static library', 'unbuilt.a']);
  await rm(join(source, 'unbuilt.a'));
  await publish('remove unused archive');
  expect(scan().errors).toEqual([]);
}, 60_000);
