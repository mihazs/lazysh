import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { project, spawnText } from './support/gitFixture';

const manifest = join(project, 'apps', 'client', 'src-tauri', 'Cargo.toml');
/** What `cargo tree` resolves for the app (no compilation): the dependency graph the named build would compile. */
const tree = (target: string, flags: string[], invert: string, edges = 'normal') =>
  spawnText(project, ['cargo', 'tree', '--manifest-path', manifest, '--locked', '--target', target, '-e', edges, '-i', invert, ...flags]);
const linux = 'x86_64-unknown-linux-gnu';
const android = 'aarch64-linux-android';

test('the default build still compiles Whisper and the Parakeet native runtime on Linux x86_64', async () => {
  expect((await tree(linux, [], 'whisper-rs')).code).toBe(0);
  const parakeet = await tree(linux, [], 'lazysh-parakeet-runtime', 'features');
  expect(parakeet.code).toBe(0);
  expect(parakeet.stdout).toContain('lazysh-parakeet-runtime feature "native"');
});

test('the lightweight development build (--no-default-features) compiles neither Whisper nor the Parakeet native runtime', async () => {
  const whisper = await tree(linux, ['--no-default-features'], 'whisper-rs');
  expect(whisper.code).not.toBe(0);
  expect(whisper.stderr).toContain('did not match any packages');
  const parakeet = await tree(linux, ['--no-default-features'], 'lazysh-parakeet-runtime', 'features');
  expect(parakeet.stdout).not.toContain('feature "native"');
});

test('the default F-Droid build keeps Whisper and still carries no Parakeet runtime', async () => {
  expect((await tree(android, ['--features', 'fdroid'], 'whisper-rs')).code).toBe(0);
  expect((await tree(android, ['--features', 'fdroid'], 'lazysh-parakeet-runtime', 'features')).stdout).not.toContain('feature "native"');
  expect((await tree(android, ['--features', 'parakeet-android'], 'lazysh-parakeet-runtime', 'features')).stdout).toContain('lazysh-parakeet-runtime feature "native"');
});
