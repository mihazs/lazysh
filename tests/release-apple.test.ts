import { expect, test } from 'bun:test';
import { link, lstat, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, installOwnedProfile, type OwnedSigning } from '../.changeset/release-apple';

type SigningFixture = { directory: string; owned: OwnedSigning; source: string; destination: string };
async function signingFixture(run: (fixture: SigningFixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-apple-cleanup-'));
  const directory = join(root, 'private');
  await mkdir(directory);
  const owned: OwnedSigning = { keychain: join(directory, 'signing.keychain-db'), previous: 'owned-previous-keychain', profiles: [] };
  const source = join(directory, 'source.mobileprovision');
  const destination = join(root, 'installed.mobileprovision');
  await Bun.write(source, 'owned profile fixture');
  await Bun.write(owned.keychain, 'owned keychain fixture');
  await Bun.write(join(directory, 'owned.json'), JSON.stringify(owned));
  try { await run({ directory, owned, source, destination }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('cleanup continues after restoration failure and exposes only a finite stage error', () => signingFixture(async ({ directory, owned, source, destination }) => {
  await installOwnedProfile(directory, source, destination, owned);
  const stages: string[] = [];
  const result = cleanup(directory, async (_command, args) => {
    stages.push(args[0]);
    if (args[0] === 'default-keychain') throw new Error('untrusted sensitive native stderr');
    return '';
  });
  await expect(result).rejects.toThrow('Apple release: cleanup failed at keychain restoration');
  expect(stages).toEqual(['default-keychain', 'delete-keychain']);
  expect(await Bun.file(destination).exists()).toBe(false);
  expect(await Bun.file(join(directory, 'owned.json')).exists()).toBe(false);
}));
test('lost profile creation acknowledgement is recoverable by verifiable ownership', () => signingFixture(async ({ directory, owned, source, destination }) => {
  await expect(installOwnedProfile(directory, source, destination, owned, async (from, to) => {
    await link(from, to);
    throw new Error('lost native acknowledgement');
  })).rejects.toThrow();
  await cleanup(directory, async () => '');
  expect(await Bun.file(destination).exists()).toBe(false);
}));
test('exclusive collision preserves a foreign pre-existing profile through cleanup', () => signingFixture(async ({ directory, owned, source, destination }) => {
  await Bun.write(destination, 'foreign pre-existing profile');
  await expect(installOwnedProfile(directory, source, destination, owned)).rejects.toThrow('uncertain');
  const commands: string[] = [];
  await expect(cleanup(directory, async (_command, args) => { commands.push(args[0]); return ''; }))
    .rejects.toThrow('profile ownership/removal');
  expect(await Bun.file(destination).text()).toBe('foreign pre-existing profile');
  expect(commands).toEqual(['default-keychain', 'delete-keychain']);
  expect(await Bun.file(join(directory, 'owned.json')).exists()).toBe(false);
}));
test.each([false, true])('foreign inode or symlink replacement is not unlinked: symlink=%s', symbolic => signingFixture(async ({ directory, owned, source, destination }) => {
  await installOwnedProfile(directory, source, destination, owned);
  await unlink(destination);
  if (symbolic) await symlink(source, destination);
  else await Bun.write(destination, 'foreign replacement');
  await expect(cleanup(directory, async () => '')).rejects.toThrow('profile ownership/removal');
  expect((await lstat(destination)).isSymbolicLink()).toBe(symbolic);
  if (!symbolic) expect(await Bun.file(destination).text()).toBe('foreign replacement');
}));
test('journal failure creates no untracked installation and cross-filesystem failure has no copy fallback', () => signingFixture(async ({ directory, owned, source, destination }) => {
  let creations = 0;
  await expect(installOwnedProfile(directory, source, destination, owned, async () => { creations++; }, async () => {
    throw new Error('owned journal write failed');
  })).rejects.toThrow('journal');
  expect(creations).toBe(0);
  expect(await Bun.file(destination).exists()).toBe(false);
  await expect(installOwnedProfile(directory, source, destination, owned, async () => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  })).rejects.toThrow('one filesystem; no copy fallback');
  expect(await Bun.file(destination).exists()).toBe(false);
  await cleanup(directory, async () => '');
}));
test.each([false, true])('all known cleanup stages run when native keychain removal fails: restoreFails=%s', restoreFails => signingFixture(async ({ directory, owned, source, destination }) => {
  await installOwnedProfile(directory, source, destination, owned);
  const commands: string[] = [];
  await expect(cleanup(directory, async (_command, args) => {
    commands.push(args[0]);
    if (restoreFails || args[0] === 'delete-keychain') throw new Error('private native detail');
    return '';
  })).rejects.toThrow(restoreFails ? 'keychain restoration' : 'keychain removal');
  expect(commands).toEqual(['default-keychain', 'delete-keychain']);
  expect(await Bun.file(destination).exists()).toBe(false);
  expect(await Bun.file(join(directory, 'owned.json')).exists()).toBe(false);
}));
