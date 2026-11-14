import { afterAll, expect, test } from 'bun:test';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFixtureRoots, project, spawnText as run } from './support/gitFixture';

const script = join(project, '.github', 'scripts', 'native-changes.sh');
const workflow = async (name: string) => Bun.YAML.parse(await Bun.file(join(project, '.github', 'workflows', name)).text()) as any;
const checks = await workflow('checks.yml');
const roots = gitFixtureRoots('lazysh-native-changes-test-');
afterAll(() => roots.cleanup());

type Outputs = Record<string, string>;
const jobOutputs = ['companion', 'herdr', 'linux', 'linux_runtimes', 'desktop', 'android', 'android_runtime', 'android_mosh',
  'android_herdr', 'android_auxiliary', 'android_ntfy', 'ios'];
const everything: Outputs = { ...Object.fromEntries(jobOutputs.map(name => [name, 'true'])),
  ntfy_variants: '["fdroid","google"]', native: 'true', docs_only: 'false' };
const nothing: Outputs = { ...Object.fromEntries(jobOutputs.map(name => [name, 'false'])),
  ntfy_variants: '["google"]', native: 'false' };

/** Commit `paths` (and `moves` of seeded files) over a base commit and classify the range as checks.yml does. */
async function classify(paths: string[], { event = 'pull_request', seed = [] as string[], moves = [] as [string, string][] } = {}) {
  const { root, env } = await roots.create();
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const repo = join(root, 'repo');
  const write = async (path: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `change ${path}`);
  };
  await mkdir(repo);
  const git = (...args: string[]) => run(repo, ['git', ...args], env);
  await git('init', '-q', '-b', 'main');
  for (const path of ['seed.txt', ...seed]) await write(path);
  await git('add', '.'); await git('commit', '-q', '-m', 'chore: base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const path of paths) await write(path);
  for (const [from, to] of moves) {
    await mkdir(dirname(join(repo, to)), { recursive: true });
    await rename(join(repo, from), join(repo, to));
  }
  await git('add', '-A'); await git('commit', '-q', '--allow-empty', '-m', 'docs: change');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const result = await run(repo, ['sh', script], { ...env, EVENT: event, BASE: base, HEAD: head });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return parse(result.stdout);
}

function parse(stdout: string): Outputs {
  const lines = stdout.trim().split('\n');
  const outputs = Object.fromEntries(lines.map(line => line.split(/=(.*)/s).slice(0, 2)));
  expect(Object.keys(outputs)).toHaveLength(lines.length);
  return outputs;
}

/** Evaluate checks.yml's job conditions and matrices against classifier outputs; returns job → runner count. */
async function runningJobs(outputs: Outputs) {
  const binaries = (await workflow('companion-artifacts.yml')).jobs.binary.strategy.matrix.include.length;
  const jobs: Record<string, number> = {};
  for (const [id, job] of Object.entries<any>(checks.jobs)) {
    if (job.needs !== undefined) {
      const output = /^needs\.changes\.outputs\.([a-z_]+) == 'true'$/.exec(job.if)?.[1];
      expect(output, id).toBeDefined();
      expect(outputs[output!], id).toMatch(/^(true|false)$/);
      if (outputs[output!] !== 'true') continue;
    } else expect(job.if, id).toBeUndefined();
    let count = job.uses === './.github/workflows/companion-artifacts.yml' ? binaries : 1;
    for (const [key, values] of Object.entries<any>(job.strategy?.matrix ?? {})) {
      expect(key, id).not.toMatch(/^(include|exclude)$/);
      const dynamic = typeof values === 'string' ? /^\$\{\{ fromJSON\(needs\.changes\.outputs\.([a-z_]+)\) \}\}$/.exec(values)?.[1] : undefined;
      if (typeof values === 'string') expect(dynamic, id).toBeDefined();
      count *= (dynamic ? JSON.parse(outputs[dynamic]) : values).length;
    }
    jobs[id] = count;
  }
  return jobs;
}

const alwaysRun = { changes: 1, client: 1, agent: 1 };
const fullRun = { ...alwaysRun, 'companion-candidates': 5, 'herdr-native': 1, 'native-linux': 1, 'native-desktop': 2,
  'native-android': 1, 'native-android-runtime': 1, 'native-android-mosh': 1, 'native-android-herdr-navigation': 1, 'native-android-tmux': 1,
  'native-android-ssh-parity': 1, 'native-linux-runtimes': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 2, 'native-ios-simulator': 1,
  'native-android-biometric': 1 };
const clientRun = { ...alwaysRun, 'herdr-native': 1, 'native-linux': 1, 'native-linux-runtimes': 1, 'native-desktop': 2,
  'native-android': 1, 'native-android-runtime': 1, 'native-android-tmux': 1, 'native-android-ssh-parity': 1, 'native-android-biometric': 1 };
const agentRun = { ...alwaysRun, 'companion-candidates': 5, 'herdr-native': 1, 'native-linux': 1, 'native-desktop': 2,
  'native-android-runtime': 1, 'native-android-herdr-navigation': 1, 'native-android-auxiliary': 1 };
const androidRun = { ...alwaysRun, 'herdr-native': 1, 'native-android': 1, 'native-android-runtime': 1,
  'native-android-herdr-navigation': 1, 'native-android-tmux': 1, 'native-android-ssh-parity': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 1, 'native-android-biometric': 1 };
const iosRun = { ...alwaysRun, 'native-ios-simulator': 1 };

test.each([
  [['docs/connections.md']],
  [['README.md', 'CHANGELOG.md', '.changeset/docs-note.md']],
  [['.github/ISSUE_TEMPLATE/bug.md', '.github/pull_request_template.md', '.github/TEMPLATES.md']],
])('a documentation-only pull request runs only the always-on jobs: %p', async paths => {
  const outputs = await classify(paths);
  expect(outputs).toEqual({ ...nothing, docs_only: 'true' });
  expect(await runningJobs(outputs)).toEqual(alwaysRun);
});

test.each([
  ['a workflow', ['.github/workflows/fdroid.yml']],
  ['a CI script', ['.github/scripts/native-changes.sh']],
  ['a shared composite action', ['.github/actions/setup-bun/action.yml']],
  ['the Cargo lockfile', ['Cargo.lock']],
  ['the Bun lockfile', ['bun.lock']],
  ['the root manifest', ['package.json']],
  ['the moon workspace and inherited tasks', ['.moon/tasks/cargo.yml']],
  ['the proto toolchain pins', ['.prototools']],
  ['release tooling', ['.changeset/release-policy.json']],
  ['a nested changeset path', ['.changeset/notes/extra.md']],
  ['an unrecognised path', ['scripts/new-tool.sh']],
  ['an unrecognised package', ['packages/new-package/src/lib.rs']],
  ['a shared test helper', ['tests/support/ownedProcess.ts']],
  ['documentation plus a workflow', ['docs/ci.md', '.github/workflows/checks.yml']],
  ['an empty range', []],
] as const)('%s selects every job and the full matrix', async (_, paths) => {
  const outputs = await classify([...paths]);
  expect(outputs).toEqual(everything);
  expect(await runningJobs(outputs)).toEqual(fullRun);
});

test('pushes and manual runs always select every job and the full matrix, even for documentation', async () => {
  expect(await classify(['docs/connections.md'], { event: 'push' })).toEqual(everything);
  expect(await classify(['docs/connections.md'], { event: 'workflow_dispatch' })).toEqual(everything);
});

test('an unreadable range fails toward every job', async () => {
  const { root, env } = await roots.create();
  const result = await run(root, ['sh', script], { ...env, EVENT: 'pull_request', BASE: 'deadbeef', HEAD: 'feedface' });
  expect(result.code).toBe(0);
  expect(parse(result.stdout)).toEqual(everything);
});

test.each([
  ['client UI', ['apps/client/src/App.tsx'], clientRun],
  ['client native Rust', ['apps/client/src-tauri/src/ssh.rs'], clientRun],
  ['a client sub-package changelog', ['apps/client/CHANGELOG.md'], clientRun],
  ['a client-only shared package', ['packages/et-transport/src/lib.rs'], clientRun],
  ['client configuration shared with iOS', ['apps/client/src-tauri/tauri.conf.json'], { ...clientRun, ...iosRun }],
  ['the client moon tasks', ['apps/client/moon.yml'], { ...clientRun, ...iosRun }],
  ['agent', ['apps/agent/src/main.rs'], agentRun],
  ['documentation plus agent', ['docs/connections.md', 'apps/agent/src/main.rs'], agentRun],
  ['Android project', ['apps/client/src-tauri/gen/android/app/build.gradle.kts'], androidRun],
  ['an Android plugin source set', ['packages/credential-vault/android/src/main/kotlin/Vault.kt'], androidRun],
  ['an Android emulator test', ['tests/android-qr.test.ts'], androidRun],
  ['iOS project', ['apps/client/src-tauri/apple/project.yml.hbs'], iosRun],
  ['an iOS plugin source set', ['packages/display-idle/ios/Sources/Idle.swift'], iosRun],
  ['Herdr', ['packages/herdr-guard/client.rs'], { ...alwaysRun, 'herdr-native': 1, 'native-linux': 1,
    'native-linux-runtimes': 1, 'native-android-runtime': 1, 'native-android-herdr-navigation': 1 }],
  ['the terminal runtime', ['packages/terminal-runtime/src/lib.rs'], { ...alwaysRun, 'herdr-native': 1 }],
  ['the Mosh frame fixture the terminal runtime replays', ['apps/client/e2e/fixtures/mosh-resize-frames.json'], { ...clientRun, 'herdr-native': 1 }],
  ['Mosh transport', ['packages/mosh-transport/src/lib.rs'], { ...clientRun, ...iosRun, 'native-android-mosh': 1 }],
  ['push registration', ['packages/push-registration/src/lib.rs'], { ...clientRun, ...iosRun,
    'native-android-herdr-navigation': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 2 }],
  ['shared common code', ['packages/common/src/hex_digest.rs'], { ...clientRun, ...agentRun }],
  ['the shared companion release crate', ['packages/companion-release/src/lib.rs'], { ...clientRun, ...agentRun }],
  ...(['apps/notification-service/src/lib.rs', 'packages/notification-client/src/lib.rs'] as const).map(path => [
    `the notification relay (${path})`, [path], { ...agentRun, 'native-linux-runtimes': 1, 'native-android-ntfy': 2 }] as const),
  ['always-run-only hooks and services', ['.githooks/pre-commit', 'tests/pre-commit.test.ts', 'tests/moon-graph.test.ts',
    '.github/workflows/main-verdict.yml', 'tests/main-verdict.test.ts', 'apps/transcription-service/src/main.rs', 'fdroid/metadata/app.lazysh.client.yml'], alwaysRun],
] as const)('a pull request changing %s runs exactly the jobs it can affect', async (_, paths, expected) => {
  const outputs = await classify([...paths]);
  expect(outputs.docs_only).toBe('false');
  expect(outputs.native).toBe(Object.keys(expected).length > 3 ? 'true' : 'false');
  expect(await runningJobs(outputs)).toEqual(expected);
});

test('renaming a source file into documentation still selects the source jobs', async () => {
  const outputs = await classify([], { seed: ['apps/agent/src/notes.rs'], moves: [['apps/agent/src/notes.rs', 'docs/notes.rs']] });
  expect(outputs.docs_only).toBe('false');
  expect(await runningJobs(outputs)).toEqual(agentRun);
});

test('every native job waits only for the gate and same-run Herdr bytes, and every selector is a classifier output', async () => {
  const declared = checks.jobs.changes.outputs;
  for (const name of Object.keys(everything)) expect(declared[name]).toBe(`\${{ steps.paths.outputs.${name} }}`);
  expect(Object.keys(declared).sort()).toEqual(Object.keys(everything).sort());
  for (const [id, job] of Object.entries<any>(checks.jobs)) {
    if (['changes', 'client', 'agent'].includes(id)) { expect(job.needs, id).toBeUndefined(); continue; }
    const needs = [job.needs].flat();
    expect(needs[0], id).toBe('changes');
    expect(needs.slice(1).every(need => need === 'herdr-native'), id).toBe(true);
  }
  // Pushes select every output, so main keeps the whole matrix as parity evidence.
  expect(await runningJobs(everything)).toEqual(fullRun);
  // The fast gate runs only after classification, only on pull requests that select native work.
  const steps = checks.jobs.changes.steps;
  expect(steps.findIndex((step: any) => step.id === 'paths')).toBe(1);
  expect(steps.length).toBeGreaterThan(2);
  for (const step of steps.slice(2)) expect(step.if).toBe("github.event_name == 'pull_request' && steps.paths.outputs.native == 'true'");
});

test('pull request matrices fail fast while main and release staging keep every verdict', async () => {
  const pullRequestOnly = "${{ github.event_name == 'pull_request' }}";
  expect(checks.jobs['native-desktop'].strategy['fail-fast']).toBe(pullRequestOnly);
  expect(checks.jobs['native-android-ntfy'].strategy['fail-fast']).toBe(pullRequestOnly);
  expect((await workflow('companion-artifacts.yml')).jobs.binary.strategy['fail-fast']).toBe(pullRequestOnly);
});

test('superseded runs cancel only where no publication or caller can be interrupted', async () => {
  const owner = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true };
  for (const name of ['conventional-commits.yml', 'fdroid.yml']) expect((await workflow(name)).concurrency).toEqual(owner);
  // checks and version cancel only superseded pull request runs; a main run always completes, so native
  // verification finishes and the version PR is regenerated even while main keeps moving.
  for (const config of [checks, await workflow('version.yml')]) expect(config.concurrency).toEqual({ ...owner, 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" });
  // Reusable workflows inherit the caller's group; their own group could cancel or deadlock the caller.
  for (const name of ['companion-artifacts.yml', 'release-artifacts.yml']) expect((await workflow(name)).concurrency).toBeUndefined();
  // A new main push never aborts an in-flight verified tag publication.
  expect((await workflow('release-tag.yml')).concurrency).toEqual({ group: 'verified-stable-tag-${{ github.sha }}', 'cancel-in-progress': false });
  // Each manual published-APK verification owns its group; only pull request runs supersede each other.
  expect((await workflow('android-published-apk.yml')).concurrency).toEqual({
    group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}", 'cancel-in-progress': true });
});
