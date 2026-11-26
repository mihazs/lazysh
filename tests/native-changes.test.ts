import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFixtureRoots, project, spawnText as run } from './support/gitFixture';
import { moonJson } from './support/moon';

// The first moon query on a cold runner can take longer than bun's 5 s default.
setDefaultTimeout(60_000);

const script = join(project, '.github', 'scripts', 'native-changes.sh');
const workflow = async (name: string) => Bun.YAML.parse(await Bun.file(join(project, '.github', 'workflows', name)).text()) as any;
const checks = await workflow('checks.yml');
const roots = gitFixtureRoots('lazysh-native-changes-test-');
afterAll(() => roots.cleanup());

type Outputs = Record<string, string>;
const jobOutputs = ['companion', 'herdr', 'terminal_runtime', 'terminal_bridge', 'terminal_windows', 'linux', 'linux_runtimes', 'desktop', 'android', 'android_runtime', 'android_terminal_core', 'android_terminal_session', 'android_mosh',
  'android_herdr', 'android_appium', 'android_auxiliary', 'android_ntfy', 'android_gotify', 'ios', 'terminal_perf', 'terminal_macos', 'linux_surface', 'terminal_ios'];
// The quarantine job needs a quarantined (@flaky) Appium spec; the fixture repositories have none unless a test seeds one.
const everything: Outputs = { ...Object.fromEntries(jobOutputs.map(name => [name, 'true'])), android_appium_quarantine: 'false', android_release_native: 'false',
  ntfy_variants: '["fdroid","google"]', native: 'true', docs_only: 'false' };
// Jobs that are not required to merge: pull requests never select them, pushes to main always do. terminal-perf is report-only
// too, but it follows the terminal runtime area on a pull request (see the selection test below).
const mainOnlyOutputs = ['companion', 'desktop', 'android_mosh', 'android_herdr', 'android_auxiliary', 'android_ntfy', 'ios', 'terminal_macos', 'terminal_ios'];
const mainOnlyJobs = ['companion-candidates', 'native-desktop', 'native-windows-linux-host', 'native-android-mosh', 'native-android-herdr-navigation',
  'native-android-auxiliary', 'native-android-ntfy', 'native-ios-simulator', 'terminal-macos', 'terminal-ios'];
const pullRequestEverything: Outputs = { ...everything, ...Object.fromEntries(mainOnlyOutputs.map(name => [name, 'false'])) };
const onPullRequest = (jobs: Record<string, number>) => Object.fromEntries(Object.entries(jobs).filter(([id]) => !mainOnlyJobs.includes(id)));
const nothing: Outputs = { ...Object.fromEntries(jobOutputs.map(name => [name, 'false'])), android_appium_quarantine: 'false', android_release_native: 'false',
  ntfy_variants: '["google"]', native: 'false' };

/** Commit `paths` (and `moves` of seeded files) over a base commit and classify the range as checks.yml does. */
async function classify(paths: string[], { event = 'pull_request', seed = [] as string[], moves = [] as [string, string][], contents = {} as Record<string, string>, seedContents = {} as Record<string, string>, areas = '' } = {}) {
  const { root, env } = await roots.create();
  Object.assign(env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const repo = join(root, 'repo');
  const write = async (path: string, text = contents[path]) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text ?? `change ${path}`);
  };
  await mkdir(repo);
  const git = (...args: string[]) => run(repo, ['git', ...args], env);
  await git('init', '-q', '-b', 'main');
  for (const path of ['seed.txt', ...seed]) await write(path, seedContents[path]);
  await git('add', '.'); await git('commit', '-q', '-m', 'chore: base');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const path of paths) await write(path);
  for (const [from, to] of moves) {
    await mkdir(dirname(join(repo, to)), { recursive: true });
    await rename(join(repo, from), join(repo, to));
  }
  await git('add', '-A'); await git('commit', '-q', '--allow-empty', '-m', 'docs: change');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const result = await run(repo, ['sh', script], { ...env, EVENT: event, AREAS: areas, BASE: base, HEAD: head });
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
async function runningJobs(outputs: Outputs, event = 'push') {
  const binaries = (await workflow('companion-artifacts.yml')).jobs.binary.strategy.matrix.include.length;
  const jobs: Record<string, number> = {};
  for (const [id, job] of Object.entries<any>(checks.jobs)) {
    // This verdict observes failures as well as success, so it has its own cases below.
    if (id === 'terminal-perf-verdict') continue;
    if (job.needs !== undefined) {
      const output = /^needs\.changes\.outputs\.([a-z_]+) == 'true'$/.exec(job.if)?.[1];
      expect(output, id).toBeDefined();
      expect(outputs[output!], id).toMatch(/^(true|false)$/);
      if (outputs[output!] !== 'true') continue;
    } else {
      // `changes` classifies every event; client and agent always run, except the nightly, which is the device suite alone.
      expect(job.if, id).toBe(id === 'changes' ? undefined : neverNightly);
      if ((event === 'schedule' || event === 'workflow_dispatch') && id !== 'changes') continue;
    }
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

test.each([
  ['success', 'false', 'skipped', 0],
  ['success', 'true', 'success', 0],
  ['success', 'true', 'failure', 1],
  ['success', 'true', 'cancelled', 1],
  ['success', 'true', 'skipped', 1],
  ['success', '', 'skipped', 1],
  ['failure', 'false', 'skipped', 1],
] as const)('terminal performance verdict: changes %s, selected %s, benchmark %s', async (changes, selected, benchmark, code) => {
  const job = checks.jobs['terminal-perf-verdict'];
  expect(job.needs).toEqual(['changes', 'terminal-perf']);
  expect(job.if).toBe("always() && github.event_name == 'pull_request'");
  const verdict = job.steps[0];
  expect(verdict.env).toEqual({
    CHANGES_RESULT: '${{ needs.changes.result }}',
    PERF_SELECTED: '${{ needs.changes.outputs.terminal_perf }}',
    PERF_RESULT: '${{ needs.terminal-perf.result }}',
  });
  const result = await run(project, ['sh', '-c', verdict.run], {
    ...process.env, CHANGES_RESULT: changes, PERF_SELECTED: selected, PERF_RESULT: benchmark,
  });
  expect(result.code).toBe(code);
});

const neverNightly = "github.event_name != 'schedule' && github.event_name != 'workflow_dispatch'";
const alwaysRun = { changes: 1, client: 1, agent: 1 };
const tmuxRuns = { 'native-android-tmux': 1, 'native-android-terminal-tmux': 1 };
const fullRun = { ...alwaysRun, 'companion-candidates': 5, 'herdr-native': 1, 'terminal-perf': 1, 'terminal-macos': 1, 'terminal-windows': 1, 'terminal-ios': 1, 'native-linux-surface': 1, 'native-linux': 1, 'native-terminal-bridge': 1, 'native-desktop': 2, 'native-windows-linux-host': 1,
  'native-android': 1, 'native-android-runtime': 1, 'native-android-terminal-core': 1, 'native-android-terminal-session': 1, 'native-android-mosh': 1, 'native-android-herdr-navigation': 1, ...tmuxRuns, 'native-android-zellij': 1,
  'native-android-ssh-parity': 1, 'native-linux-runtimes': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 2, 'native-android-gotify': 1, 'native-ios-simulator': 1,
  'native-android-biometric': 1, 'native-android-appium': 1 };
const clientRun = { ...alwaysRun, 'herdr-native': 1, 'native-linux': 1, 'native-linux-runtimes': 1, 'native-terminal-bridge': 1, 'native-desktop': 2, 'native-windows-linux-host': 1,
  'native-android': 1, 'native-android-runtime': 1, 'native-android-terminal-core': 1, ...tmuxRuns, 'native-android-zellij': 1, 'native-android-ssh-parity': 1, 'native-android-biometric': 1, 'native-android-appium': 1 };
const agentRun = { ...alwaysRun, 'companion-candidates': 5, 'herdr-native': 1, 'native-linux': 1, 'native-desktop': 2, 'native-windows-linux-host': 1,
  'native-android-runtime': 1, 'native-android-herdr-navigation': 1, 'native-android-auxiliary': 1, 'native-android-appium': 1 };
const androidRun = { ...alwaysRun, 'herdr-native': 1, 'native-android': 1, 'native-android-runtime': 1, 'native-android-terminal-core': 1,
  'native-android-herdr-navigation': 1, ...tmuxRuns, 'native-android-zellij': 1, 'native-android-ssh-parity': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 1, 'native-android-biometric': 1, 'native-android-appium': 1 };
const iosRun = { ...alwaysRun, 'native-ios-simulator': 1 };
const herdrRun = { ...alwaysRun, 'herdr-native': 1, 'native-linux': 1,
  'native-linux-runtimes': 1, 'native-android-runtime': 1, 'native-android-herdr-navigation': 1, 'native-android-appium': 1 };

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
] as const)('%s selects every required job and the full matrix', async (_, paths) => {
  const outputs = await classify([...paths]);
  expect(outputs).toEqual(pullRequestEverything);
  expect(await runningJobs(outputs)).toEqual(onPullRequest(fullRun));
});

test('only a pull request that changes the release build configuration builds the release APK with the native engine', async () => {
  for (const path of ['.github/workflows/release-artifacts.yml', '.github/actions/ghostty-zig/action.yml', '.changeset/release-artifacts.ts', '.github/scripts/apk-engine.ts', '.github/scripts/software-gpu-switch.sh', 'tests/software-gpu-switch.test.ts']) {
    const outputs = await classify([path]);
    expect(outputs, path).toEqual({ ...pullRequestEverything, android_release_native: 'true' });
    expect((await runningJobs(outputs))['native-android-release-core'], path).toBe(2); // the kill switch on and off
  }
  for (const request of [await classify(['.github/workflows/checks.yml']), await classify(['docs/connections.md'], { event: 'push' })]) {
    expect(request.android_release_native).toBe('false');
    expect((await runningJobs(request))['native-android-release-core']).toBeUndefined();
  }
});

test('pushes and manual runs always select every job and the full matrix, even for documentation', async () => {
  expect(await classify(['docs/connections.md'], { event: 'push' })).toEqual(everything);
  expect(await classify(['docs/connections.md'], { event: 'workflow_dispatch' })).toEqual(everything);
});

test('an unreadable range fails toward every required job', async () => {
  const { root, env } = await roots.create();
  const result = await run(root, ['sh', script], { ...env, EVENT: 'pull_request', BASE: 'deadbeef', HEAD: 'feedface' });
  expect(result.code).toBe(0);
  expect(parse(result.stdout)).toEqual(pullRequestEverything);
});

test('a pull request never runs the jobs that are not required to merge, whatever its paths; main runs them all', async () => {
  for (const paths of [['apps/agent/src/main.rs'], ['apps/client/src-tauri/apple/project.yml.hbs'], ['packages/mosh-transport/src/lib.rs'],
    ['packages/push-registration/src/lib.rs'], ['apps/client/src/App.tsx'], ['.github/workflows/checks.yml']]) {
    const outputs = await classify(paths);
    for (const name of mainOnlyOutputs) expect(outputs[name], `${paths} ${name}`).toBe('false');
    for (const id of Object.keys(await runningJobs(outputs))) expect(mainOnlyJobs, `${paths} ${id}`).not.toContain(id);
    expect(outputs.native, `${paths} still reaches the fast gate`).toBe('true');
  }
  for (const event of ['push', 'workflow_dispatch']) {
    const jobs = await runningJobs(await classify(['docs/connections.md'], { event }));
    for (const id of mainOnlyJobs) expect(jobs[id], `${event} ${id}`).toBeGreaterThan(0);
  }
});

test.each([
  ['client UI', ['apps/client/src/App.tsx'], clientRun],
  ['client native Rust', ['apps/client/src-tauri/src/ssh.rs'], clientRun],
  // Only the native terminal's own sources select the job that drives a native session through the real UI.
  ['the native terminal core commands', ['apps/client/src-tauri/src/terminal_core.rs'], { ...clientRun, 'native-android-terminal-session': 1 }],
  ['the native terminal page adapter', ['apps/client/src/nativeTerminalAdapter.ts'], { ...clientRun, 'native-android-terminal-session': 1 }],
  ['the native session harness', ['tests/support/androidTerminalCore.ts'], { ...androidRun, 'native-android-terminal-session': 1 }],
  ['a client sub-package changelog', ['apps/client/CHANGELOG.md'], clientRun],
  ['a client-only shared package', ['packages/et-transport/src/lib.rs'], clientRun],
  ['client configuration shared with iOS', ['apps/client/src-tauri/tauri.conf.json'], { ...clientRun, ...iosRun }],
  ['the client moon tasks', ['apps/client/moon.yml'], { ...clientRun, ...iosRun }],
  ['agent', ['apps/agent/src/main.rs'], agentRun],
  ['documentation plus agent', ['docs/connections.md', 'apps/agent/src/main.rs'], agentRun],
  ['Android project', ['apps/client/src-tauri/gen/android/app/build.gradle.kts'], { ...androidRun, 'native-android-terminal-session': 1 }],
  ['an Android plugin source set', ['packages/credential-vault/android/src/main/kotlin/Vault.kt'], androidRun],
  ['an Android emulator test', ['tests/android-qr.test.ts'], androidRun],
  ['an Appium spec', ['apps/client/mobile-e2e/specs/smoke/launch.e2e.ts'], clientRun],
  ['the owned SSH fixture the Appium suite reuses', ['tests/support/sshFixture.ts'], { ...clientRun, ...androidRun }],
  ['iOS project', ['apps/client/src-tauri/apple/project.yml.hbs'], iosRun],
  ['an iOS plugin source set', ['packages/display-idle/ios/Sources/Idle.swift'], iosRun],
  ['Herdr', ['packages/herdr-guard/client.rs', 'tests/herdr-notices.test.ts', '.github/herdr-notices/reviewed.json'], herdrRun],
  // The app bridge compiles the runtime, ghostty-vt and the vendored libghostty-vt with the native-terminal feature.
  ['the terminal runtime', ['packages/terminal-runtime/src/lib.rs'], { ...alwaysRun, 'herdr-native': 1, 'terminal-perf': 1, 'native-terminal-bridge': 1, 'terminal-windows': 1, 'native-android-terminal-core': 1, 'native-android-terminal-session': 1 }],
  ['the terminal renderer, which the app compiles with the same feature', ['packages/terminal-renderer-wgpu/src/lib.rs'], { ...alwaysRun, 'herdr-native': 1, 'terminal-perf': 1, 'native-terminal-bridge': 1, 'terminal-windows': 1, 'native-android-terminal-core': 1, 'native-android-terminal-session': 1 }],
  ...(['packages/herdr-upstream/crates/ghostty-vt/src/lib.rs', 'packages/herdr-upstream/vendor/libghostty-vt/build.zig'] as const).map(path => [
    `the vendored Herdr binding the terminal runtime builds on and its library (${path})`, [path], { ...herdrRun, 'terminal-perf': 1, 'native-terminal-bridge': 1, 'terminal-windows': 1, 'native-android-terminal-core': 1, 'native-android-terminal-session': 1 }] as const),
  ['the Linux composition probe, a standalone prototype crate', ['packages/terminal-runtime/prototypes/linux-surface/src/main.rs'], { ...alwaysRun, 'native-linux-surface': 1 }],
  ["the probe's harness, which also drives the real app's surface host", ['packages/terminal-runtime/prototypes/linux-surface/scripts/check.py'], { ...alwaysRun, 'native-linux-surface': 1, 'native-terminal-bridge': 1 }],
  ["Herdr's own source, which the terminal runtime does not build on", ['packages/herdr-upstream/src/main.rs'], { ...herdrRun, 'terminal-perf': 1 }],
  ['the Mosh frame fixture the terminal runtime replays', ['apps/client/e2e/fixtures/mosh-resize-frames.json'], { ...clientRun, 'herdr-native': 1, 'terminal-perf': 1, 'terminal-windows': 1 }],
  ['the platform key fixtures the terminal runtime is held to', ['apps/client/e2e/fixtures/platform-keys/mac.json'], { ...clientRun, 'herdr-native': 1, 'terminal-perf': 1, 'terminal-windows': 1 }],
  ['Mosh transport', ['packages/mosh-transport/src/lib.rs'], { ...clientRun, ...iosRun, 'native-android-mosh': 1 }],
  ['push registration', ['packages/push-registration/src/lib.rs'], { ...clientRun, ...iosRun,
    'native-android-herdr-navigation': 1, 'native-android-auxiliary': 1, 'native-android-ntfy': 2 }],
  ['shared common code', ['packages/common/src/hex_digest.rs'], { ...clientRun, ...agentRun, 'native-android-gotify': 1 }],
  ['the shared companion release crate', ['packages/companion-release/src/lib.rs'], { ...clientRun, ...agentRun }],
  ...(['apps/notification-service/src/lib.rs', 'packages/notification-client/src/lib.rs'] as const).map(path => [
    `the notification relay (${path})`, [path], { ...(path.startsWith('packages/') ? clientRun : {}), ...agentRun, 'native-linux-runtimes': 1, 'native-android-ntfy': 2, 'native-android-gotify': 1 }] as const),
  ['the Gotify acceptance owner and its host support', ['tests/android-gotify.test.ts', 'tests/support/androidGotify.ts'], { ...alwaysRun, 'native-android-gotify': 1 }],
  ['the native Gotify case', ['apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/GotifyAndroidTest.kt'], { ...androidRun, 'native-android-gotify': 1 }],
  ['the pinned official Gotify artifacts', ['apps/client/src-tauri/fixtures/gotify-provenance.json'], { ...clientRun, 'native-android-gotify': 1 }],
  ['the owned SSH continuity probes the Gotify owner reuses', ['tests/support/androidSsh.ts'], { ...clientRun, ...androidRun, 'native-android-gotify': 1 }],
  ['always-run-only hooks and services', ['.githooks/pre-commit', 'tests/pre-commit.test.ts', 'tests/moon-graph.test.ts', 'tests/speech-fixtures.test.ts',
    '.github/workflows/main-verdict.yml', 'tests/main-verdict.test.ts', 'tests/native-lib-size.test.ts', '.github/workflows/conventional-commits.yml', 'tests/regression-check.test.ts', 'apps/transcription-service/src/main.rs', 'fdroid/metadata/app.lazysh.client.yml'], alwaysRun],
  ['the Windows composition probe, a standalone prototype crate with its own workflow', ['packages/terminal-runtime/prototypes/windows-surface/src/main.rs', '.github/workflows/windows-surface-probe.yml'], alwaysRun],
] as const)('a pull request changing %s runs exactly the jobs it can affect', async (_, paths, expected) => {
  const outputs = await classify([...paths]);
  expect(outputs.docs_only).toBe('false');
  expect(outputs.native).toBe(Object.keys(expected).length > 3 ? 'true' : 'false');
  expect(await runningJobs(outputs)).toEqual(onPullRequest(expected));
});

test('the vendored Herdr binding selects the terminal runtime checks, including its Android and Windows builds; the guard does not', async () => {
  const binding = await classify(['packages/herdr-upstream/crates/ghostty-vt/build.rs']);
  expect([binding.terminal_runtime, binding.terminal_windows]).toEqual(['true', 'true']);
  const guard = await classify(['packages/herdr-guard/client.rs']);
  expect([guard.terminal_runtime, guard.terminal_windows]).toEqual(['false', 'false']);
});

test('the terminal performance gate runs on a pull request for the runtime and the renderer, never for unrelated paths, and on main always', async () => {
  for (const path of ['packages/terminal-runtime/src/lib.rs', 'packages/terminal-renderer-wgpu/src/lib.rs']) {
    const outputs = await classify([path]);
    expect(outputs.terminal_perf, path).toBe('true');
    expect(await runningJobs(outputs), path).toHaveProperty('terminal-perf', 1);
  }
  for (const path of ['docs/architecture/terminal-runtime.md', 'apps/agent/src/main.rs', 'apps/client/src/App.tsx', 'packages/herdr-guard/client.rs', 'packages/mosh-transport/src/lib.rs']) {
    const outputs = await classify([path]);
    expect(outputs.terminal_perf, path).toBe('false');
    expect(await runningJobs(outputs), path).not.toHaveProperty('terminal-perf');
  }
  expect(await runningJobs(await classify(['docs/connections.md'], { event: 'push' }))).toHaveProperty('terminal-perf', 1);
});

test('the nightly runs the Appium suite and the Herdr it needs, and nothing else', async () => {
  const outputs = await classify([], { event: 'schedule' });
  expect(outputs).toEqual({ ...nothing, herdr: 'true', android_appium: 'true', native: 'true', docs_only: 'false' });
  expect(await runningJobs(outputs, 'schedule')).toEqual({ changes: 1, 'herdr-native': 1, 'native-android-appium': 1 });
});

test('a manual dispatch runs only the named areas, by default the macOS and iOS terminal core jobs', async () => {
  const outputs = await classify([], { event: 'workflow_dispatch', areas: 'terminal_apple' });
  expect(outputs).toEqual({ ...nothing, terminal_macos: 'true', terminal_ios: 'true', native: 'true', docs_only: 'false' });
  expect(await runningJobs(outputs, 'workflow_dispatch')).toEqual({ changes: 1, 'terminal-macos': 1, 'terminal-ios': 1 });
  // Without areas a dispatch is a manual full run.
  expect(await classify([], { event: 'workflow_dispatch', areas: '' })).toEqual(everything);
});

test('quarantined Appium specs get their own job on main and the nightly, never on a pull request or without a tagged spec', async () => {
  const spec = 'apps/client/mobile-e2e/specs/regression/scroll/1402-swipe.e2e.ts';
  const quarantined = { [spec]: "describe('Swipe @flaky', () => {});" };
  for (const event of ['push', 'schedule']) {
    const outputs = await classify([spec], { event, contents: quarantined });
    expect(outputs.android_appium_quarantine, event).toBe('true');
    expect(await runningJobs(outputs, event)).toHaveProperty('native-android-appium-quarantine', 1);
  }
  expect((await classify([spec], { event: 'pull_request', contents: quarantined })).android_appium_quarantine).toBe('false');
  expect((await classify([spec], { event: 'push' })).android_appium_quarantine).toBe('false');
  // Only a spec file counts: the tag in a document is just a word.
  expect((await classify(['docs/regression-tests.md'], { event: 'push', contents: { 'docs/regression-tests.md': '@flaky' } })).android_appium_quarantine).toBe('false');
});

test('renaming a source file into documentation still selects the source jobs', async () => {
  const outputs = await classify([], { seed: ['apps/agent/src/notes.rs'], moves: [['apps/agent/src/notes.rs', 'docs/notes.rs']] });
  expect(outputs.docs_only).toBe('false');
  expect(await runningJobs(outputs)).toEqual(onPullRequest(agentRun));
});

test('every native job waits only for the gate and same-run Herdr bytes, and every selector is a classifier output', async () => {
  const declared = checks.jobs.changes.outputs;
  for (const name of Object.keys(everything)) expect(declared[name]).toBe(`\${{ steps.paths.outputs.${name} }}`);
  expect(Object.keys(declared).sort()).toEqual(Object.keys(everything).sort());
  for (const [id, job] of Object.entries<any>(checks.jobs)) {
    if (['changes', 'client', 'agent'].includes(id)) { expect(job.needs, id).toBeUndefined(); continue; }
    if (id === 'terminal-perf-verdict') continue;
    const needs = [job.needs].flat();
    expect(needs[0], id).toBe('changes');
    expect(needs.slice(1).every(need => need === 'herdr-native'), id).toBe(true);
  }
  // Pushes select every output, so main keeps the whole matrix as parity evidence.
  expect(await runningJobs(everything)).toEqual(fullRun);
  // The fast gate runs only after classification, only on pull requests that select native work.
  const steps = checks.jobs.changes.steps;
  // The two steps before it install Bun and the workspace so that the script can query the moon project graph.
  const paths = steps.findIndex((step: any) => step.id === 'paths');
  expect(paths).toBe(3);
  for (const step of steps.slice(1, paths)) expect(step.if).toBe("github.event_name == 'pull_request'");
  expect(steps.length).toBeGreaterThan(paths + 1);
  for (const step of steps.slice(paths + 1)) expect(step.if).toBe("github.event_name == 'pull_request' && steps.paths.outputs.native == 'true'");
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
  // verification finishes and the version PR is regenerated even while main keeps moving. The nightly device run has its
  // own group, so it can neither displace a pending main run nor be displaced by one.
  const supersededPullRequestsOnly = { 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" };
  expect((await workflow('version.yml')).concurrency).toEqual({ ...owner, ...supersededPullRequestsOnly });
  expect(checks.concurrency).toEqual({ group: "${{ github.workflow }}-${{ github.event_name == 'schedule' && 'nightly' || github.ref }}", ...supersededPullRequestsOnly });
  // Reusable workflows inherit the caller's group; their own group could cancel or deadlock the caller.
  for (const name of ['companion-artifacts.yml', 'release-artifacts.yml']) expect((await workflow(name)).concurrency).toBeUndefined();
  // A new main push never aborts an in-flight verified tag publication.
  expect((await workflow('release-tag.yml')).concurrency).toEqual({ group: 'verified-stable-tag-${{ github.sha }}', 'cancel-in-progress': false });
  // Each manual published-APK verification owns its group; only pull request runs supersede each other.
  expect((await workflow('android-published-apk.yml')).concurrency).toEqual({
    group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}", 'cancel-in-progress': true });
});

test('a Changesets version bump selects no native job, but a dependency or code change in the same range selects everything', async () => {
  const pkg = (version: string) => `{\n  "name": "x",\n  "version": "${version}",\n  "dependencies": {}\n}\n`;
  const base = { 'package.json': pkg('1.0.0'), 'apps/agent/package.json': pkg('1.0.0'), 'Cargo.lock': 'version = "1.0.0"\n', '.changeset/a.md': 'x' };
  const seed = Object.keys(base);
  const bump = { 'package.json': pkg('1.0.1'), 'apps/agent/package.json': pkg('1.0.1'), 'Cargo.lock': 'version = "1.0.1"\n', 'CHANGELOG.md': '## 1.0.1\n' };
  const run = (paths: string[], contents: Record<string, string>, moves: [string, string][] = []) => classify(paths, { seed, seedContents: base, contents, moves });
  expect(await run(Object.keys(bump), bump)).toEqual({ ...nothing, docs_only: 'false' });
  // The root manifest must be bumped.
  expect((await run(['apps/agent/package.json'], { 'apps/agent/package.json': pkg('1.0.1') })).linux).toBe('true');
  // A changed dependency is not a version line.
  expect((await run(Object.keys(bump), { ...bump, 'apps/agent/package.json': pkg('1.0.1').replace('{}', '{"left-pad": "1"}') })).linux).toBe('true');
  // Source next to the bump.
  expect((await run([...Object.keys(bump), 'apps/client/src/a.ts'], bump)).android).toBe('true');
  // A bump on a push to main still runs everything.
  expect(await classify(Object.keys(bump), { event: 'push', seed, seedContents: base, contents: bump })).toEqual(everything);
});

test('the graph-derived area map covers every moon project, only names real edges, and a path outside the graph selects everything', async () => {
  const config = JSON.parse(await Bun.file(join(project, '.github', 'ci-areas.json')).text());
  const projects = (await moonJson(['query', 'projects'])).projects as any[];
  // A new project without an entry would silently select no area: this fails until it is mapped.
  expect(projects.map(entry => entry.id).sort()).toEqual(Object.keys(config.projects).sort());
  const edges = projects.flatMap(entry => (entry.config.dependsOn ?? []).map((dependency: any) => `${entry.id}>${dependency.id ?? dependency}`));
  for (const edge of config.ignoreEdges) expect(edges).toContain(edge);
  const unknown = await classify(['packages/not-a-project/src/lib.rs']);
  expect(unknown).toEqual(pullRequestEverything);
});

test('a change in a leaf crate selects its dependents through moon, not unrelated jobs', async () => {
  const outputs = await classify(['packages/et-transport/src/lib.rs']);
  expect(outputs.linux).toBe('true'); // client depends on it
  expect(outputs.terminal_runtime).toBe('false');
  expect(outputs.android).toBe('true');
});
