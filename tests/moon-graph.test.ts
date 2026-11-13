import { afterAll, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { commandLine, moonJson, moonScript, moonTask } from './support/moon';

const root = join(import.meta.dir, '..');
const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(directory => rm(directory, { recursive: true, force: true }))));

const projects: Map<string, { source: string; dependsOn: string[]; tags: string[] }> = new Map(
  ((await moonJson(['query', 'projects'])).projects as any[]).map(project => [project.id, {
    source: project.source, tags: project.config.tags ?? [], dependsOn: (project.config.dependsOn ?? []).map((dependency: any) => dependency.id ?? dependency),
  }]));

test('the workspace loads with its layer and tag constraints satisfied', async () => {
  const child = Bun.spawn([process.execPath, moonScript, 'projects'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  expect([...projects.keys()].sort()).toEqual([
    'account-usage', 'agent', 'ai-usagebar-vendor', 'apple-speech', 'apple-status', 'client', 'client-native', 'common',
    'companion-release', 'credential-vault', 'deep-link-vendor', 'display-idle', 'et-transport', 'herdr-guard', 'herdr-upstream', 'mosh-transport',
    'notification-client', 'notification-service', 'parakeet-runtime', 'portable-pty-vendor', 'push-registration',
    'share-service', 'terminal-runtime', 'transcription-service',
  ]);
});

test('every Cargo path dependency between crates is a moon project dependency, including cfg-target and patch edges', async () => {
  const child = Bun.spawn(['cargo', 'metadata', '--no-deps', '--locked', '--offline', '--format-version', '1'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, error }).toEqual({ status: 0, error: expect.any(String) });
  const byDirectory = new Map([...projects].map(([id, project]) => [resolve(root, project.source), id]));
  const missing: string[] = [];
  for (const crate of JSON.parse(output).packages) {
    const owner = byDirectory.get(dirname(crate.manifest_path));
    expect({ crate: crate.name, owner: owner !== undefined }).toEqual({ crate: crate.name, owner: true });
    for (const dependency of crate.dependencies.filter((entry: any) => entry.path)) {
      const target = byDirectory.get(dependency.path);
      if (target === undefined) missing.push(`${crate.name} -> ${relative(root, dependency.path)} has no moon project`);
      else if (!projects.get(owner!)!.dependsOn.includes(target)) missing.push(`${owner} -> ${target}`);
    }
  }
  expect(missing).toEqual([]);
  // [patch] sources are invisible to cargo metadata --no-deps; the patched crate must still have a dependent.
  const patched = Object.values<any>((Bun.TOML.parse(await Bun.file(join(root, 'Cargo.toml')).text()) as any).patch['crates-io']).map(entry => byDirectory.get(resolve(root, entry.path))!);
  for (const id of patched) expect([id, [...projects.values()].some(project => project.dependsOn.includes(id))]).toEqual([id, true]);
});

// The legacy turbo task names, each mapped to its moon target. Every one must still resolve.
const legacy: Record<string, string> = {
  dev: 'client:dev', 'dev:native': 'client:dev-native', build: 'client:build', check: 'client:check', test: 'client:test',
  'check:native-gui': 'client:check-native-gui', 'test:e2e': 'client:test-e2e', 'test:install-browser': 'client:test-install-browser',
  'test:native-gui': 'client:test-native-gui', 'build:native': 'client:build-native', 'build:android': 'client:build-android',
  'build:android:emulator': 'client:build-android-emulator', 'build:android:fdroid': 'client:build-android-fdroid',
  'build:android:fdroid:emulator': 'client:build-android-fdroid-emulator', 'test:android-push-artifact': 'client:test-android-push-artifact',
  'test:android-fdroid': 'client:test-android-fdroid', 'test:android-ntfy': 'client:test-android-ntfy', 'test:android': 'client:test-android',
  'test:android-theme-links': 'client:test-android-theme-links', 'test:android-ssh': 'client:test-android-ssh',
  'test:android-ssh-parity': 'client:test-android-ssh-parity', 'test:android-herdr-navigation': 'client:test-android-herdr-navigation',
  'test:android-tmux': 'client:test-android-tmux', 'test:android-qr': 'client:test-android-qr', 'test:android-biometric': 'client:test-android-biometric',
  'init:ios': 'client:init-ios', 'build:ios': 'client:build-ios', 'test:ios-workspace': 'client:test-ios-workspace',
  'check:rust': 'client-native:check-rust', 'test:rust': 'client-native:test-rust', lint: 'client-native:lint', 'format:check': 'client-native:format-check',
  'test:resume-policy': 'client-native:test-resume-policy', 'test:openssh': 'client-native:test-openssh',
  'test:openssh-connections': 'client-native:test-openssh-connections', 'test:openssh-auth-tunnel': 'client-native:test-openssh-auth-tunnel', 'test:host-clipboard': 'client-native:test-host-clipboard',
  'test:local': 'client-native:test-local', 'test:mosh': 'client-native:test-mosh', 'test:et': 'client-native:test-et',
  'test:multiplexers': 'client-native:test-multiplexers', 'test:connection-loss': 'client-native:test-connection-loss', 'test:tmux': 'client-native:test-tmux',
  'test:voice': 'client-native:test-voice', 'test:parakeet-product': 'client-native:test-parakeet-product',
  'test:voice-interop:smoke': 'client-native:test-voice-interop-smoke', 'test:voice-interop': 'client-native:test-voice-interop',
  'test:voice-interop:release': 'client-native:test-voice-interop-release', 'test:storage': 'agent:test-storage',
  'test:hooks': 'agent:test-hooks', 'test:apple-status': 'apple-status:test-apple-status', 'build:watchos': 'apple-status:build-watchos',
  'test:apns': 'push-registration:test-apns', 'test:resume': 'credential-vault:test-resume', 'test:android-mosh': 'mosh-transport:test-android-mosh',
  'test:ios-mosh': 'mosh-transport:test-ios-mosh', 'test:parakeet-native': 'parakeet-runtime:test-parakeet-native',
  'test:parakeet-inference': 'parakeet-runtime:test-parakeet-inference', 'test:parakeet-inference:release': 'parakeet-runtime:test-parakeet-inference-release',
};
const cached = new Set(['client:check', 'client:test', 'client:check-native-gui']);

test.each(Object.entries(legacy))('legacy task %s resolves to %s with the old caching and CI eligibility', async (_, target) => {
  const task = await moonTask(target);
  expect(task.options.cache).toBe(cached.has(target));
  // `moon run` filters out tasks that opt out of CI, so every task a workflow names must stay eligible.
  expect(task.options.runInCI).toBe(!task.options.persistent); // dev servers are the only local-only tasks
});

test('release builds, ordering and inline environment survive the port', async () => {
  expect(commandLine(await moonTask('agent:build'))).toBe('cargo build --release --locked');
  // The update tests need the local release-server seam; a command that repeats the inherited arguments would
  // silently select only the tests whose name contains "test".
  expect(commandLine(await moonTask('agent:check-rust'))).toBe('cargo check --locked --features update-test-endpoint');
  expect(commandLine(await moonTask('agent:test-rust'))).toBe('cargo test --locked --features update-test-endpoint');
  expect(commandLine(await moonTask('agent:lint'))).toBe('cargo clippy --locked --all-targets --features update-test-endpoint -- -D warnings');
  expect(commandLine(await moonTask('common:lint'))).toBe('cargo clippy --locked --all-features --all-targets -- -D warnings');
  expect(commandLine(await moonTask('account-usage:check-rust'))).toBe('cargo check --locked --all-features');
  expect(commandLine(await moonTask('client-native:lint'))).toBe('cargo clippy --locked --all-targets -- -D warnings');
  const emulator = await moonTask('client:test-android-herdr-navigation');
  expect(emulator.deps!.map(dependency => dependency.target)).toEqual(['client:build-android-emulator']);
  const android = await moonTask('client:build-android-emulator');
  expect(android.options.envOverride).toBe(true);
  expect(android.env).toEqual({ WHISPER_DONT_GENERATE_BINDINGS: '1', CMAKE_ANDROID_NDK: expect.any(String) });
  expect(commandLine(android)).toBe('tauri android build --target x86_64 --debug --apk --ci');
  const fdroid = await moonTask('client:test-android-fdroid');
  expect(fdroid.deps!.map(dependency => dependency.target)).toEqual(['client:build-android-fdroid-emulator']);
  expect((await moonTask('client:test-android-ssh')).deps!.map(dependency => dependency.target)).toEqual(['client:test-android']);
  expect((await moonTask('client:build')).options.cache).toBe(false); // vite.config.ts embeds git HEAD and dirty state
  expect((await moonTask('client:dev-native')).options.persistent).toBe(true);
  expect((await moonTask('client:test-native-gui')).options.os).toEqual(['linux']);
  expect((await moonTask('apple-status:build-watchos')).options.os).toEqual(['macos']);
});

test('a touched shared crate selects its dependents and nothing unrelated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-moon-affected-'));
  temporary.push(directory);
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--', '.moon', '.prototools', 'package.json', 'bun.lock', 'Cargo.toml', 'Cargo.lock',
    '*/moon.yml', '*/package.json', '*/Cargo.toml'], { cwd: root }).stdout.toString().split('\0').filter(Boolean);
  await Promise.all(listed.map(async path => cp(join(root, path), join(directory, path), { recursive: true }).catch(() => {})));
  await Bun.write(join(directory, 'packages/common/src/lib.rs'), 'pub fn a() {}\n');
  const git = (...args: string[]) => expect(Bun.spawnSync(['git', '-c', 'user.email=a@b', '-c', 'user.name=x', ...args], { cwd: directory }).exitCode).toBe(0);
  git('init', '-q', '-b', 'main', '.'); git('add', '-A'); git('commit', '-qm', 'init');
  await Bun.write(join(directory, 'packages/common/src/lib.rs'), 'pub fn b() {}\n');
  const affected = await moonJson(['query', 'tasks', '--affected', '--downstream', 'deep'], directory);
  const selected = Object.keys(affected.tasks);
  for (const dependent of ['common', 'agent', 'client-native', 'share-service', 'notification-service', 'transcription-service', 'parakeet-runtime'])
    expect(selected).toContain(dependent);
  for (const unrelated of ['mosh-transport', 'credential-vault', 'display-idle', 'client']) expect(selected).not.toContain(unrelated);
});
