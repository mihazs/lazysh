import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { artifactTargets, buildIdentity, stagePackages, type ArtifactTarget } from './release-artifacts';

const execute = promisify(execFile);
export async function native(command: string, args: string[], env = process.env) {
  try {
    const result = await execute(command, args, { env, timeout: 180_000, maxBuffer: 2_097_152 });
    return result.stdout.trim();
  } catch {
    // Native tools may print signing material or provisioning contents on failure.
    throw new Error(`Release validation failed: ${command.split(/[\\/]/).at(-1)}`);
  }
}
function requirePlatform(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Release platform: ${message}`);
}
export async function exactlyOne(pattern: string, cwd: string) {
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd, onlyFiles: false, followSymlinks: false }));
  requirePlatform(files.length === 1, `expected exactly one ${pattern}`);
  return join(cwd, files[0]);
}
export const plist = (path: string, key: string) => native('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path]);
async function appleApp(path: string, version: string, id: string) {
  const info = join(path, 'Info.plist');
  requirePlatform(await plist(info, 'CFBundleIdentifier') === id
    && await plist(info, 'CFBundleShortVersionString') === version, 'Apple identity/version mismatch');
  await native('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
}
async function desktop(target: ArtifactTarget, root: string, output: string) {
  const identity = await buildIdentity(root);
  requirePlatform(['linux-x64', 'windows-x64', 'macos-arm64', 'macos-x64'].includes(target), 'unsupported desktop target');
  const bundle = join(root, 'target/release/bundle');
  const sources: string[] = [];
  let signing: 'unsigned' | 'ad-hoc' = 'unsigned';
  if (target === 'linux-x64') {
    const deb = await exactlyOne('deb/*.deb', bundle);
    requirePlatform(await native('dpkg-deb', ['--field', deb, 'Version']) === identity.version, 'Debian version mismatch');
    requirePlatform(await native('dpkg-deb', ['--field', deb, 'Architecture']) === 'amd64', 'Debian architecture mismatch');
    sources.push(deb, await exactlyOne('appimage/*.AppImage', bundle));
  } else if (target === 'windows-x64') {
    const installer = await exactlyOne('nsis/*.exe', bundle);
    const version = await native('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Item -LiteralPath $env:LAZYSH_INSTALLER).VersionInfo.ProductVersion'],
    { ...process.env, LAZYSH_INSTALLER: installer });
    requirePlatform([identity.version, `${identity.version}.0`].includes(version), 'Windows installer version mismatch');
    sources.push(installer);
  } else {
    const app = await exactlyOne('macos/*.app', bundle);
    const info = join(app, 'Contents/Info.plist');
    requirePlatform(await plist(info, 'CFBundleIdentifier') === 'app.lazysh.client'
      && await plist(info, 'CFBundleShortVersionString') === identity.version, 'macOS identity/version mismatch');
    await native('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const dmg = await exactlyOne('dmg/*.dmg', bundle);
    const mount = await mkdtemp(join(process.env.RUNNER_TEMP!, 'lazysh-dmg-'));
    let attached = false;
    try {
      await native('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
      attached = true;
      const packaged = await exactlyOne('*.app', mount);
      requirePlatform(await plist(join(packaged, 'Contents/Info.plist'), 'CFBundleShortVersionString') === identity.version
        && await plist(join(packaged, 'Contents/Info.plist'), 'CFBundleIdentifier') === 'app.lazysh.client', 'DMG identity mismatch');
      await native('/usr/bin/codesign', ['--verify', '--deep', '--strict', packaged]);
    } finally {
      if (attached) await native('/usr/bin/hdiutil', ['detach', mount]);
      await rm(mount, { recursive: true });
    }
    const archive = join(process.env.RUNNER_TEMP!, 'lazysh.app.zip');
    await native('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    sources.push(dmg, archive);
    signing = 'ad-hoc';
  }
  return stagePackages(identity, target, signing, sources, output);
}
async function android(target: ArtifactTarget, root: string, output: string) {
  const identity = await buildIdentity(root);
  requirePlatform(target === 'android-google-arm64' || target === 'android-foss-arm64', 'unsupported Android target');
  const sdk = process.env.ANDROID_HOME;
  const fingerprint = process.env.ANDROID_SIGNER_SHA256;
  requirePlatform(sdk && fingerprint && /^[a-fA-F0-9]{64}$/.exec(fingerprint)?.[0] === fingerprint,
    'reviewed Android certificate fingerprint required');
  const apk = await exactlyOne('*.apk', join(root,
    'apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/release'));
  const analyzer = join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
  const [major, minor, patch] = identity.version.split('.').map(Number);
  for (const [field, expected] of [
    ['application-id', 'app.lazysh.client'], ['version-name', identity.version],
    ['version-code', String(major * 1_000_000 + minor * 1_000 + patch)], ['debuggable', 'false'],
  ]) requirePlatform(await native(analyzer, ['manifest', field, apk]) === expected, `APK ${field} mismatch`);
  const signature = await native(join(sdk, 'build-tools/36.0.0/apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  const certificates = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$/gm)];
  requirePlatform(certificates.length === 1 && certificates[0][1].toLowerCase() === fingerprint.toLowerCase(),
    'APK certificate mismatch');
  return stagePackages(identity, target, 'signed', [apk], output);
}
async function ios(root: string, output: string) {
  const identity = await buildIdentity(root);
  const ipa = await exactlyOne('**/*.ipa', join(root, 'apps/client/src-tauri/gen/apple/build'));
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP!, 'lazysh-ipa-'));
  try {
    await native('/usr/bin/ditto', ['-x', '-k', ipa, directory]);
    const app = await exactlyOne('Payload/*.app', directory);
    const targets = [
      [app, 'app.lazysh.client'],
      [await exactlyOne('PlugIns/*.appex', app), 'app.lazysh.client.liveactivity'],
      [await exactlyOne('Watch/*.app', app), 'app.lazysh.client.watchkitapp'],
    ];
    targets.push([await exactlyOne('PlugIns/*.appex', targets[2][0]), 'app.lazysh.client.watchkitapp.widgets']);
    for (const [path, id] of targets) {
      await appleApp(path, identity.version, id);
      const profile = join(directory, 'profile.plist');
      const decoded = await native('/usr/bin/security', ['cms', '-D', '-i', join(path, 'embedded.mobileprovision')]);
      await Bun.write(profile, decoded);
      const team = process.env.APPLE_DEVELOPMENT_TEAM;
      requirePlatform(team && /^[A-Z0-9]{10}$/.exec(team)?.[0] === team, 'Apple team required');
      requirePlatform(await plist(profile, 'Entitlements.application-identifier') === `${team}.${id}`,
        'iOS provisioning identity mismatch');
      requirePlatform(Date.parse(await plist(profile, 'ExpirationDate')) > Date.now(), 'expired iOS profile');
      requirePlatform(await plist(profile, 'Entitlements.get-task-allow') === 'false', 'development profile is not a release');
      // release-testing is Ad Hoc: the exported file is only for registered devices.
      await native('/usr/bin/plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', profile]);
    }
    return stagePackages(identity, 'ios-arm64', 'signed', [ipa], output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const [target, output] = process.argv.slice(2);
  requirePlatform(Object.hasOwn(artifactTargets, target) && output && process.env.RUNNER_TEMP, 'target/output/temp required');
  const root = resolve('.');
  await mkdir(output, { recursive: true });
  if (target.startsWith('android-')) await android(target as ArtifactTarget, root, output);
  else if (target === 'ios-arm64') await ios(root, output);
  else await desktop(target as ArtifactTarget, root, output);
}
