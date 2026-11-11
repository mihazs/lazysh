import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseTargets } from '../.changeset/release-artifacts';
import { gitFixtureRoots, spawnText } from './support/gitFixture';
import { document, evaluate, executedSteps, interpolate, releasePush, runnerJobs, type Context, type RunnerJob } from './support/workflowGraph';

const tag = '.github/workflows/release-tag.yml';
const release = await runnerJobs(tag, releasePush);
const named = (id: string) => release.find(entry => entry.id === id)!;
const roots = gitFixtureRoots('lazysh-release-workflow-test-');
afterAll(() => roots.cleanup());

// The success path: admission enabled the source; cache lookups are worst-case misses.
async function steps(entry: RunnerJob, row: Context) {
  return executedSteps(entry.job.steps, { ...entry.context, matrix: row, steps: { prepare: { outputs: { enabled: 'true' } } } });
}

test('a release push queues two runner entries on its critical path and eleven runner slots', () => {
  const slots = release.map(entry => [`${entry.file.split('/').pop()}#${entry.id}`, entry.rows.length, entry.queueEntry]);
  expect(slots.sort()).toEqual([
    ['companion-artifacts.yml#binary', 5, 1],
    ['release-artifacts.yml#android', 1, 1],
    ['release-artifacts.yml#desktop', 2, 1],
    ['release-tag.yml#publish', 1, 2],
    ['release-tag.yml#reserve', 1, 1],
    ['release-tag.yml#source-build', 1, 1],
  ]);
  expect(Math.max(...release.map(entry => entry.queueEntry))).toBe(2);
  expect(release.reduce((total, entry) => total + entry.rows.length, 0)).toBe(11);
});

test('publication waits for the admitted source build and every verified platform installation', async () => {
  const workflow = await document(tag);
  const publish = workflow.jobs.publish;
  expect(publish.needs).toEqual(['source-build', 'artifacts', 'reserve']);
  const passed = { 'source-build': { result: 'success', outputs: { enabled: 'true' } }, artifacts: { result: 'success' },
    reserve: { result: 'success' } };
  expect(evaluate(publish.if, { needs: passed })).toBe(true);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    expect(evaluate(publish.if, { needs: { ...passed, 'source-build': { ...passed['source-build'], result } } })).toBe(false);
    expect(evaluate(publish.if, { needs: { ...passed, artifacts: { result } } })).toBe(false);
    expect(evaluate(publish.if, { needs: { ...passed, reserve: { result } } })).toBe(false);
  }
  for (const enabled of ['false', '']) {
    expect(evaluate(publish.if, { needs: { ...passed, 'source-build': { result: 'success', outputs: { enabled } } } })).toBe(false);
  }
  // Every release target is uploaded exactly once by the jobs that a release push runs.
  const uploads: string[] = [];
  for (const entry of release) for (const row of entry.rows) for (const { step, context } of await steps(entry, row)) {
    if (step.uses === 'actions/upload-artifact@v4') uploads.push(String(interpolate(step.with.name, context)));
  }
  expect(uploads.filter(name => name !== 'verified-tag-build-receipts').sort())
    .toEqual(releaseTargets.map(target => `release-${target}`).sort());
});

test('only the reservation and publication jobs can write, and only their ref and publish steps receive the token', async () => {
  for (const file of [tag, '.github/workflows/release-artifacts.yml', '.github/workflows/companion-artifacts.yml']) {
    expect((await document(file)).permissions).toEqual({ contents: 'read' });
  }
  for (const entry of release) {
    expect(entry.job.permissions).toEqual(['publish', 'reserve'].includes(entry.id) ? { contents: 'write' } : undefined);
  }
  for (const entry of release) for (const row of entry.rows) for (const { step } of await steps(entry, row)) {
    const token = Object.values(step.env ?? {}).some(value => String(value).includes('github.token'));
    expect(token).toBe(['publish', 'reserve'].includes(entry.id) && /release-(tag\.ts (tag|reserve)|publish\.ts)/.test(step.run ?? ''));
  }
  const publish = (await steps(named('publish'), {})).map(({ step }) => step);
  const aggregate = publish.findIndex(step => step.run?.includes('release-artifacts.ts verify'));
  const tagged = publish.findIndex(step => step.env?.GH_TOKEN);
  expect(aggregate).toBeGreaterThan(-1);
  expect(aggregate).toBeLessThan(tagged);
  expect(publish.slice(tagged).map(step => step.run)).toEqual(['bun .changeset/release-tag.ts tag',
    'bun .changeset/release-publish.ts "$RUNNER_TEMP/verified-release"']);
  // The reservation job runs no build or third-party step: checkout, Bun and the one token step.
  expect((await steps(named('reserve'), {})).map(({ step }) => step.run ?? step.uses))
    .toEqual(['actions/checkout@v4', 'oven-sh/setup-bun@v2', 'bun .changeset/release-tag.ts reserve']);
});

test('release jobs bind the exact event source and restore dependency downloads without saving or restoring builds', async () => {
  const restored = new Set<string>();
  for (const entry of release) for (const row of entry.rows) for (const { step } of await steps(entry, row)) {
    const uses = String(step.uses ?? '');
    if (uses.startsWith('actions/checkout@')) {
      expect(step.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false, 'fetch-depth': 0 });
    }
    expect(uses).not.toMatch(/^(actions\/cache(\/save)?@|Swatinem\/rust-cache@)/);
    if (uses.startsWith('actions/cache/restore@')) {
      for (const path of String(step.with.path).split('\n').filter(Boolean)) {
        expect(path).not.toMatch(/target|\/build\b|registry\/src/);
        restored.add(path.trim());
      }
    }
  }
  expect([...restored].sort()).toEqual(['${{ runner.temp }}/lazysh-parakeet-onnxruntime-cache', '~/.bun/install/cache',
    '~/.cargo/git/db/', '~/.cargo/registry/cache/', '~/.cargo/registry/index/', '~/.gradle/caches/modules-2', '~/.gradle/wrapper/dists']);
});

test('only main companion candidates seed crate downloads; pull requests never save', async () => {
  const companion = await document('.github/workflows/companion-artifacts.yml');
  const binary = companion.jobs.binary;
  const run = async (github: Context) => (await executedSteps(binary.steps, { github, inputs: { stage: false } }))
    .map(({ step, context }) => ({ uses: String(step.uses ?? ''), save: interpolate(step.with?.['save-if'], context) }));
  const main = await run({ event_name: 'push', ref: 'refs/heads/main' });
  expect(main.filter(step => step.uses.startsWith('actions/cache/save@'))).toHaveLength(1);
  const pull = await run({ event_name: 'pull_request', ref: 'refs/pull/1/merge' });
  expect(pull.filter(step => /^actions\/cache(\/save)?@/.test(step.uses))).toEqual([]);
  expect(pull.find(step => step.uses.startsWith('Swatinem/rust-cache@'))?.save).toBe(false);
});

test('the combined Android job builds each flavor from fresh Gradle outputs and validates it before the next', async () => {
  const android = named('android');
  const step = android.job.steps.find((item: any) => item.run?.includes('tauri android build'));
  const { root, env } = await roots.create();
  const bin = join(root, 'bin'), log = join(root, 'calls.log'), workspace = join(root, 'workspace');
  await mkdir(bin);
  await mkdir(workspace);
  // A stand-in Bun records each build and validation, failing if a stale APK is visible to a build.
  await writeFile(join(bin, 'bun'), `#!/bin/sh
apk=apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/release/app.apk
case "$*" in
  *"tauri android build"*)
    [ ! -e "$apk" ] || { echo stale >> "$LOG"; exit 9; }
    case "$*" in *"--features fdroid"*) flavor=foss ;; *) flavor=google ;; esac
    [ "$flavor" = "$FAIL" ] && exit 7
    mkdir -p "$(dirname "$apk")" && echo "$flavor" > "$apk"
    echo "build $flavor" >> "$LOG" ;;
  .changeset/release-platform.ts*) echo "validate $2 $3 $(cat "$apk")" >> "$LOG" ;;
  *) exit 3 ;;
esac
`, { mode: 0o755 });
  const execute = (fail: string) => spawnText(workspace, ['bash', '-e', '-c', step.run], {
    ...env, PATH: `${bin}:${process.env.PATH}`, LOG: log, FAIL: fail, NDK_HOME: '/ndk', RUNNER_TEMP: '/owned' });
  expect((await execute('')).code).toBe(0);
  expect((await Bun.file(log).text()).trim().split('\n')).toEqual([
    'build foss', 'validate android-foss-arm64 /owned/installation-files/android-foss-arm64 foss',
    'build google', 'validate android-google-arm64 /owned/installation-files/android-google-arm64 google',
  ]);
  await writeFile(log, '');
  expect((await execute('foss')).code).not.toBe(0);
  expect(await Bun.file(log).text()).toBe('');
  // Each flavor's validated bytes are uploaded under its own target receipt name.
  const uploads = android.job.steps.filter((item: any) => item.uses === 'actions/upload-artifact@v4')
    .map((item: any) => [item.with.name, item.with.path]);
  expect(uploads).toEqual(['foss', 'google'].map(flavor => [`release-android-${flavor}-arm64`,
    `\${{ runner.temp }}/installation-files/android-${flavor}-arm64`]));
});

// Windows and macOS release runners check out onto case-insensitive file systems. There two
// tracked paths that differ only in case are one file, and an extensionless module import such
// as './CommandPalette' also opens 'commandPalette.ts' (#1011 broke the Windows build this way).
const moduleExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
function caseCollisions(paths: string[]) {
  const groups = new Map<string, Set<string>>();
  const add = (key: string, path: string) => groups.set(key, (groups.get(key) ?? new Set()).add(path));
  for (const path of paths) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) add(`path:${parts.slice(0, length).join('/').toLowerCase()}`, parts.slice(0, length).join('/'));
    if (moduleExtension.test(path)) add(`module:${path.replace(moduleExtension, '').toLowerCase()}`, path.replace(moduleExtension, ''));
  }
  return [...groups.values()].filter(group => group.size > 1).map(group => [...group].sort());
}

test('tracked paths and module specifiers stay distinct on case-insensitive release runners', async () => {
  expect(caseCollisions(['src/CommandPalette.tsx', 'src/commandPalette.ts', 'src/CommandPalette.css']))
    .toEqual([['src/CommandPalette', 'src/commandPalette']]);
  expect(caseCollisions(['Docs/a.md', 'docs/b.md'])).toEqual([['Docs', 'docs']]);
  expect(caseCollisions(['src/Palette.tsx', 'src/Palette.css', 'src/palette-model.ts'])).toEqual([]);
  const listed = await spawnText(join(import.meta.dir, '..'), ['git', 'ls-files', '-z']);
  expect(listed.code).toBe(0);
  expect(caseCollisions(listed.stdout.split('\0').filter(Boolean))).toEqual([]);
});
