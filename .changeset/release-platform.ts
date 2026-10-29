import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { windowsInstalledGuiScript, windowsInstallerPathsScript } from './windows-installed-gui';
import { artifactTargets, buildIdentity, digestFile, stagePackages, type ArtifactTarget } from './release-artifacts';

const execute = promisify(execFile);
export async function native(command: string, args: string[], env = process.env, timeout = 180_000, input?: string) {
  try {
    if (input !== undefined && Buffer.byteLength(input) > 65_536) throw new Error('Native fixture input exceeds its bound');
    const pending = execute(command, args, { env, timeout, maxBuffer: 2_097_152 });
    const supplied = input === undefined ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      pending.child.stdin!.once('error', reject);
      pending.child.stdin!.end(input, resolve);
    });
    const [result, written] = await Promise.allSettled([pending, supplied]);
    if (result.status === 'rejected') throw result.reason;
    if (written.status === 'rejected') throw written.reason;
    return result.value.stdout.trim();
  } catch (error) {
    // Native tools may print signing material or provisioning contents on failure.
    const tool = command.split(/[\\/]/).at(-1);
    const label = tool === 'pwsh.exe' ? windowsInstallerFailure((error as {stdout?: unknown}).stdout) : undefined;
    throw new Error(`Release validation failed: ${tool}${label ? ` (${label})` : ''}`);
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
const windowsInstallerGuards = new Set([
  'REPARSE_POINT', 'INSTALLER_TIMEOUT', 'INSTALLER_EXIT', 'PROCESS_TREE',
  'MISSING_BINARY', 'BINARY_MISMATCH', 'VERSION_MISMATCH', 'PROCESS_ARCHITECTURE',
  'EXISTING_PATH', 'EXISTING_REGISTRY', 'EXISTING_AUTOSTART', 'EXISTING_MSI',
  'WEBVIEW2_REQUIRED', 'UNEXPECTED_DATA', 'REPAIR_MARKER', 'MISSING_UNINSTALLER',
  'INSTALL_OWNERSHIP', 'UNINSTALL_OWNERSHIP', 'UNINSTALL_BINARY', 'UNINSTALL_REGISTRY',
  'REGISTRY_VALUES', 'REGISTRY_CHILDREN', 'UNINSTALL_MARKER', 'DATA_CONTENTS',
  'LOCAL_DATA', 'INSTALL_CONTENTS', 'SOURCE_HASH_MISMATCH', 'UNEXPECTED',
  'UNSUPPORTED_SIGNING', 'GUI_OWNER', 'GUI_START', 'GUI_INTERACTIVE', 'GUI_TOOLS', 'GUI_RUNTIME',
  'GUI_DATA', 'GUI_SESSION', 'GUI_FRONTEND', 'GUI_VERSION', 'GUI_ENDPOINT', 'GUI_TIMEOUT', 'GUI_CLIENT', 'GUI_CLEANUP',
]);
export function windowsInstallerFailure(stdout: unknown): string | undefined {
  if (typeof stdout !== 'string' || stdout.length > 2_097_152) return;
  const markers = stdout.split(/\r?\n/).filter(line => line.startsWith('LAZYSH_WINDOWS_INSTALLER:'));
  if (!markers.length || markers.length > 3) return;
  const labels: string[] = [];
  for (const marker of markers) {
    const match = /^LAZYSH_WINDOWS_INSTALLER:(preflight|paths|registry|webview|identity|install|repair|gui|cleanup):([A-Z_]+)$/.exec(marker);
    if (!match || !windowsInstallerGuards.has(match[2])) return;
    labels.push(`${match[1]}:${match[2]}`);
  }
  return labels.join('; ');
}
export async function windowsNsisBinaryDigest(path: string, source: { bytes: number; sha256: string }) {
  requirePlatform(Number.isSafeInteger(source.bytes) && source.bytes > 0 && source.bytes <= 2_147_483_648
    && /^[a-f0-9]{64}$/.exec(source.sha256)?.[0] === source.sha256, 'invalid Windows NSIS source identity');
  // Tauri CLI 2.12.4 patches this one constant before NSIS bundling, then restores the raw binary.
  const original = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const packaged = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const raw = createHash('sha256'), predicted = createHash('sha256');
  let tail = Buffer.alloc(0), bytes = 0, markers = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65_536 })) {
    bytes += chunk.length;
    requirePlatform(bytes <= source.bytes, 'Windows NSIS source identity mismatch');
    raw.update(chunk);
    const data = Buffer.concat([tail, chunk]);
    const limit = Math.max(0, data.length - original.length + 1);
    let offset = 0;
    for (let index = data.indexOf(original); index >= 0; index = data.indexOf(original, offset)) {
      requirePlatform(++markers === 1, 'unsupported Windows NSIS bundle marker');
      predicted.update(data.subarray(offset, index));
      predicted.update(packaged);
      offset = index + original.length;
    }
    const consumed = Math.max(offset, limit);
    predicted.update(data.subarray(offset, consumed));
    tail = Buffer.from(data.subarray(consumed));
  }
  requirePlatform(bytes === source.bytes && raw.digest('hex') === source.sha256, 'Windows NSIS source identity mismatch');
  requirePlatform(markers === 1, 'unsupported Windows NSIS bundle marker');
  predicted.update(tail);
  return { bytes, sha256: predicted.digest('hex') };
}
export async function windowsInstallation(installer: string, binary: string, version: string, gui = false) {
  requirePlatform(!gui || process.env.LAZYSH_TEST_WINDOWS_GUI === '1', 'Windows GUI acceptance must be explicitly selected');
  requirePlatform(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_TEMP,
  'Windows installation requires an owned GitHub-hosted Windows job');
  const expected = await digestFile(binary);
  await digestFile(installer);
  const cli = Bun.resolveSync('@tauri-apps/cli/package.json', resolve(import.meta.dir, '../apps/client'));
  requirePlatform((await Bun.file(cli).json()).version === '2.12.4',
    'Windows NSIS image model requires pinned Tauri CLI 2.12.4');
  const packaged = await windowsNsisBinaryDigest(binary, expected);
  if (gui) {
    const driver = resolve(process.env.LAZYSH_GUI_DRIVER ?? '');
    requirePlatform(driver.startsWith(resolve(process.env.RUNNER_TEMP!) + '\\'), 'Windows GUI tools must be task-owned');
    const receipt = Bun.file(join(driver, '../../.crates2.json'));
    requirePlatform(receipt.size <= 65_536, 'Windows GUI driver receipt exceeds its bound');
    const installed = (await receipt.json()).installs?.['tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)'];
    requirePlatform(installed?.version_req === '=2.1.0' && installed.bins?.includes('tauri-driver'), 'Windows GUI requires pinned tauri-driver 2.1.0');
  }
  const root = resolve(import.meta.dir, '..');
  return native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
${windowsInstallerPathsScript}
function RunInstaller($file, $arguments) {
  Plain $file
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  try {
    Require ($process.WaitForExit(120000)) 'INSTALLER_TIMEOUT'
    Require ($process.ExitCode -eq 0) 'INSTALLER_EXIT'
  } finally {
    if (!$process.HasExited) { $process.Kill($true); Require ($process.WaitForExit(10000)) 'PROCESS_TREE' }
    $process.Dispose()
  }
}
function Installed {
  Plain $installed
  Require (Test-Path -LiteralPath $installed -PathType Leaf) 'MISSING_BINARY'
  Require ((Get-Item -LiteralPath $installed).Length -eq [long]$env:LAZYSH_BINARY_BYTES -and (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -eq $env:LAZYSH_NSIS_BINARY_SHA256) 'BINARY_MISMATCH'
  Require ((Get-AuthenticodeSignature -LiteralPath $installed).Status -eq 'NotSigned') 'UNSUPPORTED_SIGNING'
  Require ((Get-Item -LiteralPath $installed).VersionInfo.ProductVersion -in @($env:LAZYSH_VERSION, ($env:LAZYSH_VERSION + '.0'))) 'VERSION_MISMATCH'
}
${windowsInstalledGuiScript}
$stage = 'preflight'
$failure = 'UNEXPECTED'
try {
Require ([Environment]::Is64BitProcess) 'PROCESS_ARCHITECTURE'
if ($env:LAZYSH_TEST_WINDOWS_GUI -eq '1') {
  Require (@(Get-Process -Name lazysh -ErrorAction SilentlyContinue).Count -eq 0) 'EXISTING_PATH'
  # Pinned single-instance 2.5.4 uses this identifier without its optional semver feature.
  $singleton = $null
  $existingSingleton = [Threading.Mutex]::TryOpenExisting('app.lazysh.client-sim', [ref]$singleton)
  if ($singleton) { $singleton.Dispose() }
  Require (!$existingSingleton) 'EXISTING_PATH'
}
$stage = 'paths'
$roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'app.lazysh.client'
$local = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'app.lazysh.client'
$manufacturer = 'HKCU:\Software\lazysh\lazysh'
$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\lazysh'
$protocol = 'HKCU:\Software\Classes\lazysh'
$paths = @($roaming, $local,
  (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lazysh'),
  (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'lazysh.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'lazysh.lnk'))
foreach ($path in $paths) { Plain $path; Require (!(OptionalItem $path)) 'EXISTING_PATH' }
$stage = 'registry'
foreach ($key in @($manufacturer, $uninstall, $protocol, 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\lazysh')) {
  Require (!(Test-Path -LiteralPath $key)) 'EXISTING_REGISTRY'
}
$autostart = OptionalItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Require (!$autostart -or 'lazysh' -notin $autostart.GetValueNames()) 'EXISTING_AUTOSTART'
$wix = foreach ($table in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path -LiteralPath $table) {
    Get-ItemProperty -Path ($table + '\*') | Where-Object { $_.DisplayName -eq 'lazysh' }
  }
}
Require (!$wix) 'EXISTING_MSI'
$stage = 'webview'
$webview = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$runtime = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\') |
  ForEach-Object { $key = OptionalItem ($_ + $webview); if ($key) { $key.GetValue('pv') } } |
  Where-Object { $_ } | Select-Object -First 1
$runtimeVersion = $null
Require ($runtime -match '^\d+\.\d+\.\d+\.\d+$' -and [Version]::TryParse([string]$runtime, [ref]$runtimeVersion) -and $runtimeVersion -gt [Version]'0.0.0.0') 'WEBVIEW2_REQUIRED'
foreach ($path in @($env:RUNNER_TEMP, $env:LAZYSH_INSTALLER, $env:LAZYSH_BINARY)) { Plain $path }
$stage = 'identity'
foreach ($file in @($env:LAZYSH_BINARY, $env:LAZYSH_INSTALLER)) {
  Require ((Get-Item -LiteralPath $file).VersionInfo.ProductVersion -in @($env:LAZYSH_VERSION, ($env:LAZYSH_VERSION + '.0'))) 'VERSION_MISMATCH'
  Require ((Get-AuthenticodeSignature -LiteralPath $file).Status -eq 'NotSigned') 'UNSUPPORTED_SIGNING'
}
Require ((Get-FileHash -LiteralPath $env:LAZYSH_BINARY -Algorithm SHA256).Hash -eq $env:LAZYSH_BINARY_SHA256) 'SOURCE_HASH_MISMATCH'
$directory = Join-Path $env:RUNNER_TEMP ('lazysh-nsis-' + [Guid]::NewGuid().ToString('N'))
$installed = Join-Path $directory 'lazysh.exe'
$uninstaller = Join-Path $directory 'uninstall.exe'
$marker = Join-Path $roaming ('installer-acceptance-' + [Guid]::NewGuid().ToString('N'))
$content = [Guid]::NewGuid().ToString('N')
$directoryOwned = $false
$dataOwned = $false
$primaryFailed = $false
try {
  $stage = 'install'
  $null = New-Item -ItemType Directory -Path $directory
  $directoryOwned = $true
  RunInstaller $env:LAZYSH_INSTALLER ('/S /NS /D=' + $directory)
  Installed
  if ($env:LAZYSH_TEST_WINDOWS_GUI -eq '1') { ExerciseInstalledGui }
  Plain $roaming
  Require (!(OptionalItem $roaming)) 'UNEXPECTED_DATA'
  $null = New-Item -ItemType Directory -Path $roaming
  $dataOwned = $true
  $null = New-Item -ItemType File -Path $marker -Value $content
  Remove-Item -LiteralPath $installed
  $stage = 'repair'
  RunInstaller $env:LAZYSH_INSTALLER ('/S /NS /D=' + $directory)
  Installed
  Plain $marker
  Require ((Get-Content -Raw -LiteralPath $marker) -ceq $content) 'REPAIR_MARKER'
} catch {
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:' + $stage + ':' + $failure)
  $primaryFailed = $true
} finally {
  $stage = 'cleanup'
  $failure = 'UNEXPECTED'
  if ($directoryOwned) {
    Plain $directory
    Require (Test-Path -LiteralPath $uninstaller -PathType Leaf) 'MISSING_UNINSTALLER'
    Require ((Get-Item -LiteralPath $manufacturer).GetValue('') -eq $directory) 'INSTALL_OWNERSHIP'
    $registration = Get-ItemProperty -LiteralPath $uninstall
    Require ($registration.InstallLocation -eq ('"' + $directory + '"') -and $registration.UninstallString -eq ('"' + $uninstaller + '"')) 'UNINSTALL_OWNERSHIP'
    RunInstaller $uninstaller ('/S _?=' + $directory)
    Require (!(Test-Path -LiteralPath $installed)) 'UNINSTALL_BINARY'
    foreach ($key in @($uninstall, $protocol)) { Require (!(Test-Path -LiteralPath $key)) 'UNINSTALL_REGISTRY' }
    if (Test-Path -LiteralPath $manufacturer) {
      $installKey = Get-Item -LiteralPath $manufacturer
      Require ($installKey.GetValue('') -eq $directory) 'INSTALL_OWNERSHIP'
      Require (@($installKey.GetValueNames() | Where-Object { $_ -notin @('', 'Installer Language') }).Count -eq 0) 'REGISTRY_VALUES'
      Require (@(Get-ChildItem -LiteralPath $manufacturer).Count -eq 0) 'REGISTRY_CHILDREN'
      Remove-Item -LiteralPath $manufacturer
    }
    if ($dataOwned) {
      Plain $marker
      Require ((Get-Content -Raw -LiteralPath $marker) -ceq $content) 'UNINSTALL_MARKER'
      Require (@(Get-ChildItem -Force -LiteralPath $roaming).Count -eq 1) 'DATA_CONTENTS'
      Remove-Item -LiteralPath $marker
      [IO.Directory]::Delete($roaming)
    }
    Require (!(Test-Path -LiteralPath $local)) 'LOCAL_DATA'
    foreach ($file in @(Get-ChildItem -Force -LiteralPath $directory)) {
      Require (!$file.PSIsContainer -and $file.Name -eq 'uninstall.exe') 'INSTALL_CONTENTS'
      Plain $file.FullName
      Remove-Item -LiteralPath $file.FullName
    }
    [IO.Directory]::Delete($directory)
  }
}
if ($primaryFailed) { exit 1 }
} catch {
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:' + $stage + ':' + $failure)
  exit 1
}
'Windows NSIS install, same-version repair, marker preservation and uninstall passed'
`], { ...process.env, LAZYSH_INSTALLER: resolve(installer), LAZYSH_BINARY: resolve(binary),
    LAZYSH_VERSION: version, LAZYSH_BINARY_SHA256: expected.sha256, LAZYSH_BINARY_BYTES: String(expected.bytes),
    LAZYSH_NSIS_BINARY_SHA256: packaged.sha256, LAZYSH_TEST_WINDOWS_GUI: gui ? '1' : '',
    LAZYSH_GUI_NODE: gui ? await native('node', ['-p', 'process.execPath']) : '',
    LAZYSH_GUI_VITEST: join(root, 'node_modules/vitest/vitest.mjs'),
    LAZYSH_GUI_CLIENT_ROOT: join(root, 'apps/client'),
  }, gui ? 600_000 : 450_000);
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
    console.info(await windowsInstallation(installer, join(root, 'target/release/lazysh.exe'), identity.version));
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
