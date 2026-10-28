import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exactlyOne, native, plist } from './release-platform';

export const iosBundleIds = ['app.lazysh.client', 'app.lazysh.client.liveactivity',
  'app.lazysh.client.watchkitapp', 'app.lazysh.client.watchkitapp.widgets'] as const;
function requireApple(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Apple release: ${message}`);
}
export function signingProfiles(value: unknown): Record<string, string> {
  requireApple(value && typeof value === 'object' && !Array.isArray(value), 'profile mapping required');
  const profiles = value as Record<string, string>;
  requireApple(Object.keys(profiles).sort().join(',') === [...iosBundleIds].sort().join(','), 'all four bundle profiles required');
  for (const id of iosBundleIds) {
    const encoded = profiles[id];
    requireApple(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 524_288
      && Buffer.from(encoded, 'base64').toString('base64') === encoded, 'bounded canonical profile encoding required');
  }
  return profiles;
}
type ProfileIntent = { destination: string; device: string; inode: string };
export type OwnedSigning = { keychain: string; previous: string; profiles: ProfileIntent[] };
async function saveOwned(directory: string, owned: OwnedSigning) {
  const temporary = join(directory, 'owned.next.json');
  await writeFile(temporary, JSON.stringify(owned), { mode: 0o600 });
  await rename(temporary, join(directory, 'owned.json'));
}
export async function installOwnedProfile(directory: string, source: string, destination: string, owned: OwnedSigning,
  create = link, persist = saveOwned) {
  const original = await lstat(source, { bigint: true });
  requireApple(original.isFile() && !original.isSymbolicLink(), 'owned profile must be a regular private file');
  await chmod(source, 0o600);
  // Record verifiable inode ownership before an exclusive operation whose reply
  // can be lost. An EEXIST destination is never owned merely because of intent.
  owned.profiles.push({ destination, device: String(original.dev), inode: String(original.ino) });
  await persist(directory, owned);
  try { await create(source, destination); }
  catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'EXDEV'
      ? 'Apple release: profile installation requires one filesystem; no copy fallback'
      : 'Apple release: profile installation failed or uncertain; owned cleanup required');
  }
}
async function prepare(directory: string) {
  requireApple(process.platform === 'darwin', 'macOS signing host required');
  const names = ['IOS_CERTIFICATE_BASE64', 'IOS_CERTIFICATE_PASSWORD', 'IOS_PROFILES_BASE64_JSON', 'APPLE_DEVELOPMENT_TEAM'];
  const missing = names.filter(name => !process.env[name]);
  requireApple(missing.length === 0, `unavailable installation signing; missing ${missing.join(', ')}`);
  requireApple(process.env.IOS_PROFILES_BASE64_JSON!.length < 2_097_152, 'profile mapping too large');
  const profiles = signingProfiles(JSON.parse(process.env.IOS_PROFILES_BASE64_JSON!));
  const team = process.env.APPLE_DEVELOPMENT_TEAM!;
  requireApple(/^[A-Z0-9]{10}$/.exec(team)?.[0] === team, 'invalid Apple team');
  const certificate = process.env.IOS_CERTIFICATE_BASE64!;
  requireApple(certificate.length < 524_288 && Buffer.from(certificate, 'base64').toString('base64') === certificate,
    'bounded signing certificate required');
  await mkdir(directory, { mode: 0o700 });
  const owned: OwnedSigning = { keychain: join(directory, 'signing.keychain-db'),
    previous: (await native('/usr/bin/security', ['default-keychain', '-d', 'user'])).replace(/^"|"$/g, ''), profiles: [] };
  await saveOwned(directory, owned);
  const p12 = join(directory, 'certificate.p12');
  await Bun.write(p12, Buffer.from(certificate, 'base64'));
  const password = randomBytes(32).toString('hex');
  console.log(`::add-mask::${password}`);
  await native('/usr/bin/security', ['create-keychain', '-p', password, owned.keychain]);
  await native('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', owned.keychain]);
  await native('/usr/bin/security', ['unlock-keychain', '-p', password, owned.keychain]);
  await native('/usr/bin/security', ['import', p12, '-k', owned.keychain, '-P', process.env.IOS_CERTIFICATE_PASSWORD!,
    '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  await native('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, owned.keychain]);
  await native('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', owned.keychain]);
  const identities = await native('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', owned.keychain]);
  const matches = [...identities.matchAll(/\b([A-F0-9]{40})\s+"/g)];
  requireApple(matches.length === 1, 'exactly one valid signing identity required');
  const destination = join(homedir(), 'Library/MobileDevice/Provisioning Profiles');
  await mkdir(destination, { recursive: true });
  const mapping: Record<string, string> = {};
  for (const id of iosBundleIds) {
    const profile = join(directory, `${id}.mobileprovision`);
    await Bun.write(profile, Buffer.from(profiles[id], 'base64'));
    const decoded = join(directory, 'decoded.plist');
    await Bun.write(decoded, await native('/usr/bin/security', ['cms', '-D', '-i', profile]));
    requireApple(await plist(decoded, 'Entitlements.application-identifier') === `${team}.${id}`
      && Date.parse(await plist(decoded, 'ExpirationDate')) > Date.now(), 'profile identity or expiry mismatch');
    requireApple(await plist(decoded, 'Entitlements.get-task-allow') === 'false', 'release profile required');
    await native('/usr/bin/plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', decoded]);
    const uuid = await plist(decoded, 'UUID');
    requireApple(/^[A-Fa-f0-9-]{36}$/.exec(uuid)?.[0] === uuid, 'invalid profile UUID');
    const installed = join(destination, `${uuid}.mobileprovision`);
    requireApple(!await stat(installed).then(() => true, () => false), 'refusing to replace pre-existing profile');
    await installOwnedProfile(directory, profile, installed, owned);
    mapping[id] = uuid;
  }
  const options = join(directory, 'ExportOptions.plist');
  await Bun.write(options, JSON.stringify({ method: 'release-testing', destination: 'export', teamID: team,
    signingStyle: 'manual', signingCertificate: matches[0][1], provisioningProfiles: mapping,
    manageAppVersionAndBuildNumber: false, stripSwiftSymbols: true }));
  await native('/usr/bin/plutil', ['-convert', 'xml1', options]);
}
export async function cleanup(directory: string, command = native) {
  const file = Bun.file(join(directory, 'owned.json'));
  if (!await file.exists()) return;
  const owned: OwnedSigning = await file.json();
  let first: string | undefined;
  const attempt = async (stage: string, action: () => Promise<unknown>) => {
    try { await action(); } catch { first ??= stage; }
  };
  if (owned.previous) await attempt('keychain restoration', () => command('/usr/bin/security',
    ['default-keychain', '-d', 'user', '-s', owned.previous]));
  for (const profile of owned.profiles) await attempt('profile ownership/removal', async () => {
    let actual;
    try { actual = await lstat(profile.destination, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // Revalidate immediately before unlink. Never follow/delete a foreign or
    // symlink replacement, even after an exclusive creation collision.
    requireApple(actual.isFile() && !actual.isSymbolicLink() && String(actual.dev) === profile.device
      && String(actual.ino) === profile.inode, 'profile is not the recorded owned inode');
    await unlink(profile.destination);
  });
  await attempt('keychain removal', async () => {
    let info;
    try { info = await lstat(owned.keychain); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    requireApple(info.isFile() && !info.isSymbolicLink(), 'owned keychain must not be a symlink');
    await command('/usr/bin/security', ['delete-keychain', owned.keychain]);
  });
  await attempt('private signing directory removal', () => rm(directory, { recursive: true, force: true }));
  if (first) throw new Error(`Apple release: cleanup failed at ${first}`);
}
if (import.meta.main) {
  const directory = process.env.RUNNER_TEMP && join(process.env.RUNNER_TEMP, 'lazysh-apple-signing');
  requireApple(directory, 'owned runner signing directory required');
  const command = process.argv[2];
  if (command === 'prepare') await prepare(directory);
  else if (command === 'cleanup') await cleanup(directory);
  else {
    requireApple(command === 'export', 'unknown signing command');
    const build = join(process.cwd(), 'apps/client/src-tauri/gen/apple/build');
    const archive = await exactlyOne('**/*.xcarchive', build);
    await native('/usr/bin/xcodebuild', ['-exportArchive', '-archivePath', archive,
      '-exportOptionsPlist', join(directory, 'ExportOptions.plist'), '-exportPath', join(build, 'release-installation')]);
  }
}
