import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePackages, artifactName, artifactTargets, releaseTargets, digestFile, stagePackages,
  validateReceipt, releaseNotes, type ArtifactTarget } from '../.changeset/release-artifacts';
import { signingProfiles, iosBundleIds } from '../.changeset/release-apple';
import { javaProperty } from '../.changeset/release-android';
import { publishInstallationSet } from '../.changeset/release-publish';
import { exactlyOne, native, windowsInstallation, windowsInstallerFailure, windowsGuiCounterfactual, windowsNsisBinaryDigest } from '../.changeset/release-platform';
import { parseWindowsGuiOwner, windowsGuiCapabilities, windowsInstallerPathsScript, windowsInstalledGuiScript, isWindowsGuiDriverReceipt, windowsGuiToolEnvironment, windowsGuiSessionResponse, windowsGuiSessionNoResponse, windowsGuiSessionGuards, windowsGuiProbePhases, windowsGuiRoleReasons, windowsGuiRoleSubset, windowsGuiProbeDiagnostic, windowsGuiWindowRoleScript, windowsGuiHealthOwnershipScript, windowsGuiEndpointsScript, windowsGuiMetadataScript, parseWindowsGuiMetadata, windowsGuiMetadataProjection, windowsGuiOverrideNames, windowsGuiStartupScript, windowsGuiDebugTransportScript, parseWindowsGuiStartup, windowsGuiStartupProbe } from '../.changeset/windows-installed-gui';
import type { ReleasePolicy } from '../.changeset/release-tag';

const startupFixture=()=>({available:true,overflow:false,signature:'MICROSOFT',observedProcesses:3,observedRootGroups:1,registeredRuntimeVersion:'154.0.1000.1',edgeDriverVersion:'154.0.1000.1',rootImageVersions:['155.0.1001.2'],rootDebugTransports:[{role:'BROWSER_CANDIDATE',transport:'EPHEMERAL_PORT'}],observerEnvPresence:Object.fromEntries(Object.keys(windowsGuiOverrideNames).map(key=>[key,false]))});
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
  const version = policy.initialPublication.version;
  await mkdir(join(root, 'apps/client'), { recursive: true });
  await mkdir(join(root, '.changeset'));
  await mkdir(join(root, 'docs'));
  await Bun.write(join(root, 'docs/install-and-update.md'), '# Install\n\n## Current native acceptance status\n\nNative gaps #352 #344 #379 #306 #459 #457 #458; same-version repair does not establish full parity.\n\n## Historical status\n\nOld native status.\n');
  await Bun.write(join(root, '.changeset/release-policy.json'), JSON.stringify(policy));
  await Bun.write(join(root, 'apps/client/CHANGELOG.md'), `# Client\n\n## ${version}\n\nPrepared release.\n\n## 0.22.0\n\nHistorical release.\n`);
  await Bun.write(join(root, 'CHANGELOG.md'), '# Changes\n\n## [Unreleased]\n\nCurrent source change.\n\n## [0.22.0]\n\nOld source change.\n');
  const initial = await releaseNotes(root, version, true);
  for (const text of ['Prepared release.', 'Current source change.', '#352', '#344', '#379', '#306', '#459', '#457', '#458', 'does not establish full', 'same-version repair']) {
    expect(initial).toContain(text);
  }
  expect(initial).not.toContain('Historical release.');
  expect(initial).not.toContain('Old source change.');
  const ordinary = await releaseNotes(root, version);
  expect(ordinary).not.toContain('Current source change.');
  expect(ordinary).toContain('Native gaps #352 #344 #379 #306 #459 #457 #458');
  expect(ordinary).not.toContain('Old native status.');
  expect(initial).not.toContain('Old native status.');
  await expect(releaseNotes(root, '0.22.0', true)).rejects.toThrow('not allowlisted');
  await Bun.write(join(root, 'CHANGELOG.md'), '# Empty');
  await expect(releaseNotes(root, version, true)).rejects.toThrow('development changes');
  for (const status of ['# Missing', '## Current native acceptance status\n\n## Next\nEmpty',
    '## Current native acceptance status\nOne\n## Current native acceptance status\nTwo']) {
    await Bun.write(join(root, 'docs/install-and-update.md'), status);
    await expect(releaseNotes(root, version)).rejects.toThrow('native acceptance status');
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
  const script = windowsInstallerPathsScript + windowsGuiEndpointsScript + windowsGuiHealthOwnershipScript + windowsGuiMetadataScript + windowsGuiStartupScript + String.raw`
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
$current=Get-Process -Id $PID
foreach ($role in @('DRIVER','EDGE')) {
  [Environment]::SetEnvironmentVariable('LAZYSH_GUI_'+$role,$current.Path)
  [Environment]::SetEnvironmentVariable('LAZYSH_GUI_'+$role+'_PID',[string]$PID)
  [Environment]::SetEnvironmentVariable('LAZYSH_GUI_'+$role+'_START',$current.StartTime.ToUniversalTime().Ticks.ToString())
  [Environment]::SetEnvironmentVariable('LAZYSH_GUI_'+$role+'_SHA256',(Get-FileHash -LiteralPath $current.Path -Algorithm SHA256).Hash)
}
$env:LAZYSH_GUI_PORT='12345';$env:LAZYSH_GUI_NATIVE_PORT='12346'
function Get-NetTCPConnection { @([PSCustomObject]@{LocalPort=12345;LocalAddress='127.0.0.1';OwningProcess=$PID},[PSCustomObject]@{LocalPort=12346;LocalAddress='127.0.0.1';OwningProcess=$PID}) }
GuiHealthOwnership
foreach ($role in @('DRIVER','EDGE')) {
  foreach ($field in @('', '_PID', '_START', '_SHA256')) {
    $key='LAZYSH_GUI_'+$role+$field
    $original=[Environment]::GetEnvironmentVariable($key)
    [Environment]::SetEnvironmentVariable($key,'invalid')
    $rejected=$false
    try { GuiHealthOwnership } catch { $rejected=$true }
    [Environment]::SetEnvironmentVariable($key,$original)
    if (!$rejected) { throw 'health identity change admitted' }
  }
}
$env:LAZYSH_GUI_BINARY=$current.Path
$env:LAZYSH_NSIS_BINARY_SHA256=(Get-FileHash -LiteralPath $current.Path -Algorithm SHA256).Hash
$script:metadataAppId=$PID
$script:metadataStart=$current.StartTime.ToUniversalTime().Ticks.ToString()
$script:metadataEligible=GuiMetadataImageFence $script:metadataAppId $script:metadataStart
$script:metadataComplete=$true;$script:metadataOverflow=$false;$script:metadataWindows=@()
if (!(GuiMetadataSnapshot).available) { throw 'owned metadata fence rejected' }
foreach ($field in @('LAZYSH_GUI_BINARY','LAZYSH_NSIS_BINARY_SHA256')) {
  $original=[Environment]::GetEnvironmentVariable($field)
  [Environment]::SetEnvironmentVariable($field,'invalid')
  if ((GuiMetadataSnapshot).available) { throw 'changed metadata image admitted' }
  [Environment]::SetEnvironmentVariable($field,$original)
}
$script:metadataAppId=-1
if ((GuiMetadataSnapshot).available) { throw 'missing metadata process admitted' }
$script:metadataAppId=$PID
$script:metadataStart='0'
if ((GuiMetadataSnapshot).available) { throw 'changed metadata start admitted' }
$script:metadataStart=$current.StartTime.ToUniversalTime().Ticks.ToString()
$script:metadataEligible=$false
if ((GuiMetadataSnapshot).available) { throw 'missing initial fence admitted' }
$script:metadataEligible=$true;$script:metadataComplete=$false
if ((GuiMetadataSnapshot).available) { throw 'incomplete enumeration admitted' }
$epoch=[DateTime]::new(638999999990000000L,[DateTimeKind]::Utc)
$rows=@(
  [PSCustomObject]@{ProcessId=1;ParentProcessId=0;CreationDate=$epoch.AddTicks(10L)},
  [PSCustomObject]@{ProcessId=2;ParentProcessId=1;CreationDate=$epoch.AddTicks(20L)},
  [PSCustomObject]@{ProcessId=3;ParentProcessId=2;CreationDate=$epoch.AddTicks(30L)},
  [PSCustomObject]@{ProcessId=4;ParentProcessId=3;CreationDate=$epoch.AddTicks(40L)},
  [PSCustomObject]@{ProcessId=5;ParentProcessId=4;CreationDate=$epoch.AddTicks(50L)},
  [PSCustomObject]@{ProcessId=6;ParentProcessId=4;CreationDate=$epoch.AddTicks(60L)}
)
if ((@(GuiRuntimeRoots $rows @(4,5,6) 1) -join ',') -cne '4') { throw 'runtime children counted as groups' }
$second=$rows+@([PSCustomObject]@{ProcessId=7;ParentProcessId=3;CreationDate=$epoch.AddTicks(70L)},[PSCustomObject]@{ProcessId=8;ParentProcessId=7;CreationDate=$epoch.AddTicks(80L)})
if ((@(GuiRuntimeRoots $second @(4,5,6,7,8) 1) -join ',') -cne '4,7') { throw 'separate runtime group missing' }
if (@(GuiRuntimeRoots $rows @() 1).Count -ne 0) { throw 'empty observed membership invented a root' }
foreach ($case in @(
  @{Rows=@($rows | Where-Object {$_.ProcessId -ne 3});Members=@(4,5,6)},
  @{Rows=($rows+$rows[3]);Members=@(4,5,6)},
  @{Rows=@($rows[0],$rows[1],$rows[2],[PSCustomObject]@{ProcessId=4;ParentProcessId=5;CreationDate=$epoch.AddTicks(40L)},[PSCustomObject]@{ProcessId=5;ParentProcessId=4;CreationDate=$epoch.AddTicks(50L)});Members=@(4,5)},
  @{Rows=@($rows[0],[PSCustomObject]@{ProcessId=2;ParentProcessId=1;CreationDate=$epoch.AddTicks(1000L)},$rows[2],$rows[3],$rows[4],$rows[5]);Members=@(4,5,6)},
  @{Rows=@($rows[0],[PSCustomObject]@{ProcessId=2;ParentProcessId=1},$rows[2],$rows[3],$rows[4],$rows[5]);Members=@(4,5,6)},
  @{Rows=$rows;Members=@(1)},@{Rows=$rows;Members=@(4,4)}
)) {
  $rejected=$false;try { $null=GuiRuntimeRoots $case.Rows $case.Members 1 } catch { $rejected=$true }
  if (!$rejected) { throw 'unverified runtime ancestry admitted' }
}
$maximum=@($rows[0],$rows[1],$rows[2])+@(4..35 | ForEach-Object {[PSCustomObject]@{ProcessId=$_;ParentProcessId=3;CreationDate=$epoch.AddTicks($_*10L)}})
if (@(GuiRuntimeRoots $maximum @(4..35) 1).Count -ne 32) { throw 'bounded runtime groups rejected' }
$rejected=$false;try { $null=GuiRuntimeRoots ($maximum+[PSCustomObject]@{ProcessId=36;ParentProcessId=3;CreationDate=$epoch.AddTicks(360L)}) @(4..36) 1 } catch { $rejected=$true }
if (!$rejected) { throw 'runtime overflow admitted' }
foreach ($version in @('1.2.3.4','65535.0.1.2')) { if (!(GuiNumericVersion $version)) { throw 'numeric version rejected' } }
foreach ($version in @('0.0.0.0','01.2.3.4','1.2.3.65536','1.2.3.4 suffix',('1.2.3.4'+[char]10),'1.2.3')) { if (GuiNumericVersion $version) { throw 'untrusted version admitted' } }
$original=[PSCustomObject]@{ProcessId=123;CreationDate=$epoch}
foreach ($tail in 0..9) { if (!(GuiInventoryLifetime $original ($epoch.Ticks+$tail).ToString())) { throw 'CIM microsecond representation rejected' } }
foreach ($offset in @(-10L,10L,10000L,10000000L)) { if (GuiInventoryLifetime $original ($epoch.Ticks+$offset).ToString()) { throw 'same-PID different creation lifetime admitted' } }
foreach ($creation in @($null,$epoch.ToString(),[DateTime]::SpecifyKind($epoch,[DateTimeKind]::Unspecified),$epoch.AddTicks(1L))) {
  if (GuiInventoryLifetime ([PSCustomObject]@{CreationDate=$creation}) $epoch.Ticks.ToString()) { throw 'unsupported creation precision admitted' }
}
if (!(GuiInventoryLifetime ([PSCustomObject]@{CreationDate=$epoch.ToLocalTime()}) $epoch.Ticks.ToString())) { throw 'UTC/local lifetime conversion mismatch' }
'owned GUI endpoint shapes passed'
`;
  expect(await native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.env, 30000)).toBe('owned GUI endpoint shapes passed');
  const metadata={available:true,overflow:false,windows:[{className:'Synthetic framework',style:0,exstyle:0,width:0,height:0,clientWidth:0,clientHeight:0,ownerless:true}]};
  const failure='gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:UNKNOWN_CLASS:ROLES_UNKNOWN_CLASS:HEALTH_READY_NATIVE_READY; gui:GUI_CLEANUP; cleanup:UNEXPECTED';
  const rejection=String.raw`[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:UNKNOWN_CLASS:ROLES_1024:HEALTH_READY_NATIVE_READY');[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP');[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED');[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_METADATA:'+$env:LAZYSH_METADATA_UNIT);[Console]::Error.WriteLine('private native error');exit 1`;
  for(const value of [metadata,{...metadata,title:'private'}]){
    const expected='Release validation failed: pwsh.exe ('+failure+')'+('title' in value?'':'\nOwned Windows GUI metadata: '+JSON.stringify(metadata));
    await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',rejection],{...process.env,LAZYSH_METADATA_UNIT:JSON.stringify(value)},30000)).rejects.toMatchObject({message:expected});
  }
  const nonSession=String.raw`[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_OWNER');[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_METADATA:'+$env:LAZYSH_METADATA_UNIT);[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_STARTUP:'+$env:LAZYSH_STARTUP_UNIT);exit 1`;
  await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',nonSession],{...process.env,LAZYSH_METADATA_UNIT:JSON.stringify(metadata),LAZYSH_STARTUP_UNIT:JSON.stringify(startupFixture())},30000)).rejects.toMatchObject({message:'Release validation failed: pwsh.exe (gui:GUI_OWNER)'});

});
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows GUI endpoint startup diagnostics preserve native failures and partial ownership',async()=>{
  const startup=startupFixture();
  const failure='gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY; gui:GUI_CLEANUP; cleanup:UNEXPECTED';
  const startupRejection=String.raw`[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY');[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP');[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED');[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_STARTUP:'+$env:LAZYSH_STARTUP_UNIT);[Console]::Error.WriteLine('private native error');exit 1`;
  for(const value of [startup,{...startup,pid:'private'}]){
    const projected='pid' in value?{available:false,overflow:false,signature:'UNVERIFIED'}:startup;
    await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',startupRejection],{...process.env,LAZYSH_STARTUP_UNIT:JSON.stringify(value)},30000)).rejects.toMatchObject({message:'Release validation failed: pwsh.exe ('+failure+')\nOwned Windows GUI startup: '+JSON.stringify(projected)});
  }
  const partialCore=await native('node',['--input-type=module','-e',String.raw`
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const {windowsGuiStartupProbe,parseWindowsGuiOwner}=await import(process.env.LAZYSH_GUI_CONTRACT_MODULE);
const pending=promisify(execFile)('pwsh.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::Out.WriteLine($env:LAZYSH_SYNTHETIC_CORE);$null=[Threading.ManualResetEvent]::new($false).WaitOne()"],{timeout:15000,maxBuffer:16384});
let observed='';pending.child.stdout.on('data',chunk=>{observed+=chunk.toString();if(observed.includes('\n'))pending.child.kill();});
try {await pending;throw Error('owned fixture did not fail');}catch(error){if(!error.killed)throw Error('owned fixture not retired');const proof=windowsGuiStartupProbe(error.stdout);if(proof.startup!==undefined||parseWindowsGuiOwner(proof.core,'a'.repeat(64)).window!=='3')throw Error('partial core proof lost');console.info('PARTIAL_CORE_PRESERVED');}
`],{...process.env,LAZYSH_GUI_CONTRACT_MODULE:new URL('../.changeset/windows-installed-gui.ts',import.meta.url).href,LAZYSH_SYNTHETIC_CORE:JSON.stringify({pid:1,start:'2',window:'3',sha256:'a'.repeat(64)})},30000);
  expect(partialCore).toBe('PARTIAL_CORE_PRESERVED');
});
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows GUI window roles require one main and only the pinned zero-client framework helpers', async () => {
  const script = windowsGuiWindowRoleScript + windowsGuiDebugTransportScript + String.raw`
$ErrorActionPreference = 'Stop'
$vectors=@(
  @{Args=@('app','--remote-debugging-pipe');Code='PIPE'},
  @{Args=@('app','--REMOTE-DEBUGGING-PORT=0');Code='EPHEMERAL_PORT'},
  @{Args=@('app','/remote-debugging-port=65535');Code='FIXED_PORT'},
  @{Args=@('app','-remote-debugging-port=1');Code='FIXED_PORT'},
  @{Args=@('app','--','--remote-debugging-pipe');Code='ABSENT'},
  @{Args=@('app','--user-data-dir=--remote-debugging-pipe','--mojo-named-platform-channel-pipe=x');Code='ABSENT'},
  @{Args=@('app','--remote-debugging-port=0','--remote-debugging-pipe');Code='AMBIGUOUS'},
  @{Args=@('app','--remote-debugging-port=0','--remote-debugging-port=0');Code='AMBIGUOUS'},
  @{Args=@('app','--remote-debugging-port');Code='UNVERIFIED'},
  @{Args=@('app','--remote-debugging-port=-1');Code='UNVERIFIED'},
  @{Args=@('app','--remote-debugging-port=65536');Code='UNVERIFIED'},
  @{Args=@('app','--remote-debugging-pipe=x');Code='UNVERIFIED'},
  @{Args=@('app',' --remote-debugging-pipe ');Code='PIPE'},
  @{Args=@('app',([char]160+'--remote-debugging-pipe'));Code='UNVERIFIED'},
  @{Args=@('app','--remote-debugging-port=00');Code='UNVERIFIED'},
  @{Args=@('app',(' --remote-debugging-port=0'+[char]10+'1'));Code='UNVERIFIED'},
  @{Args=@('app',('--remote-debugging-pipe=x'+[char]10+'y'));Code='UNVERIFIED'},
  @{Args=@('app',('--single-argument=x'+[char]10+'y'));Code='UNVERIFIED'},
  @{Args=@('app','--single-argument','--remote-debugging-pipe');Code='UNVERIFIED'}
)
foreach ($vector in $vectors) { if ((GuiDebugArguments $vector.Args).transport -cne $vector.Code) { throw 'debug transport model mismatch' } }
foreach ($invalid in @($null,'',('a'*32768),('app'+[char]0+' --remote-debugging-pipe'))) {
  if ((GuiDebugTransport $invalid).transport -cne 'UNVERIFIED') { throw 'invalid native argument input admitted' }
}
if ((GuiDebugArguments (@('app')*513)).transport -cne 'UNVERIFIED') { throw 'argument bound ignored' }
if ((GuiDebugTransport 'app.exe').transport -cne $(if ($IsWindows) {'ABSENT'} else {'UNVERIFIED'})) { throw 'native parser platform contract' }
if (!('OwnedGuiArguments' -as [type])) { throw 'native parser did not compile' }
$joint=@(
  @{Args=@('app');Role='BROWSER_CANDIDATE';Transport='ABSENT'},
  @{Args=@('app','--type');Role='BROWSER_CANDIDATE';Transport='ABSENT'},
  @{Args=@('app','--type=','--remote-debugging-pipe');Role='BROWSER_CANDIDATE';Transport='PIPE'},
  @{Args=@('app','--type=renderer');Role='TYPED_CHILD';Transport='ABSENT'},
  @{Args=@('app','/TYPE=unrecognized-selector','--remote-debugging-port=0');Role='TYPED_CHILD';Transport='EPHEMERAL_PORT'},
  @{Args=@('app','--type=renderer','--type=renderer','--remote-debugging-pipe');Role='AMBIGUOUS';Transport='PIPE'},
  @{Args=@('app','--type=','--type=');Role='AMBIGUOUS';Transport='ABSENT'},
  @{Args=@('app','--','--type=renderer','--remote-debugging-pipe');Role='BROWSER_CANDIDATE';Transport='ABSENT'},
  @{Args=@('app',('--type=x'+[char]10+'y'));Role='UNVERIFIED';Transport='UNVERIFIED'},
  @{Args=@('app',('--type=x'+[char]233));Role='UNVERIFIED';Transport='UNVERIFIED'},
  @{Args=@('app','--single-argument','--type=renderer');Role='UNVERIFIED';Transport='UNVERIFIED'},
  @{Args=@($null);Role='UNVERIFIED';Transport='UNVERIFIED'}
)
foreach ($vector in $joint) {
  $record=GuiDebugArguments $vector.Args
  if ($record.role -cne $vector.Role -or $record.transport -cne $vector.Transport) { throw 'joint selector/transport mismatch' }
}
if ($IsWindows) {
  foreach ($vector in @(
    @{Line=' "C:\owned space\app.exe" --remote-debugging-port="0" ';Code='EPHEMERAL_PORT'},
    @{Line='app.exe "--user-data-dir=C:\path --remote-debugging-pipe"';Code='ABSENT'},
    @{Line='app.exe "--user-data-dir=C:\quoted\\" --remote-debugging-pipe';Code='PIPE'},
    @{Line='app.exe -- /remote-debugging-port=1';Code='ABSENT'},
    @{Line='app.exe /REMOTE-DEBUGGING-PIPE';Code='PIPE'},
    @{Line='app.exe --remote-debugging-port=9222';Code='FIXED_PORT'},
    @{Line='app.exe --remote-debugging-port=0 --remote-debugging-pipe';Code='AMBIGUOUS'},
    @{Line='app.exe --remote-debugging-port=65536';Code='UNVERIFIED'},
    @{Line='app.exe --remote-debugging-port';Code='UNVERIFIED'},
    @{Line='app.exe --remote-debugging-pipe=x';Code='UNVERIFIED'},
    @{Line=('app.exe "--remote-debugging-port=0'+[char]10+'1"');Code='UNVERIFIED'},
    @{Line=('app.exe "--remote-debugging-pipe=x'+[char]10+'y"');Code='UNVERIFIED'},
    @{Line=('app.exe "--single-argument=x'+[char]10+'y"');Code='UNVERIFIED'},
    @{Line='app.exe --single-argument --remote-debugging-pipe';Code='UNVERIFIED'}
  )) { if ((GuiDebugTransport $vector.Line).transport -cne $vector.Code) { throw 'Win32 debug transport parsing mismatch' } }
  foreach ($vector in @(
    @{Line='"C:\owned space\app.exe" --type= --remote-debugging-pipe';Role='BROWSER_CANDIDATE';Transport='PIPE'},
    @{Line='app.exe --type=renderer --remote-debugging-port=0';Role='TYPED_CHILD';Transport='EPHEMERAL_PORT'},
    @{Line='app.exe --type --type=renderer';Role='AMBIGUOUS';Transport='ABSENT'},
    @{Line='app.exe -- --type=renderer';Role='BROWSER_CANDIDATE';Transport='ABSENT'},
    @{Line='app.exe /TYPE="unknown child" --remote-debugging-port=9222';Role='TYPED_CHILD';Transport='FIXED_PORT'},
    @{Line=('app.exe "--type=x'+[char]10+'y"');Role='UNVERIFIED';Transport='UNVERIFIED'},
    @{Line=('app.exe "--type=x'+[char]233+'"');Role='UNVERIFIED';Transport='UNVERIFIED'}
  )) {
    $record=GuiDebugTransport $vector.Line
    if ($record.role -cne $vector.Role -or $record.transport -cne $vector.Transport) { throw 'Win32 joint selector/transport mismatch' }
  }
}
$mainRole = GuiWindowRole 'Tauri Window' 281542656L 262144L $true 1200L 800L 1200L 800L
$helperRole = GuiWindowRole 'Tao Thread Event Target' 2415919104L 134742176L $true 0L 0L 0L 0L
if ($mainRole -cne 'MAIN' -or $helperRole -cne 'TAO_EVENT_HELPER') { throw 'valid pinned roles rejected' }
$main = [PSCustomObject]@{Handle='123';Role=$mainRole}
$helper = [PSCustomObject]@{Handle='456';Role=$helperRole}
if ((GuiMainWindow @($main,$helper)) -cne '123') { throw 'wrong main selection' }
foreach ($className in @('Tao Thread Event Target','app.lazysh.client-sic')) {
  foreach ($style in @(2415919104L,2483027968L)) {
    foreach ($outer in @(0L,16L,32L)) {
      if ((GuiWindowRole $className $style 134742176L $true $outer $outer 0L 0L) -cne 'TAO_EVENT_HELPER') { throw 'zero-client helper rejected' }
    }
  }
}
$singleton=[PSCustomObject]@{Handle='789';Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027968L 134742176L $true 16L 16L 0L 0L)}
if ((GuiMainWindow @($helper,$singleton,$main)) -cne '123') { throw 'wrong main among framework helpers' }

$cases = @(
  @{Role=(GuiWindowRole 'Tauri Window' 349110272L 262416L $true 1044L 788L 0L 700L);Code='MAIN_GEOMETRY_MISMATCH'},
  @{Role=(GuiWindowRole 'Tauri Window' 349110272L 262416L $true 1044L 788L 1000L 0L);Code='MAIN_GEOMETRY_MISMATCH'},
  @{Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027968L 134742176L $true 16L 16L 0L 1L);Code='TAO_GEOMETRY_MISMATCH'},
  @{Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027968L 134742176L $true 16L 16L $null 0L);Code='ROLE_DATA_UNVERIFIED'},
  @{Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027968L 134742176L $false 16L 16L 0L 0L);Code='TAO_OWNER_MISMATCH'},
  @{Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027968L 134742177L $true 16L 16L 0L 0L);Code='TAO_EXSTYLE_MISMATCH'},
  @{Role=(GuiWindowRole 'app.lazysh.client-sic' 2483027969L 134742176L $true 16L 16L 0L 0L);Code='TAO_STYLE_MISMATCH'},
  @{Role=(GuiWindowRole 'another-sic' 2483027968L 134742176L $true 16L 16L 0L 0L);Code='UNKNOWN_CLASS'},
  @{Role=(GuiWindowRole 'unknown class' 281542656L 262144L $true 1200L 800L 1200L 800L);Code='UNKNOWN_CLASS'},
  @{Role=(GuiWindowRole 'Tauri Window' 281542656L 262144L $false 1200L 800L 1200L 800L);Code='MAIN_OWNER_MISMATCH'},
  @{Role=(GuiWindowRole 'Tauri Window' 281542656L 262144L $true 0L 800L 1200L 800L);Code='MAIN_GEOMETRY_MISMATCH'},
  @{Role=(GuiWindowRole 'Tauri Window' 2415919104L 262144L $true 1200L 800L 1200L 800L);Code='MAIN_STYLE_MISMATCH'},
  @{Role=(GuiWindowRole 'Tauri Window' 281542656L 128L $true 1200L 800L 1200L 800L);Code='MAIN_EXSTYLE_MISMATCH'},
  @{Role=(GuiWindowRole 'Tao Thread Event Target' 2415919104L 134742176L $true 16L 16L 1L 0L);Code='TAO_GEOMETRY_MISMATCH'},
  @{Role=(GuiWindowRole 'Tao Thread Event Target' 2415919104L 128L $true 0L 0L 0L 0L);Code='TAO_EXSTYLE_MISMATCH'},
  @{Role=(GuiWindowRole 'Tao Thread Event Target' 2415919104L 134742176L $false 0L 0L 0L 0L);Code='TAO_OWNER_MISMATCH'},
  @{Role=(GuiWindowRole 'Tao Thread Event Target' '2415919104' 134742176L $true 0L 0L 0L 0L);Code='ROLE_DATA_UNVERIFIED'},
  @{Role=(GuiWindowRole 'Tao Thread Event Target' 2415919105L 134742176L $true 0L 0L 0L 0L);Code='TAO_STYLE_MISMATCH'}
)
foreach ($case in $cases) {
  if ($case.Role -cne $case.Code) { throw 'wrong role diagnostic' }
  $script:phase='PROBE_UNVERIFIED';$rejected=$false
  try { $null=GuiMainWindow @($main,[PSCustomObject]@{Handle='456';Role=$case.Role}) } catch { $rejected=$true }
  if (!$rejected -or $script:phase -cne $case.Code) { throw 'role diagnostic admitted or misclassified' }
}
foreach ($case in @(
  @{Handles=@($main,$main);Code='VISIBLE_HANDLES_AMBIGUOUS'},
  @{Handles=@($main,[PSCustomObject]@{Handle='789';Role='UNKNOWN_CLASS'});Code='UNKNOWN_CLASS'},
  @{Handles=@($helper);Code='NO_MAIN_WINDOW_OBSERVED'},
  @{Handles=@([PSCustomObject]@{Handle='123';Role='MAIN_OWNER_MISMATCH'},[PSCustomObject]@{Handle='456';Role='TAO_STYLE_MISMATCH'});Code='MULTIPLE_ROLE_MISMATCHES'},
  @{Handles=@([PSCustomObject]@{Handle='123';Role='UNVERIFIED'});Code='WINDOW_ROLE_UNVERIFIED'}
)) {
  $script:phase='PROBE_UNVERIFIED';$rejected=$false
  try { $null=GuiMainWindow $case.Handles } catch { $rejected=$true }
  if (!$rejected -or $script:phase -cne $case.Code) { throw 'wrong role rejection' }
}
$script:phase='PROBE_UNVERIFIED'
try { GuiMainWindow @([PSCustomObject]@{Handle='123';Role='MAIN_EXSTYLE_MISMATCH'},[PSCustomObject]@{Handle='456';Role='TAO_STYLE_CLIPSIBLINGS_ONLY'}) } catch { }
if ($script:roleMask -ne 144 -or $script:phase -cne 'MULTIPLE_ROLE_MISMATCHES') { throw 'exact subset not retained' }
$allReasons=@(${windowsGuiRoleReasons.map(reason=>"'"+reason+"'").join(',')})
$allHandles=@($allReasons | ForEach-Object { [PSCustomObject]@{Handle='123';Role=$_} })
try { GuiMainWindow $allHandles } catch { }
if ($script:roleMask -ne 2047 -or $script:phase -cne 'MULTIPLE_ROLE_MISMATCHES') { throw 'full subset not retained' }
foreach ($index in 0..10) {
  try { GuiMainWindow @([PSCustomObject]@{Handle='123';Role=$allReasons[$index]}) } catch { }
  if ($script:roleMask -ne (1 -shl $index) -or $script:phase -cne $allReasons[$index]) { throw 'single reason bit mismatch' }
}
if ((GuiMainWindow @($main,$helper)) -cne '123' -or $script:roleMask -ne 0) { throw 'stale mask survived valid roles' }
'owned GUI window roles passed'
`;
  expect(await native('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.env, 30000)).toBe('owned GUI window roles passed');
}, 35000);
test('Windows counterfactual changes only the documented browser argument and preserves baseline projection',()=>{
  const baseline=windowsGuiCapabilities('owned.exe','0'),treatment=windowsGuiCapabilities('owned.exe','1');
  expect(treatment).toEqual({...baseline,'tauri:options':{...baseline['tauri:options'],webviewOptions:{additionalBrowserArguments:['--remote-debugging-port=0']}}});
  expect(baseline['tauri:options']).toEqual({application:'owned.exe'});
  for(const invalid of [undefined,'','automatic','true'])expect(()=>windowsGuiCapabilities('owned.exe',invalid)).toThrow('Invalid installed GUI treatment');
  const prefix='LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:',primary='LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY';
  for(const outcome of ['PASSED','NOT_RUN_BUDGET','NOT_RUN_CLEANUP']){
    const text=primary+'\n'+prefix+outcome;
    expect(windowsGuiCounterfactual(text)).toEqual({outcome});
    expect(windowsInstallerFailure(text)).toBe('gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY');
  }
  const startup=startupFixture(),text=primary+'\n'+prefix+'gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY\nLAZYSH_WINDOWS_GUI_COUNTERFACTUAL_STARTUP:'+JSON.stringify(startup);
  expect(windowsGuiCounterfactual(text)).toEqual({outcome:'REJECTED',rejection:'gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY',startup});
  expect(windowsGuiStartupProbe(text).startup).toBeUndefined();
  expect(windowsGuiCounterfactual(prefix+'PASSED\nLAZYSH_WINDOWS_GUI_COUNTERFACTUAL_STARTUP:'+JSON.stringify(startup))).toEqual({outcome:'UNVERIFIED'});
  for(const invalid of ['PRIVATE', 'PASSED\n'+prefix+'gui:GUI_CLEANUP','gui:PRIVATE','gui:GUI_CLIENT private','gui:GUI_CLIENT\n'+prefix+'gui:GUI_CLEANUP\n'+prefix+'gui:GUI_CLEANUP']){
    expect(windowsGuiCounterfactual(primary+'\n'+prefix+invalid)).toEqual({outcome:'UNVERIFIED'});
  }
});
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows GUI endpoint counterfactual gates cleanup, identity and budget while retaining primary failure',()=>fixture(async root=>{
  const image=join(root,'owned-image');await Bun.write(image,'fixed owned candidate');
  const expected=await digestFile(image),baseline='GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY';
  const script=windowsInstallerPathsScript+windowsInstalledGuiScript+String.raw`
$ErrorActionPreference='Stop'
$baseline='GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY'
$guiCleanupVerified=$env:LAZYSH_COUNTER_CASE -ne 'cleanup'
$guiParentStarted=[Environment]::TickCount64-$(if ($env:LAZYSH_COUNTER_CASE -eq 'budget') {180001L} else {0L})
$script:called=0
function Installed {
  Plain $env:LAZYSH_GUI_BINARY
  Require ((Get-FileHash -LiteralPath $env:LAZYSH_GUI_BINARY).Hash -eq $env:LAZYSH_NSIS_BINARY_SHA256) 'BINARY_MISMATCH'
}
function ExerciseInstalledGui([switch]$counterfactual) {
  if (!$counterfactual) { throw 'treatment not explicitly selected' }
  $script:called++
  if ($env:LAZYSH_COUNTER_CASE -eq 'rejected') { Require $false 'GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY' }
  if ($env:LAZYSH_COUNTER_CASE -eq 'treatment-cleanup') { Require $false 'GUI_CLEANUP' }
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:PASSED')
}
if ($env:LAZYSH_COUNTER_CASE -eq 'image') { $env:LAZYSH_NSIS_BINARY_SHA256='0'*64 }
if ($env:LAZYSH_COUNTER_CASE -eq 'tool') { $env:LAZYSH_GUI_EDGE_SHA256='0'*64 }
[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:'+$baseline)
GuiCounterfactual $baseline
if ($script:failure -cne $baseline -or $script:called -ne $(if ($env:LAZYSH_COUNTER_CASE -in @('passed','rejected','treatment-cleanup')) {1} else {0})) { throw 'baseline or admission changed' }
exit 1
`;
  for(const [name,outcome] of [['passed','PASSED'],['cleanup','NOT_RUN_CLEANUP'],['budget','NOT_RUN_BUDGET'],['image','REJECTED'],['tool','REJECTED'],['rejected','REJECTED'],['treatment-cleanup','REJECTED']]){
    const env={...process.env,LAZYSH_COUNTER_CASE:name,LAZYSH_GUI_BINARY:image,LAZYSH_NSIS_BINARY_SHA256:expected.sha256,LAZYSH_GUI_DRIVER:image,LAZYSH_GUI_EDGE:image,LAZYSH_GUI_DRIVER_SHA256:expected.sha256,LAZYSH_GUI_EDGE_SHA256:expected.sha256};
    await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],env,30000)).rejects.toThrow(`Release validation failed: pwsh.exe (gui:${baseline})\nOwned Windows GUI counterfactual: {"outcome":"${outcome}"`);
  }
  for(const label of ['gui:GUI_CLIENT','gui:'+baseline+'\nLAZYSH_WINDOWS_INSTALLER:cleanup:LOCAL_DATA']){
    const rejected=`[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:${label}');[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:PASSED');exit 1`;
    await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',rejected],process.env,30000)).rejects.toMatchObject({message:'Release validation failed: pwsh.exe ('+label.replace('\nLAZYSH_WINDOWS_INSTALLER:','; ')+')'});
  }
}));
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
test('Windows session diagnostics classify exact W3C codes without retaining or changing raw responses', () => {
  for (const [error,expected] of [['session not created','NOT_CREATED'],['invalid argument','ARGUMENT'],
    ['unknown error','REMOTE_ERROR'],['timeout','SERVER_TIMEOUT'],['session not created private-path','RESPONSE']]) {
    const response=Object.freeze({statusCode:500,body:Object.freeze({value:Object.freeze({error,message:'private raw capabilities/path/token'})})});
    expect(windowsGuiSessionResponse(response)).toBe(expected);
    expect(response.body.value.message).toBe('private raw capabilities/path/token');
  }
  for (const response of [null,'private raw response',{}, {body:{value:{error:123}}}, {body:{error:'session not created'}}, {body:{value:{error:'SESSION NOT CREATED'}}}]) {
    expect(windowsGuiSessionResponse(response)).toBe('RESPONSE');
  }
});
test('Windows client timeout classification requires the pinned exact own-session error contract', () => {
  const message='WebDriverError: Request timed out! Consider increasing the "connectionRetryTimeout" option. when running "http://127.0.0.1:12345/session" with method "POST"';
  expect(windowsGuiSessionNoResponse(new Error(message),12345)).toBe('CLIENT_TIMEOUT');
  for (const error of [new Error(message.replace('12345','54321')), new Error(message.replace('POST','GET')),
    new Error(message.replace('Request timed out!','Request timed out')), new Error('prefix '+message),
    new Error(message+' and args "private"'), new Error(message+'\nprivate'), new Error(message.slice(0,-1)), {message}, new Error('ETIMEDOUT')]) {
    expect(windowsGuiSessionNoResponse(error,12345)).toBe('NO_RESPONSE');
  }
  expect(windowsGuiSessionNoResponse(new Error(message),0)).toBe('NO_RESPONSE');
  expect(windowsGuiSessionNoResponse(new Error(message),12345.5)).toBe('NO_RESPONSE');
});
test('pinned Node WebDriver timeout contract is reproduced against an owned nonresponding unit endpoint', async () => {
  const result = await native('node', ['--input-type=module', '-e', String.raw`
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const {windowsGuiSessionNoResponse}=await import(process.env.LAZYSH_GUI_CONTRACT_MODULE);
const {remote}=createRequire(process.env.LAZYSH_GUI_CONTRACT_MODULE)('webdriverio');
let requests=0;
const server=createServer((request)=>{if(request.method==='POST'&&request.url==='/session')requests++;});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
try {
  await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'silent',connectionRetryCount:0,connectionRetryTimeout:200,
    capabilities:{'tauri:options':{application:'owned-contract-unit-only'},'wdio:enforceWebDriverClassic':true}});
  throw new Error('Unexpected unit endpoint response');
} catch(error) {
  if(requests!==1||windowsGuiSessionNoResponse(error,port)!=='CLIENT_TIMEOUT')throw new Error('Pinned timeout contract not observed');
  console.info('CLIENT_TIMEOUT');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
`], {...process.env, LAZYSH_GUI_CONTRACT_MODULE: new URL('../.changeset/windows-installed-gui.ts', import.meta.url).href}, 15000);
  expect(result).toBe('CLIENT_TIMEOUT');
},20000);
test('Windows failure health probes are bounded direct read-only requests with ownership retirement', async () => {
  const result=await native('node',['--input-type=module','-e',String.raw`
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const {windowsGuiStatus,windowsGuiSessionHealth}=await import(process.env.LAZYSH_GUI_CONTRACT_MODULE);
let calls=0,proxyCalls=0;let mode='ready';
const server=createServer((request,response)=>{
  calls++;assert.equal(request.method,'GET');assert.equal(request.url,'/status');
  if(mode==='stall')return;
  if(mode==='redirect'){response.writeHead(302,{location:'http://127.0.0.1:1/private'});response.end();return;}
  if(mode==='large'){response.end(' '.repeat(2049));return;}
  if(mode==='boundary'){response.end(JSON.stringify({value:{ready:true}}).padEnd(2048,' '));return;}
  response.end(mode==='ready'?'{"value":{"ready":true,"message":"private"}}':mode==='false'?'{"value":{"ready":false}}':'{"value":{"ready":"true"}}');
});
const other=createServer((request,response)=>{proxyCalls++;response.end('private');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>other.listen(0,'127.0.0.1',resolve));
const port=server.address().port,otherPort=other.address().port;
process.env.HTTP_PROXY=process.env.http_proxy='http://127.0.0.1:'+otherPort;
try {
  assert.equal(await windowsGuiStatus(port),'READY');
  for(const setting of ['shape','large','redirect']){mode=setting;assert.equal(await windowsGuiStatus(port),'UNVERIFIED');}
  mode='false';assert.equal(await windowsGuiStatus(port),'NOT_READY');
  mode='boundary';assert.equal(await windowsGuiStatus(port),'READY');
  mode='stall';assert.equal(await windowsGuiStatus(port),'NO_RESPONSE');
  assert.equal(await windowsGuiStatus(0),'UNVERIFIED');
  mode='ready';let checks=0;
  assert.deepEqual(await windowsGuiSessionHealth([port,otherPort],async()=>{checks++;}),{proxy:'READY',native:'UNVERIFIED'});
  assert.equal(checks,2);assert.equal(proxyCalls,1);
  const before=calls;assert.deepEqual(await windowsGuiSessionHealth([port,otherPort],async()=>{throw Error('private');}),{proxy:'UNVERIFIED',native:'UNVERIFIED'});
  assert.equal(calls,before);
  checks=0;assert.deepEqual(await windowsGuiSessionHealth([port,otherPort],async()=>{if(++checks===2)throw Error('retired');}),{proxy:'UNVERIFIED',native:'UNVERIFIED'});
  assert.equal(checks,2);
  console.info('BOUNDED_HEALTH');
} finally {for(const endpoint of [server,other]){endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));}}
`],{...process.env,LAZYSH_GUI_CONTRACT_MODULE:new URL('../.changeset/windows-installed-gui.ts',import.meta.url).href},10000);
  expect(result).toBe('BOUNDED_HEALTH');
},15000);
test('Windows health labels retain primary and cleanup errors while rejecting untrusted suffixes',()=>{
  const base='gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:UNKNOWN_CLASS';
  for(const proxy of ['READY','NOT_READY','NO_RESPONSE','UNVERIFIED'])for(const native of ['READY','NOT_READY','NO_RESPONSE','UNVERIFIED']){
    const label=base+':HEALTH_'+proxy+'_NATIVE_'+native;
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+label+'\nLAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP\nLAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED')).toBe(label+'; gui:GUI_CLEANUP; cleanup:UNEXPECTED');
  }
  for(const label of [base+':HEALTH_PRIVATE_NATIVE_READY',base+':HEALTH_READY_NATIVE_READY raw','gui:GUI_OWNER:HEALTH_READY_NATIVE_READY','install:BINARY_MISMATCH:HEALTH_READY_NATIVE_READY']){
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+label)).toBeUndefined();
  }
});
test('Windows session and owned-window diagnostics expose only the finite outcomes', () => {
  for (const code of windowsGuiSessionGuards) {
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:'+code)).toBe('gui:'+code);
  }
  for (const code of ['GUI_SESSION_CLIENT_TIMEOUT_WINDOW_MISSING','GUI_SESSION_PRIVATE_WINDOW_VERIFIED',
    'GUI_SESSION_NOT_CREATED_WINDOW_VERIFIED private path','GUI_SESSION_NOT_CREATED_WINDOW_VERIFIED:private']) {
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:'+code)).toBeUndefined();
  }
});
test('owned Windows framework metadata projects exact bounded records and rejects private or malformed fields',()=>{
  const row={className:'app.lazysh.client-sic',style:4294967295,exstyle:0,width:-100000,height:100000,clientWidth:-100000,clientHeight:100000,ownerless:false};
  const value={available:true,overflow:false,windows:[row]};
  expect(parseWindowsGuiMetadata(value)).toEqual(value);
  expect(parseWindowsGuiMetadata({available:false})).toEqual({available:false});
  expect(parseWindowsGuiMetadata({...value,overflow:true,windows:Array(8).fill(row)})).toMatchObject({windows:Array(8).fill(row)});
  expect(parseWindowsGuiMetadata({...value,windows:[{...row,className:'A'.repeat(128)}]}).available).toBe(true);
  const bad:unknown[]=[null,{},[],{available:false,windows:[]},{...value,title:'private'},{...value,overflow:1},{...value,overflow:true},{...value,windows:Array(9).fill(row)}];
  for(const change of [{title:'private'},{pid:1},{window:'123'},{path:'private'}, {className:''},{className:'A'.repeat(129)},
    {className:'private/path'},{className:'private\\path'},{className:'nonasciié'},{className:'name\n'},{className:'name\u0000'},
    {style:-1},{style:4294967296},{style:0.5},{exstyle:'0'},{exstyle:NaN},{width:-100001},{height:100001},{height:Infinity},{height:0.5},{clientWidth:-100001},{clientHeight:100001},{clientWidth:'0'},{clientHeight:0.5},{ownerless:'true'}])bad.push({...value,windows:[{...row,...change}]});
  for(const value of bad)expect(()=>parseWindowsGuiMetadata(value)).toThrow('Invalid owned Windows GUI framework metadata');
  const marker='LAZYSH_WINDOWS_GUI_METADATA:'+JSON.stringify(value);
  expect(windowsGuiMetadataProjection('private raw output\n'+marker)).toBe(JSON.stringify(value));
  for(const output of [marker+'\n'+marker,'LAZYSH_WINDOWS_GUI_METADATA:private','LAZYSH_WINDOWS_GUI_METADATA:'+JSON.stringify({...value,private:'secret'}),'LAZYSH_WINDOWS_GUI_METADATA:'+JSON.stringify({...value,windows:[{...row,className:'name\n'}]})]){
    expect(windowsGuiMetadataProjection(output)).toBeUndefined();
  }
  expect(windowsGuiMetadataProjection(marker+' '.repeat(4096))).toBeUndefined();
  expect(windowsGuiMetadataProjection(' '.repeat(2097153)+marker)).toBeUndefined();
  const phase='LAZYSH_WINDOWS_GUI_PROBE:UNKNOWN_CLASS:ROLES_1024';
  expect(windowsGuiProbeDiagnostic(phase+'\n'+marker)).toEqual({phase:'UNKNOWN_CLASS',roleMask:1024,metadata:value});
  expect(windowsGuiProbeDiagnostic(phase+'\nLAZYSH_WINDOWS_GUI_METADATA:malformed')).toEqual({phase:'UNKNOWN_CLASS',roleMask:1024,metadata:{available:false}});
});
test('Windows startup projection admits only bounded signed runtime group evidence and strict versions',()=>{
  const value=startupFixture();
  expect(parseWindowsGuiStartup(value)).toEqual(value); // Loaded runtime may differ: retain evidence, do not normalize it.
  expect(parseWindowsGuiStartup({available:false,overflow:true,signature:'UNVERIFIED'})).toEqual({available:false,overflow:true,signature:'UNVERIFIED'});
  expect(parseWindowsGuiStartup({...value,observedProcesses:0,observedRootGroups:0,rootImageVersions:[],rootDebugTransports:[],signature:'NONE_OBSERVED'}).available).toBe(true);
  expect(parseWindowsGuiStartup({...value,observedProcesses:32,observedRootGroups:32,rootImageVersions:Array.from({length:32},(_,i)=>'1.0.0.'+(i+1)),rootDebugTransports:Array.from({length:32},()=>({role:'BROWSER_CANDIDATE',transport:'ABSENT'}))}).available).toBe(true);
  for(const transport of ['PIPE','EPHEMERAL_PORT','FIXED_PORT','ABSENT','AMBIGUOUS','UNVERIFIED'])expect(parseWindowsGuiStartup({...value,rootDebugTransports:[{role:'BROWSER_CANDIDATE',transport}]}).available).toBe(true);
  expect(parseWindowsGuiStartup({...value,observedRootGroups:3,rootDebugTransports:[{role:'TYPED_CHILD',transport:'ABSENT'},{role:'BROWSER_CANDIDATE',transport:'PIPE'},{role:'AMBIGUOUS',transport:'UNVERIFIED'}]})).toMatchObject({rootDebugTransports:[{role:'AMBIGUOUS',transport:'UNVERIFIED'},{role:'BROWSER_CANDIDATE',transport:'PIPE'},{role:'TYPED_CHILD',transport:'ABSENT'}]});
  for(const role of ['BROWSER_CANDIDATE','TYPED_CHILD','AMBIGUOUS','UNVERIFIED'])expect(parseWindowsGuiStartup({...value,rootDebugTransports:[{role,transport:'ABSENT'}]}).available).toBe(true);
  const bad:unknown[]=[null,{},[],{...value,rootDebugTransports:null},{...value,rootDebugTransports:[null]},{...value,rootDebugTransports:'PIPE'},{available:false,overflow:false,signature:'UNVERIFIED',pid:1}];
  for(const change of [{rootDebugTransports:[{role:'renderer',transport:'ABSENT'}]},{rootDebugTransports:[{role:'TYPED_CHILD',transport:'9222'}]},{rootDebugTransports:[{role:'TYPED_CHILD',transport:'ABSENT',type:'renderer'}]},{rootDebugTransports:[{role:'TYPED_CHILD'}]},{rootDebugTransports:[{transport:'PIPE'}]},{rootDebugTransports:[]},{rootDebugTransports:['9222']},{rootDebugTransports:['PIPE','ABSENT']},{rootDebugTransports:['private/path']},{pid:1},{path:'private'},{args:'private'},{profile:'private'},{overflow:true},{observedProcesses:33},{observedProcesses:-1},{observedProcesses:0.5},{observedRootGroups:4},{observedRootGroups:0},{signature:'Valid'},{rootImageVersions:[]},{rootImageVersions:['1.2.3.4','1.2.3.4']},{observerEnvPresence:{...value.observerEnvPresence,userDataFolder:'private'}}])bad.push({...value,...change});
  for(const version of ['0.0.0.0','01.2.3.4','1.2.3.65536','1.2.3.4 suffix','1.2.3.4\n','1.2.3','private/path']){
    bad.push({...value,registeredRuntimeVersion:version},{...value,edgeDriverVersion:version},{...value,rootImageVersions:[version]});
  }
  for(const entry of bad)expect(()=>parseWindowsGuiStartup(entry)).toThrow('Invalid owned Windows GUI startup snapshot');
});
test('startup diagnostics cannot replace emitted core ownership or rejection when unavailable or truncated',()=>{
  const core=JSON.stringify({pid:1,start:'2',window:'3',sha256:'a'.repeat(64)}),snapshot=startupFixture();
  const marker='LAZYSH_WINDOWS_GUI_STARTUP:'+JSON.stringify(snapshot);
  const projected=windowsGuiStartupProbe(core+'\n'+marker);
  expect(parseWindowsGuiOwner(projected.core,'a'.repeat(64)).window).toBe('3');expect(projected.startup).toEqual(snapshot);
  // A timeout/error after core emission leaves the already completed original proof intact.
  expect(windowsGuiStartupProbe(core)).toEqual({core});
  for(const suffix of ['LAZYSH_WINDOWS_GUI_STARTUP:malformed',marker+' '.repeat(4096),marker+'\n'+marker]){
    expect(windowsGuiStartupProbe(core+'\n'+suffix)).toEqual({core,startup:{available:false,overflow:false,signature:'UNVERIFIED'}});
  }
  const rejection='LAZYSH_WINDOWS_GUI_PROBE:UNKNOWN_CLASS:ROLES_1024';
  const partial=windowsGuiStartupProbe(rejection+'\nLAZYSH_WINDOWS_GUI_STARTUP:malformed');
  expect(windowsGuiProbeDiagnostic(partial.core)).toEqual({phase:'UNKNOWN_CLASS',roleMask:1024});
  expect(partial.startup).toEqual({available:false,overflow:false,signature:'UNVERIFIED'});
});
test('Windows role masks project only exact finite subsets and preserve session plus cleanup failures',()=>{
  expect(windowsGuiRoleReasons).toEqual(['ROLE_DATA_UNVERIFIED','MAIN_OWNER_MISMATCH','MAIN_GEOMETRY_MISMATCH','MAIN_STYLE_MISMATCH','MAIN_EXSTYLE_MISMATCH','TAO_OWNER_MISMATCH','TAO_GEOMETRY_MISMATCH','TAO_STYLE_CLIPSIBLINGS_ONLY','TAO_STYLE_MISMATCH','TAO_EXSTYLE_MISMATCH','UNKNOWN_CLASS']);
  for(let mask=1;mask<=2047;mask++){
    const expected=windowsGuiRoleReasons.filter((_,index)=>Boolean(mask & (1<<index)));
    const phase=expected.length===1?expected[0]:'MULTIPLE_ROLE_MISMATCHES';
    expect(windowsGuiRoleSubset(phase,mask)).toEqual(expected);
    expect(windowsGuiProbeDiagnostic('LAZYSH_WINDOWS_GUI_PROBE:'+phase+':ROLES_'+mask)).toEqual({phase,roleMask:mask});
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:'+phase+':ROLES_'+mask)).toBe('gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:'+phase+':ROLES_'+expected.join('+'));
  }
  const label='gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:MULTIPLE_ROLE_MISMATCHES:ROLES_144:HEALTH_READY_NATIVE_READY';
  expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+label+'\nLAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP\nLAZYSH_WINDOWS_INSTALLER:cleanup:UNEXPECTED')).toBe('gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:MULTIPLE_ROLE_MISMATCHES:ROLES_MAIN_EXSTYLE_MISMATCH+TAO_STYLE_CLIPSIBLINGS_ONLY:HEALTH_READY_NATIVE_READY; gui:GUI_CLEANUP; cleanup:UNEXPECTED');
  for(const [phase,mask] of [['UNKNOWN_CLASS',0],['UNKNOWN_CLASS',1024.5],['UNKNOWN_CLASS','1024'],['UNKNOWN_CLASS',2048],['UNKNOWN_CLASS',2049],['UNKNOWN_CLASS',2047],['MULTIPLE_ROLE_MISMATCHES',1024],['WINDOW_UNVERIFIED',144],['PRIVATE',144]]){
    expect(windowsGuiRoleSubset(phase as string,mask)).toBeUndefined();
  }
  for(const suffix of ['UNKNOWN_CLASS:ROLES_0','UNKNOWN_CLASS:ROLES_01024','UNKNOWN_CLASS:ROLES_1024.0','UNKNOWN_CLASS:ROLES_-1','UNKNOWN_CLASS:ROLES_2048','MULTIPLE_ROLE_MISMATCHES:ROLES_1024','WINDOW_UNVERIFIED:ROLES_144','MULTIPLE_ROLE_MISMATCHES:ROLES_144 raw','MULTIPLE_ROLE_MISMATCHES:ROLES_144:ROLES_144']){
    expect(windowsGuiProbeDiagnostic('LAZYSH_WINDOWS_GUI_PROBE:'+suffix)).toEqual({phase:'PROBE_UNVERIFIED'});
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_UNVERIFIED:'+suffix)).toBeUndefined();
  }
  for(const prefix of ['install:BINARY_MISMATCH','gui:GUI_OWNER','gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED']){
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+prefix+':MULTIPLE_ROLE_MISMATCHES:ROLES_144')).toBeUndefined();
  }
});
test('Windows probe phases never turn unknown output or probe errors into candidate absence', () => {
  for (const phase of windowsGuiProbePhases) {
    expect(windowsGuiProbeDiagnostic('LAZYSH_WINDOWS_GUI_PROBE:'+phase).phase).toBe(phase);
    const marker='LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:'+phase;
    expect(windowsInstallerFailure(marker)).toBe('gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:'+phase);
  }
  for (const output of [undefined, 'private native exception', 'LAZYSH_WINDOWS_GUI_PROBE:MISSING',
    'LAZYSH_WINDOWS_GUI_PROBE:EXPECTED_IMAGE_CANDIDATE_ABSENT private path',
    'LAZYSH_WINDOWS_GUI_PROBE:WINDOW_UNVERIFIED\nLAZYSH_WINDOWS_GUI_PROBE:EXPECTED_IMAGE_CANDIDATE_ABSENT']) {
    expect(windowsGuiProbeDiagnostic(output).phase).toBe('PROBE_UNVERIFIED');
  }
  for (const marker of [
    'gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:MISSING',
    'gui:GUI_SESSION_NO_RESPONSE_WINDOW_VERIFIED:EXPECTED_IMAGE_CANDIDATE_ABSENT',
    'cleanup:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:EXPECTED_IMAGE_CANDIDATE_ABSENT',
    'gui:GUI_OWNER:EXPECTED_IMAGE_CANDIDATE_ABSENT',
    'gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:WINDOW_UNVERIFIED private path']) {
    expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+marker)).toBeUndefined();
  }
  expect(windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:OWNED_INVENTORY_UNVERIFIED\nLAZYSH_WINDOWS_INSTALLER:gui:GUI_CLEANUP\nLAZYSH_WINDOWS_INSTALLER:cleanup:UNINSTALL_BINARY'))
    .toBe('gui:GUI_SESSION_NO_RESPONSE_WINDOW_UNVERIFIED:OWNED_INVENTORY_UNVERIFIED; gui:GUI_CLEANUP; cleanup:UNINSTALL_BINARY');
});
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
