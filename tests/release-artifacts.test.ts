import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePackages, artifactName, artifactTargets, releaseTargets, digestFile, stagePackages,
  validateReceipt, releaseNotes, type ArtifactTarget } from '../.changeset/release-artifacts';
import { signingProfiles, iosBundleIds } from '../.changeset/release-apple';
import { javaProperty } from '../.changeset/release-android';
import { publishInstallationSet } from '../.changeset/release-publish';
import { exactlyOne, native, windowsInstallation, windowsInstallerFailure, windowsNsisBinaryDigest } from '../.changeset/release-platform';
import { parseWindowsGuiOwner, windowsInstallerPathsScript, windowsInstalledGuiScript, isWindowsGuiDriverReceipt, windowsGuiToolEnvironment } from '../.changeset/windows-installed-gui';
import type { ReleasePolicy } from '../.changeset/release-tag';

const identity = { sha: 'a'.repeat(40), version: '0.22.0' };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-release-artifacts-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function platform(root: string, target: ArtifactTarget) {
  const sources: string[] = [];
  for (const extension of artifactTargets[target]) {
    const path = join(root, `${target}.${extension}`);
    await Bun.write(path, `owned unit fixture ${target} ${extension}`);
    sources.push(path);
  }
  return stagePackages(identity, target, target.startsWith('macos-') ? 'ad-hoc'
    : target.startsWith('linux-') || target.startsWith('windows-') ? 'unsigned' : 'signed',
  sources, join(root, 'incoming', `release-${target}`));
}
test('aggregation requires every platform and preserves exact bytes with checksums', () => fixture(async root => {
  for (const target of releaseTargets) await platform(root, target);
  const output = join(root, 'complete');
  await aggregatePackages(identity, join(root, 'incoming'), output);
  const manifest = await Bun.file(join(output, 'release.json')).json();
  expect(manifest.sha).toBe(identity.sha);
  expect(manifest.platforms).toHaveLength(releaseTargets.length);
  for (const receipt of manifest.platforms) for (const file of receipt.files) {
    expect(await Bun.file(join(output, file.name)).text()).toBe(
      await Bun.file(join(root, 'incoming', `release-${receipt.target}`, file.name)).text());
  }
  const lines = (await Bun.file(join(output, 'SHA256SUMS')).text()).trim().split('\n');
  expect(lines).toHaveLength(releaseTargets.reduce((count, target) => count + artifactTargets[target].length, 1));
  for (const line of lines) {
    const [hash, name] = line.split('  ');
    expect((await digestFile(join(output, name))).sha256).toBe(hash);
  }
}));
test('download tampering and missing platforms cannot become a release', () => fixture(async root => {
  for (const target of releaseTargets) await platform(root, target);
  const source = join(root, 'incoming');
  const file = join(source, 'release-android-foss-arm64', artifactName(identity, 'android-foss-arm64', 'apk'));
  await Bun.write(file, 'tampered');
  await expect(aggregatePackages(identity, source, join(root, 'bad'))).rejects.toThrow('digest mismatch');
  await rm(join(source, 'release-android-foss-arm64'), { recursive: true });
  await expect(aggregatePackages(identity, source, join(root, 'missing'))).rejects.toThrow('missing or unexpected');
}));
test('source substitutions, unsigned mobile, duplicate packages and path traversal fail closed', () => fixture(async root => {
  const receipt = await platform(root, 'android-google-arm64');
  for (const changed of [
    { ...receipt, sha: 'b'.repeat(40) }, { ...receipt, version: '0.23.0' },
    { ...receipt, signing: 'unsigned' }, { ...receipt, files: [...receipt.files, ...receipt.files] },
    { ...receipt, files: [{ ...receipt.files[0], name: '../private.apk' }] },
    { ...receipt, files: [{ ...receipt.files[0], bytes: 0 }] },
    { ...receipt, files: [{ ...receipt.files[0], sha256: 'x'.repeat(64) }] },
  ]) expect(() => validateReceipt(changed, identity)).toThrow('Release artifacts:');
  expect(() => artifactName({ ...identity, version: '0.22.0\n' }, 'ios-arm64', 'ipa')).toThrow();
}));
test('extra files and substituted receipt targets are rejected', () => fixture(async root => {
  for (const target of releaseTargets) await platform(root, target);
  const directory = join(root, 'incoming', 'release-linux-x64');
  await Bun.write(join(directory, 'private-key'), 'not a release asset');
  await expect(aggregatePackages(identity, join(root, 'incoming'), join(root, 'extra'))).rejects.toThrow('unexpected package');
  await rm(join(directory, 'private-key'));
  await Bun.write(join(directory, 'receipt.json'), JSON.stringify(await platform(root, 'windows-x64')));
  await expect(aggregatePackages(identity, join(root, 'incoming'), join(root, 'substituted'))).rejects.toThrow('substitution');
}));
test('deferred Apple artifacts cannot enter the automatic release set', () => fixture(async root => {
  for (const target of releaseTargets) await platform(root, target);
  await platform(root, 'ios-arm64');
  await expect(aggregatePackages(identity, join(root, 'incoming'), join(root, 'output'))).rejects.toThrow('unexpected platform');
}));
test('linked, empty and missing native outputs cannot be staged', () => fixture(async root => {
  const source = join(root, 'source');
  const linked = join(root, 'linked');
  await Bun.write(source, 'owned fixture');
  await symlink(source, linked);
  for (const path of [linked, join(root, 'missing')]) await expect(digestFile(path)).rejects.toThrow();
  await Bun.write(source, '');
  await expect(digestFile(source)).rejects.toThrow('missing, linked or oversized');
  await mkdir(join(root, 'directory'));
  await expect(digestFile(join(root, 'directory'))).rejects.toThrow('missing, linked or oversized');
}));

test('Java signing properties preserve separators, whitespace, controls and surrogate pairs', () => {
  const original = ' 🔐=a:b\\c\n\r\t#! é ';
  const encoded = javaProperty(original);
  expect(encoded).not.toMatch(/[\r\n]/);
  expect(encoded.replace(/\\u([0-9a-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).toBe(original);
  expect(encoded).toContain('\\ud83d\\udd10');
});
test('Apple export requires exactly four bounded canonical profile encodings', () => {
  const valid = Object.fromEntries(iosBundleIds.map(id => [id, Buffer.from(id).toString('base64')]));
  expect(signingProfiles(valid)).toEqual(valid);
  for (const value of [null, [], {}, { ...valid, extra: 'aA==' }, { ...valid, [iosBundleIds[0]]: 'aA==\n' },
    { ...valid, [iosBundleIds[0]]: 'a'.repeat(524_292) }]) expect(() => signingProfiles(value)).toThrow();
});

const policy: ReleasePolicy = await Bun.file(new URL('../.changeset/release-policy.json', import.meta.url)).json();
const next = { ...identity, tag: `v${identity.version}`, versionCode: 22_000 };
async function installationSet(root: string) {
  for (const target of releaseTargets) await platform(root, target);
  const destination = join(root, 'installation-set');
  await mkdir(destination);
  for (const name of ['release-notes.md', 'INSTALL-AND-UPDATE.md']) await Bun.write(join(destination, name), `owned ${name}`);
  await aggregatePackages(identity, join(root, 'incoming'), destination);
  return destination;
}
async function publication(root: string, failure?: string, enabled = true) {
  const directory = await installationSet(root);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let tagReads = 0;
  const request = async (path: string, method: string, body?: unknown) => {
    calls.push({ path, method, body });
    if (path === 'git/ref/heads/main') return Response.json({ object: { sha: identity.sha } });
    if (path === `git/ref/tags/${next.tag}`) return Response.json({ ref: `refs/tags/${next.tag}`,
      object: { type: 'commit', sha: failure === 'tag' || failure === 'changed-tag' && tagReads++ > 0 ? 'b'.repeat(40) : identity.sha } });
    if (path === `releases/tags/${next.tag}`) return Response.json({}, { status: failure === 'existing' ? 200 : 404 });
    if (path === 'releases') return Response.json({ id: 8, draft: true, tag_name: next.tag }, { status: 201 });
    if (method === 'UPLOAD') {
      if (failure === 'upload') return Response.json({}, { status: 500 });
      const file = body as Blob;
      const hash = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
      return Response.json({ name: new URL(`https://uploads.github.com/${path}`).searchParams.get('name'),
        state: 'uploaded', size: file.size, digest: `sha256:${failure === 'digest' ? '0'.repeat(64) : hash}` }, { status: 201 });
    }
    if (method === 'PATCH') return Response.json({ id: 8, draft: false, tag_name: next.tag });
    throw new Error('Unexpected fixture API call');
  };
  const result = publishInstallationSet(next, enabled ? { ...policy, enabled: true, fossPushAccepted: true,
    officialSubmissionPrerequisitesAccepted: true } : { ...policy, enabled: false }, directory, request, async sha => {
    expect(sha).toBe(identity.sha);
    if (failure === 'main') throw new Error('superseded');
  });
  return { calls, result };
}
test('initial notes include current development changes and explicit native limits without backfill', () => fixture(async root => {
  await mkdir(join(root, 'apps/client'), { recursive: true });
  await mkdir(join(root, '.changeset'));
  await mkdir(join(root, 'docs'));
  await Bun.write(join(root, 'docs/install-and-update.md'), '# Install\n\n## Current native acceptance status\n\nNative gaps #352 #344 #379 #306 #459 #457 #458; same-version repair does not establish full parity.\n\n## Historical status\n\nOld native status.\n');
  await Bun.write(join(root, '.changeset/release-policy.json'), JSON.stringify(policy));
  await Bun.write(join(root, 'apps/client/CHANGELOG.md'), '# Client\n\n## 0.23.0\n\nPrepared release.\n\n## 0.22.0\n\nHistorical release.\n');
  await Bun.write(join(root, 'CHANGELOG.md'), '# Changes\n\n## [Unreleased]\n\nCurrent source change.\n\n## [0.22.0]\n\nOld source change.\n');
  const initial = await releaseNotes(root, '0.23.0', true);
  for (const text of ['Prepared release.', 'Current source change.', '#352', '#344', '#379', '#306', '#459', '#457', '#458', 'does not establish full', 'same-version repair']) {
    expect(initial).toContain(text);
  }
  expect(initial).not.toContain('Historical release.');
  expect(initial).not.toContain('Old source change.');
  const ordinary = await releaseNotes(root, '0.23.0');
  expect(ordinary).not.toContain('Current source change.');
  expect(ordinary).toContain('Native gaps #352 #344 #379 #306 #459 #457 #458');
  expect(ordinary).not.toContain('Old native status.');
  expect(initial).not.toContain('Old native status.');
  await expect(releaseNotes(root, '0.22.0', true)).rejects.toThrow('not allowlisted');
  await Bun.write(join(root, 'CHANGELOG.md'), '# Empty');
  await expect(releaseNotes(root, '0.23.0', true)).rejects.toThrow('development changes');
  for (const status of ['# Missing', '## Current native acceptance status\n\n## Next\nEmpty',
    '## Current native acceptance status\nOne\n## Current native acceptance status\nTwo']) {
    await Bun.write(join(root, 'docs/install-and-update.md'), status);
    await expect(releaseNotes(root, '0.23.0')).rejects.toThrow('native acceptance status');
  }
}));

test('publication uploads a complete digest-acknowledged draft before making it public', () => fixture(async root => {
  const { calls, result } = await publication(root);
  await result;
  const uploads = calls.filter(call => call.method === 'UPLOAD');
  expect(uploads).toHaveLength(releaseTargets.reduce((count, target) => count + artifactTargets[target].length, 4));
  expect(calls.find(call => call.path === 'releases')?.body).toMatchObject({ draft: true, target_commitish: identity.sha });
  expect(calls.at(-1)).toEqual({ path: 'releases/8', method: 'PATCH', body: { draft: false, make_latest: 'legacy' } });
}));
test.each(['tag', 'changed-tag', 'existing', 'upload', 'digest', 'main'])(
  'uncertain or invalid release state cannot publish or overwrite: %s', failure => fixture(async root => {
    const { calls, result } = await publication(root, failure);
    await expect(result).rejects.toThrow();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(calls.every(call => !['DELETE', 'PUT'].includes(call.method))).toBe(true);
  }));
test('disabled policy rejects all publication APIs', () => fixture(async root => {
  const { calls, result } = await publication(root, undefined, false);
  await expect(result).rejects.toThrow('disabled');
  expect(calls).toEqual([]);
}));

const nativeWindows = process.env.LAZYSH_TEST_WINDOWS_INSTALLER === '1';
test.skipIf(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted')('installer acceptance refuses ambient local execution before reading installer files', async () => {
  await expect(windowsInstallation('missing-installer', 'missing-binary', '0.0.0'))
    .rejects.toThrow('owned GitHub-hosted Windows job');
});
test.skipIf(!nativeWindows)('actual Windows NSIS rejects wrong identity and preserves colliding data and junctions, then installs, repairs and uninstalls', async () => {
  const installer = await exactlyOne('nsis/*.exe', join(import.meta.dir, '../target/release/bundle'));
  const binary = join(import.meta.dir, '../target/release/lazysh.exe');
  const { version } = await Bun.file(join(import.meta.dir, '../apps/client/package.json')).json();
  await expect(windowsInstallation(installer, binary, '0.0.0')).rejects.toMatchObject({
    message: 'Release validation failed: pwsh.exe (identity:VERSION_MISMATCH)',
  });
  const data = join(process.env.APPDATA!, 'app.lazysh.client');
  for (const linked of [false, true]) await fixture(async root => {
    if (linked) await symlink(root, data, 'junction');
    else await mkdir(data);
    const marker = join(data, 'existing-data');
    try {
      await Bun.write(marker, 'preexisting application data must survive rejection');
      await expect(windowsInstallation(installer, binary, version)).rejects.toMatchObject({
        message: `Release validation failed: pwsh.exe (paths:${linked ? 'REPARSE_POINT' : 'EXISTING_PATH'})`,
      });
      expect(await Bun.file(marker).text()).toBe('preexisting application data must survive rejection');
    } finally {
      await rm(marker);
      if (linked) await unlink(data);
      else await rmdir(data);
    }
  });
  console.info(await windowsInstallation(installer, binary, version));
}, 500_000);

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows GUI endpoint roles admit only IPv4 plus owned IPv6 siblings', async () => {
  const script = windowsInstallerPathsScript + windowsInstalledGuiScript + String.raw`
$ErrorActionPreference = 'Stop'
$first = [PSCustomObject]@{LocalPort=12345;LocalAddress='127.0.0.1';OwningProcess=111}
$second = [PSCustomObject]@{LocalPort=12346;LocalAddress='127.0.0.1';OwningProcess=222}
$firstV6 = [PSCustomObject]@{LocalPort=12345;LocalAddress='::1';OwningProcess=111}
$secondV6 = [PSCustomObject]@{LocalPort=12346;LocalAddress='::1';OwningProcess=222}
$base = @($first, $second)
GuiEndpoints $base @(12345,12346) 111 222
GuiEndpoints @($first,$second,$secondV6) @(12345,12346) 111 222
GuiEndpoints @($first,$second,$firstV6,$secondV6) @(12345,12346) 111 222
$cases = @(
  @{Socket=[PSCustomObject]@{LocalPort=12346;LocalAddress='::1';OwningProcess=111};Code='GUI_ENDPOINT'},
  @{Socket=[PSCustomObject]@{LocalPort=12346;LocalAddress='::1';OwningProcess=333};Code='GUI_ENDPOINT'},
  @{Socket=[PSCustomObject]@{LocalPort=12346;LocalAddress='0.0.0.0';OwningProcess=222};Code='GUI_LISTENER_ADDRESS'},
  @{Socket=[PSCustomObject]@{LocalPort=12346;LocalAddress='::';OwningProcess=222};Code='GUI_LISTENER_ADDRESS'},
  @{Socket=[PSCustomObject]@{LocalPort=12346;LocalAddress='192.0.2.1';OwningProcess=222};Code='GUI_LISTENER_ADDRESS'},
  @{Socket=[PSCustomObject]@{LocalPort=12347;LocalAddress='127.0.0.1';OwningProcess=222};Code='GUI_LISTENER_ADDRESS'},
  @{Socket=$first;Code='GUI_ENDPOINT'}
)
foreach ($case in $cases) {
  $script:failure = 'UNEXPECTED'
  $rejected = $false
  try { GuiEndpoints ($base + $case.Socket) @(12345,12346) 111 222 } catch { $rejected = $true }
  if (!$rejected -or $script:failure -ne $case.Code) { throw 'endpoint negative accepted or rejected for wrong reason' }
}
$script:failure = 'UNEXPECTED'
$rejected = $false
try { GuiEndpoints @($first,$secondV6) @(12345,12346) 111 222 } catch { $rejected = $true }
if (!$rejected -or $script:failure -ne 'GUI_IPV4_REQUIRED') { throw 'missing IPv4 admitted' }
'owned GUI endpoint shapes passed'
`;
  expect(await native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.env, 30000)).toBe('owned GUI endpoint shapes passed');
});
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows installed GUI owns its bundled image and native window, then uninstalls', async () => {
  const installer = await exactlyOne('nsis/*.exe', join(import.meta.dir, '../target/release/bundle'));
  const binary = join(import.meta.dir, '../target/release/lazysh.exe');
  const { version } = await Bun.file(join(import.meta.dir, '../apps/client/package.json')).json();
  console.info(await windowsInstallation(installer, binary, version, true));
}, 650_000);
test('installed GUI refuses an implicit request before reading any files', async () => {
  const prior = process.env.LAZYSH_TEST_WINDOWS_GUI;
  delete process.env.LAZYSH_TEST_WINDOWS_GUI;
  try { await expect(windowsInstallation('missing', 'missing', '0.0.0', true)).rejects.toThrow('explicitly selected'); }
  finally { if (prior !== undefined) process.env.LAZYSH_TEST_WINDOWS_GUI = prior; }
});
test.skipIf(process.platform !== 'win32')('Windows GUI data cleanup refuses foreign sentinels and reparse descendants', () => fixture(async root => {
  const script = windowsInstallerPathsScript + windowsInstalledGuiScript + String.raw`
$ErrorActionPreference = 'Stop'
$guiSentinel = 'owned-sentinel'
$content = 'owned-content'
$script:guiRoots = @()
$owned = Join-Path $env:LAZYSH_GUI_FILE_FIXTURE 'owned'
GuiDirectory $owned
Set-Content -LiteralPath (Join-Path $owned $guiSentinel) -NoNewline -Value 'foreign'
try { RemoveGuiDirectory $owned; throw 'foreign sentinel accepted' } catch { if ($script:failure -ne 'GUI_DATA') { throw } }
if (!(Test-Path -LiteralPath $owned)) { throw 'foreign root removed' }
Set-Content -LiteralPath (Join-Path $owned $guiSentinel) -NoNewline -Value $content
$external = Join-Path $env:LAZYSH_GUI_FILE_FIXTURE 'external'
$null = New-Item -ItemType Directory -Path $external
$externalMarker = Join-Path $external 'preserved'
Set-Content -LiteralPath $externalMarker -NoNewline -Value 'outside'
$link = Join-Path $owned 'linked'
$null = New-Item -ItemType Junction -Path $link -Target $external
try { RemoveGuiDirectory $owned; throw 'junction accepted' } catch { if ($script:failure -ne 'REPARSE_POINT') { throw } }
if ((Get-Content -Raw -LiteralPath $externalMarker) -cne 'outside') { throw 'external data changed' }
[IO.Directory]::Delete($link)
RemoveGuiDirectory $owned
if (Test-Path -LiteralPath $owned) { throw 'owned root remains' }
'owned GUI file boundaries passed'
`;
  expect(await native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {...process.env, LAZYSH_GUI_FILE_FIXTURE: root}, 30000)).toBe('owned GUI file boundaries passed');
}));
test('Windows GUI tool environment normalizes both mixed-slash image identities', () => {
  expect(windowsGuiToolEnvironment(String.raw`D:\a\_temp/tools/bin/tauri-driver.exe`, String.raw`D:\a\_temp/tools/edge/msedgedriver.exe`)).toEqual({
    LAZYSH_GUI_DRIVER: String.raw`D:\a\_temp\tools\bin\tauri-driver.exe`,
    LAZYSH_GUI_EDGE: String.raw`D:\a\_temp\tools\edge\msedgedriver.exe`,
  });
  for (const path of ['relative.exe', '/ambient/tool.exe', 'D:relative.exe', 'D:\\tool\0.exe']) {
    expect(() => windowsGuiToolEnvironment(path, String.raw`D:\owned\msedgedriver.exe`)).toThrow();
    expect(() => windowsGuiToolEnvironment(String.raw`D:\owned\tauri-driver.exe`, path)).toThrow();
  }
});
test('pinned Windows driver receipt binds Cargo executable filenames including .exe', () => {
  const key = 'tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)';
  const installed = {version_req: '=2.1.0', bins: ['tauri-driver.exe']};
  expect(isWindowsGuiDriverReceipt({installs: {[key]: installed}})).toBe(true);
  for (const patch of [{bins: ['tauri-driver']}, {bins: 'tauri-driver.exe'}, {bins: []},
    {bins: ['other.exe']}, {bins: ['tauri-driver.exe', 'other.exe']}, {version_req: '=2.2.0'}]) {
    expect(isWindowsGuiDriverReceipt({installs: {[key]: {...installed, ...patch}}})).toBe(false);
  }
  for (const receipt of [null, {}, {installs: {'tauri-driver 2.2.0 (registry+https://github.com/rust-lang/crates.io-index)': installed}}]) {
    expect(isWindowsGuiDriverReceipt(receipt)).toBe(false);
  }
});
test('Windows GUI native identity parser admits only a complete exact image identity', () => {
  const owner = {pid: 123, start: '133811111111111111', window: '456', sha256: 'a'.repeat(64)};
  expect(parseWindowsGuiOwner(JSON.stringify(owner), owner.sha256)).toEqual(owner);
  for (const patch of [{pid:0}, {start:'0'}, {window:'-1'}, {sha256:'b'.repeat(64)}, {path:'private'}, {start:133}]) {
    expect(() => parseWindowsGuiOwner(JSON.stringify({...owner, ...patch}), owner.sha256)).toThrow();
  }
  expect(() => parseWindowsGuiOwner('private raw output',owner.sha256)).toThrow();
  expect(() => parseWindowsGuiOwner(' '.repeat(1025),owner.sha256)).toThrow();
  expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:GUI_OWNER\nLAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP\nLAZYSH_WINDOWS_INSTALLER:cleanup:UNINSTALL_BINARY'))
    .toBe('gui:GUI_OWNER; gui:GUI_CLEANUP; cleanup:UNINSTALL_BINARY');
});

test.each([
  ['private stdout\nLAZYSH_WINDOWS_INSTALLER:preflight:VERSION_MISMATCH\r\nprivate stderr', 'preflight:VERSION_MISMATCH'],
  ['LAZYSH_WINDOWS_INSTALLER:repair:REPAIR_MARKER\nLAZYSH_WINDOWS_INSTALLER:cleanup:UNINSTALL_OWNERSHIP', 'repair:REPAIR_MARKER; cleanup:UNINSTALL_OWNERSHIP'],
  ['LAZYSH_WINDOWS_INSTALLER:install:UNEXPECTED', 'install:UNEXPECTED'],
  ['private native output\nLAZYSH_WINDOWS_INSTALLER:gui:GUI_IPV4_REQUIRED', 'gui:GUI_IPV4_REQUIRED'],
  ['LAZYSH_WINDOWS_INSTALLER:gui:GUI_IPV4_REQUIRED private endpoint', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:gui:GUI_IPV5_REQUIRED', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:gui:GUI_LISTENER_EXTRA_LOOPBACK_V6', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:gui:GUI_LISTENER_ADDRESS private endpoint', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:identity:SOURCE_HASH_MISMATCH', 'identity:SOURCE_HASH_MISMATCH'],
  [Array(4).fill('LAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED').join('\n'), undefined],
  ['LAZYSH_WINDOWS_INSTALLER:preflight:PRIVATE_VALUE', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:private-stage:VERSION_MISMATCH', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED private-path', undefined],
  ['private-prefix LAZYSH_WINDOWS_INSTALLER:install:INSTALLER_EXIT', undefined],
  ['LAZYSH_WINDOWS_INSTALLER:repair:REPAIR_MARKER\nLAZYSH_WINDOWS_INSTALLER:cleanup:PRIVATE_VALUE', undefined],
  [null, undefined],
])('Windows installer diagnostics expose only closed labels: %j', (output, expected) => {
  expect(windowsInstallerFailure(output)).toBe(expected);
});
test('native failures never expose raw output or exception details from other tools', async () => {
  const failure = await native(process.execPath, ['-e',
    "console.log('LAZYSH_WINDOWS_INSTALLER:install:UNEXPECTED');console.error('private-native-secret');process.exit(1)"])
    .then(() => 'unexpected success', error => error.message);
  expect(failure).toBe(`Release validation failed: ${process.execPath.split(/[\\/]/).at(-1)}`);
});

test.skipIf(process.platform === 'win32')('owned PowerShell failure decoding redacts native output and rejects unknown markers', () => fixture(async root => {
  const tool = join(root, 'pwsh.exe');
  await symlink(process.execPath, tool);
  for (const [marker, label] of [
    ['LAZYSH_WINDOWS_INSTALLER:preflight:EXISTING_PATH', ' (preflight:EXISTING_PATH)'],
    ['LAZYSH_WINDOWS_INSTALLER:preflight:PRIVATE_VALUE', ''],
  ]) {
    const failure = await native(tool, ['-e',
      `console.log(${JSON.stringify(marker)});console.log('private-stdout');console.error('private-stderr');process.exit(1)`])
      .then(() => 'unexpected success', error => error.message);
    expect(failure).toBe(`Release validation failed: pwsh.exe${label}`);
  }
}));

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_HASH !== '1')('actual Windows SHA256 matches independent large-file vectors before installation', () => fixture(async root => {
  expect(process.platform).toBe('win32');
  const vectors = [
    { name: 'million-a', bytes: Buffer.alloc(1_000_000, 0x61),
      sha256: 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0' },
    // Independently checked with Python hashlib and OpenSSL, across nonuniform stream boundaries.
    { name: 'nonuniform', bytes: Uint8Array.from({ length: 8 * 1024 * 1024 + 17 }, (_, index) => index % 251),
      sha256: '485a584410e070b9d289cb2a75ee695b20860585e15736e6871364f3680e6526' },
  ];
  for (const vector of vectors) {
    const path = join(root, vector.name);
    await Bun.write(path, vector.bytes);
    expect(await digestFile(path)).toEqual({ bytes: vector.bytes.length, sha256: vector.sha256 });
    const actual = await native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; (Get-FileHash -LiteralPath $env:LAZYSH_HASH_FILE -Algorithm SHA256).Hash"],
    { ...process.env, LAZYSH_HASH_FILE: path }, 30_000);
    expect(actual.toLowerCase()).toBe(vector.sha256);
  }
}), 65_000);


const rawBundleMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK';
const nsisBundleMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS';
test.each([0, 65_536 - 1, 65_536 - rawBundleMarker.length + 1, 65_536])(
  'NSIS image prediction changes only the unique marker across stream boundary %i', offset => fixture(async root => {
    const leading = Buffer.alloc(offset, 0x5a), trailing = Buffer.alloc(73, 0x42);
    const source = join(root, 'raw.exe');
    await Bun.write(source, Buffer.concat([leading, Buffer.from(rawBundleMarker), trailing]));
    const expected = Buffer.concat([leading, Buffer.from(nsisBundleMarker), trailing]);
    expect(await windowsNsisBinaryDigest(source, await digestFile(source))).toEqual({ bytes: expected.length,
      sha256: new Bun.CryptoHasher('sha256').update(expected).digest('hex') });
    expect(await Bun.file(source).bytes()).toEqual(Buffer.concat([leading, Buffer.from(rawBundleMarker), trailing]));
  }));
test.each(['missing marker', rawBundleMarker + rawBundleMarker, nsisBundleMarker, '__TAURI_BUNDLE_TYPE_VAR_XYZ'])(
  'NSIS image prediction refuses unsupported layout %s', contents => fixture(async root => {
    const source = join(root, 'raw.exe');
    await Bun.write(source, contents);
    await expect(windowsNsisBinaryDigest(source, await digestFile(source))).rejects.toThrow('unsupported Windows NSIS bundle marker');
  }));
test('NSIS image prediction binds the entire source including bytes outside the marker', () => fixture(async root => {
  const source = join(root, 'raw.exe');
  await Bun.write(source, `before:${rawBundleMarker}:after`);
  const baseline = await digestFile(source), expected = await windowsNsisBinaryDigest(source, baseline);
  await Bun.write(source, `BEFORE:${rawBundleMarker}:after`);
  await expect(windowsNsisBinaryDigest(source, baseline)).rejects.toThrow('source identity mismatch');
  expect((await windowsNsisBinaryDigest(source, await digestFile(source))).sha256).not.toBe(expected.sha256);
}));

test('NSIS image prediction preserves the runtime bundle-comparison constants byte for byte', () => fixture(async root => {
  const source = join(root, 'raw.exe');
  const raw = `${['DEB', 'RPM', 'APP', 'MSI', 'NSS', 'XYZ', ''].map(kind => `__TAURI_BUNDLE_TYPE_VAR_${kind}`).join('|')}|${rawBundleMarker}`;
  await Bun.write(source, raw);
  const expected = raw.replace(rawBundleMarker, nsisBundleMarker);
  expect(await windowsNsisBinaryDigest(source, await digestFile(source))).toEqual({ bytes: Buffer.byteLength(expected),
    sha256: new Bun.CryptoHasher('sha256').update(expected).digest('hex') });
}));
