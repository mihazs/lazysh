import {windowsStandardInstallation,windowsStandardUserSource,standardOwnerCode,insideStandardRoot,copyStandardClosure,parseStandardReceipt,standardWorkerEnvironment,standardBrokerScript} from '../.changeset/windows-standard-user';
import {english} from '../apps/client/src/i18n/en';
import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, mkdir, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePackages, artifactName, artifactTargets, releaseTargets, digestFile, stagePackages,
  validateReceipt, releaseNotes, type ArtifactTarget } from '../.changeset/release-artifacts';
import { signingProfiles, iosBundleIds } from '../.changeset/release-apple';
import { javaProperty } from '../.changeset/release-android';
import { publishInstallationSet } from '../.changeset/release-publish';
import { exactlyOne, native, windowsInstallation, windowsInstallerFailure, windowsGuiCounterfactual, windowsGuiMediumOutcome, windowsNsisBinaryDigest } from '../.changeset/release-platform';
import { windowsGuiDaclFailures, windowsGuiSessionNonzero, parseWindowsGuiOwner, windowsGuiCapabilities, windowsInstallerPathsScript, windowsInstalledGuiScript, isWindowsGuiDriverReceipt, windowsGuiToolEnvironment, windowsGuiSessionResponse, windowsGuiSessionNoResponse, windowsGuiSessionGuards, windowsGuiProbePhases, windowsGuiRoleReasons, windowsGuiRoleSubset, windowsGuiProbeDiagnostic, windowsGuiWindowRoleScript, windowsGuiHealthOwnershipScript, windowsGuiEndpointsScript, windowsGuiMetadataScript, parseWindowsGuiMetadata, windowsGuiMetadataProjection, windowsGuiOverrideNames, windowsGuiFrontendReasons, windowsGuiStartupScript, windowsGuiDebugTransportScript, windowsGuiIntegrityScript, windowsGuiAccessibilitySource, windowsGuiMediumSource, windowsGuiTokenReasons, windowsGuiLaunchErrors, windowsGuiMediumScript, parseWindowsGuiStartup, windowsGuiStartupProbe } from '../.changeset/windows-installed-gui';
import type { ReleasePolicy } from '../.changeset/release-tag';

const launchFailureDetails=['CREATE_PROCESS_WITH_TOKEN','RESUME_THREAD'].flatMap(call=>windowsGuiLaunchErrors.map(error=>call+':'+error)).concat('RESUME_THREAD:RESUME_COUNT_UNEXPECTED');
const mediumAdmissionResults=['ADMITTED_LINKED','ADMITTED_RESTRICTED','PORTABLE_CONTRACT','UNVERIFIED','CLEANUP_UNVERIFIED',
  ...['PROBE','DRIVER'].flatMap(role=>launchFailureDetails.map(detail=>'UNAVAILABLE_LAUNCH_UNAVAILABLE:'+role+':'+detail)),
  ...windowsGuiTokenReasons.map(reason=>'UNAVAILABLE_TOKEN_UNAVAILABLE:'+reason),
  ...['TOKEN_UNAVAILABLE','DESKTOP_UNAVAILABLE','JOB_UNAVAILABLE','STDIO_UNAVAILABLE','LAUNCH_UNAVAILABLE','ARGV_BOUND','ENVIRONMENT_BOUND','IDENTITY_UNVERIFIED'].map(code=>'UNAVAILABLE_'+code)];
const mediumAdmissionResult=(value:unknown)=>typeof value==='string'&&mediumAdmissionResults.includes(value)?value:'UNVERIFIED';
const counterprobePrefix='LAZYSH_MEDIUM_COUNTERPROBE:';
// Creation-only failures admit only the current Win32Failure mapping, independently of resume labels.
const counterprobeDenied=['ACCESS_DENIED','INVALID_HANDLE','INVALID_PARAMETER','PRIVILEGE_NOT_HELD','FILE_NOT_FOUND','PATH_NOT_FOUND','BAD_EXE_FORMAT','DIRECTORY','OTHER'];
const creationUnavailableResults=['UNAVAILABLE_JOB','UNAVAILABLE_IDENTITY','UNAVAILABLE_TOKEN','UNAVAILABLE_INPUT'];
const counterprobeResults=['NOT_RUN_BUDGET','CREATED_RETIRED',...creationUnavailableResults,'UNAVAILABLE_OTHER','CLEANUP_UNVERIFIED',...counterprobeDenied.map(error=>'DENIED:'+error)];
const asUserPrefix='LAZYSH_MEDIUM_ASUSER:';
const asUserResults=['NOT_RUN_BUDGET','NOT_RUN_QUOTA','CREATED_RETIRED',...creationUnavailableResults,'UNVERIFIED','CLEANUP_UNVERIFIED',...counterprobeDenied.map(error=>'DENIED:'+error)];
const daclPrefix='LAZYSH_MEDIUM_DACL:';
const daclNames=['imageReadExecute','cwdTraverse','cwdCreateFile','stationReadAttributes','desktopCreateReadWrite'];
const probeDenial='UNAVAILABLE_LAUNCH_UNAVAILABLE:PROBE:CREATE_PROCESS_WITH_TOKEN:ACCESS_DENIED';
function mediumAdmissionObservation(value:unknown){
  const unknown={result:'UNVERIFIED',counterprobe:'UNVERIFIED'};
  if(typeof value!=='string'||value.length>1024)return unknown;
  const lines=value.split(/\r?\n/);
  if(lines.length===1)return {result:mediumAdmissionResult(value)};
  const result=mediumAdmissionResult(lines.at(-1));
  const rejected=result==='CLEANUP_UNVERIFIED'?{result,counterprobe:'UNVERIFIED'}:unknown;
  if(![2,3,4].includes(lines.length)||!lines[0].startsWith(counterprobePrefix))return rejected;
  const detail=lines[0].slice(counterprobePrefix.length),separator=detail.indexOf(':');
  const kind=detail.slice(0,separator),outcome=detail.slice(separator+1);
  if(!['LINKED','RESTRICTED'].includes(kind)||!counterprobeResults.includes(outcome)||![probeDenial,'CLEANUP_UNVERIFIED'].includes(result)
    ||(outcome==='CLEANUP_UNVERIFIED'&&result!=='CLEANUP_UNVERIFIED'))return rejected;
  const base={result,counterprobe:{kind,outcome}};
  const paired=outcome==='DENIED:ACCESS_DENIED'||(outcome==='CLEANUP_UNVERIFIED'&&result==='CLEANUP_UNVERIFIED');
  const details=lines.slice(1,-1);
  let dacl;
  if(details[0]?.startsWith(daclPrefix)){
    const fields=details.shift()!.slice(daclPrefix.length).split(':');
    if(fields.length!==6||fields[0]!==kind||!paired||fields.slice(1).some(value=>!['ALLOWS','DENIES','UNVERIFIED'].includes(value)))return rejected;
    dacl={kind,...Object.fromEntries(daclNames.map((name,index)=>[name,fields[index+1]]))};
  }
  let asUser;
  if(details.length){
    const line=details.shift()!,prefix=asUserPrefix+'RESTRICTED:',value=line.slice(prefix.length);
    if(!line.startsWith(prefix)||kind!=='RESTRICTED'||!paired||!asUserResults.includes(value)||(value==='CLEANUP_UNVERIFIED'&&result!=='CLEANUP_UNVERIFIED'))return rejected;
    asUser={kind,outcome:value};
  }
  if(details.length)return rejected;
  return {...base,...(dacl?{dacl}:{}),...(asUser?{asUser}:{})};
}

function highGuiEvidenceEligible(value:unknown){
  const observed=mediumAdmissionObservation(value);
  return observed.result===probeDenial&&typeof observed.counterprobe==='object'&&observed.counterprobe.kind==='RESTRICTED'&&observed.counterprobe.outcome==='DENIED:ACCESS_DENIED'
    &&'asUser' in observed&&observed.asUser?.kind==='RESTRICTED'&&observed.asUser.outcome==='DENIED:PRIVILEGE_NOT_HELD'
    &&'dacl' in observed&&observed.dacl?.kind==='RESTRICTED'&&daclNames.every(name=>observed.dacl?.[name]==='ALLOWS');
}

const startupFixture=()=>({available:true,overflow:false,appElevation:'UNVERIFIED',appIntegrity:'UNVERIFIED',signature:'MICROSOFT',observedProcesses:3,observedRootGroups:1,registeredRuntimeVersion:'154.0.1000.1',edgeDriverVersion:'154.0.1000.1',rootImageVersions:['155.0.1001.2'],rootDebugTransports:[{role:'BROWSER_CANDIDATE',transport:'EPHEMERAL_PORT'}],observerEnvPresence:Object.fromEntries(Object.keys(windowsGuiOverrideNames).map(key=>[key,false]))});
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
  const script = windowsGuiWindowRoleScript + windowsGuiDebugTransportScript + windowsGuiIntegrityScript + String.raw`
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
if ((GuiAppIntegrity -1 '1') -cne 'UNVERIFIED' -or !('OwnedGuiIntegrity' -as [type])) { throw 'integrity helper did not compile safely' }
foreach ($case in @(@{Rid=0x1000;Code='LOW'},@{Rid=0x2000;Code='MEDIUM'},@{Rid=0x3000;Code='HIGH'},@{Rid=0x4000;Code='SYSTEM'},@{Rid=0x2100;Code='UNVERIFIED'},@{Rid=0x5000;Code='UNVERIFIED'})) {
  [byte[]]$sid=@(1,1,0,0,0,0,0,16)+[BitConverter]::GetBytes([uint32]$case.Rid)
  if ([OwnedGuiIntegrity]::Classify($sid,0) -cne $case.Code -or [OwnedGuiIntegrity]::Classify($sid,5) -cne 'UNVERIFIED') { throw 'mandatory-label or denied-query classification' }
}
foreach ($sid in @($null,[byte[]]@(1,1,0,0,0,0,0,16,0,16,0),[byte[]]@(2,1,0,0,0,0,0,16,0,16,0,0),[byte[]]@(1,2,0,0,0,0,0,16,0,16,0,0),[byte[]]@(1,1,0,0,0,0,0,5,0,16,0,0))) {
  if ([OwnedGuiIntegrity]::Classify($sid,0) -cne 'UNVERIFIED') { throw 'unknown SID admitted' }
}
if ($IsWindows) {
  $owned=Get-Process -Id $PID;$start=$owned.StartTime.ToUniversalTime().Ticks.ToString()
  if ((GuiAppIntegrity $PID $start) -cnotin @('LOW','MEDIUM','HIGH','SYSTEM')) { throw 'owned token query failed' }
  if ((GuiAppIntegrity $PID ([long]$start+1L).ToString()) -cne 'IDENTITY_UNVERIFIED') { throw 'different process lifetime admitted' }
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
test('Windows restricted-context projection requires exact observed medium non-elevated application evidence',()=>{
  const prefix='LAZYSH_WINDOWS_GUI_MEDIUM:',startupPrefix='LAZYSH_WINDOWS_GUI_MEDIUM_STARTUP:';
  const startup={...startupFixture(),appIntegrity:'MEDIUM',appElevation:'NOT_ELEVATED'};
  const passed=prefix+'PASSED\n'+startupPrefix+JSON.stringify(startup);
  expect(windowsGuiMediumOutcome(passed)).toEqual({outcome:'PASSED',startup});
  for(const value of [prefix+'PASSED',passed+'\n'+prefix+'PASSED',passed+'\nLAZYSH_WINDOWS_GUI_MEDIUM_METADATA:{}',passed.replace('NOT_ELEVATED','ELEVATED'),passed.replace('MEDIUM"','HIGH"'),passed.replace('NOT_ELEVATED','private')])expect(windowsGuiMediumOutcome(value)).toEqual({outcome:'UNVERIFIED'});
  expect(windowsGuiMediumOutcome(prefix+'NOT_AVAILABLE')).toEqual({outcome:'NOT_AVAILABLE'});
  expect(windowsGuiMediumOutcome(prefix+'NOT_AVAILABLE\n'+startupPrefix+JSON.stringify(startup))).toEqual({outcome:'UNVERIFIED'});
  expect(windowsGuiMediumOutcome(prefix+'gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY\n'+startupPrefix+JSON.stringify(startup))).toEqual({outcome:'REJECTED',rejection:'gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY',startup});
  expect(windowsGuiMediumOutcome(prefix+'gui:GUI_MEDIUM_UNAVAILABLE\n'+prefix+'gui:GUI_CLEANUP')).toEqual({outcome:'REJECTED',rejection:'gui:GUI_MEDIUM_UNAVAILABLE; gui:GUI_CLEANUP'});
});
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1').each([
  ['passed','PASSED'],['cleanup','NOT_RUN_CLEANUP'],['budget','NOT_RUN_BUDGET'],['image','REJECTED'],['tool','REJECTED'],['rejected','REJECTED'],['treatment-cleanup','REJECTED'],['medium-unavailable','PASSED'],['medium-admitted','PASSED'],['medium-cleanup','PASSED'],
])('actual Windows GUI endpoint counterfactual retains primary failure: %s',(name,outcome)=>fixture(async root=>{
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
function ExerciseInstalledGui([switch]$counterfactual,[switch]$medium) {
  if (!$counterfactual) { throw 'treatment not explicitly selected' }
  $script:called++
  if ($medium) {
    $script:failure='GUI_MEDIUM_UNAVAILABLE'
    if ($env:LAZYSH_COUNTER_CASE -eq 'medium-unavailable') { Require $false 'GUI_MEDIUM_UNAVAILABLE' }
    $script:mediumAdmitted=$true
    if ($env:LAZYSH_COUNTER_CASE -eq 'medium-cleanup') { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM:gui:GUI_CLIENT');Require $false 'GUI_CLEANUP' }
    Require $false 'GUI_CLIENT'
  }
  if ($env:LAZYSH_COUNTER_CASE.StartsWith('medium-')) { $script:capCleanupVerified=$true }
  if ($env:LAZYSH_COUNTER_CASE -eq 'rejected') { Require $false 'GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY' }
  if ($env:LAZYSH_COUNTER_CASE -eq 'treatment-cleanup') { Require $false 'GUI_CLEANUP' }
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:PASSED')
}
if ($env:LAZYSH_COUNTER_CASE -eq 'image') { $env:LAZYSH_NSIS_BINARY_SHA256='0'*64 }
if ($env:LAZYSH_COUNTER_CASE -eq 'tool') { $env:LAZYSH_GUI_EDGE_SHA256='0'*64 }
if ($env:LAZYSH_COUNTER_CASE -ceq 'passed') {
  $env:LAZYSH_TEST_WINDOWS_HIGH_EVIDENCE='1'
  GuiCounterfactual $baseline
  if ($script:called -ne 0 -or $script:failure -cne $baseline) { throw 'HIGH evidence ran a counterfactual or changed the primary failure' }
  $env:LAZYSH_TEST_WINDOWS_HIGH_EVIDENCE='0'
}
[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:'+$baseline)
GuiCounterfactual $baseline
if ($script:failure -cne $baseline -or $script:called -ne $(if ($env:LAZYSH_COUNTER_CASE -like 'medium-*') {2} elseif ($env:LAZYSH_COUNTER_CASE -in @('passed','rejected','treatment-cleanup')) {1} else {0})) { throw 'baseline or admission changed' }
exit 1
`;
  const env={...process.env,LAZYSH_TEST_WINDOWS_HIGH_EVIDENCE:'0',LAZYSH_COUNTER_CASE:name,LAZYSH_GUI_BINARY:image,LAZYSH_NSIS_BINARY_SHA256:expected.sha256,LAZYSH_GUI_DRIVER:image,LAZYSH_GUI_EDGE:image,LAZYSH_GUI_DRIVER_SHA256:expected.sha256,LAZYSH_GUI_EDGE_SHA256:expected.sha256};
  const pending=native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],env,30000);
  await expect(pending).rejects.toThrow(`Release validation failed: pwsh.exe (gui:${baseline})\nOwned Windows GUI counterfactual: {"outcome":"${outcome}"`);
  if(name.startsWith('medium-'))await expect(pending).rejects.toThrow('Owned Windows GUI medium context: '+JSON.stringify(name==='medium-unavailable'?{outcome:'NOT_AVAILABLE'}:{outcome:'REJECTED',rejection:name==='medium-cleanup'?'gui:GUI_CLIENT; gui:GUI_CLEANUP':'gui:GUI_CLIENT'}));
}));
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1').each([
  'gui:GUI_CLIENT','gui:GUI_SESSION_CLIENT_TIMEOUT_WINDOW_VERIFIED:HEALTH_READY_NATIVE_READY\nLAZYSH_WINDOWS_INSTALLER:cleanup:LOCAL_DATA',
])('actual Windows GUI endpoint terminal projection retains rejection: %j',async label=>{
  const rejected=`[Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:${label}');[Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:PASSED');exit 1`;
  await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',rejected],process.env,30000)).rejects.toMatchObject({message:'Release validation failed: pwsh.exe ('+label.replace('\nLAZYSH_WINDOWS_INSTALLER:','; ')+')'});
});
test('restricted Windows admission reports only exact finite smoke results',()=>{
  for(const result of mediumAdmissionResults)expect(mediumAdmissionResult(result)).toBe(result);
  for(const value of [undefined,null,42,{},'','private path','UNAVAILABLE_PRIVATE','UNAVAILABLE_LAUNCH_UNAVAILABLE:PRIVATE:CREATE_PROCESS_WITH_TOKEN:ACCESS_DENIED','UNAVAILABLE_LAUNCH_UNAVAILABLE:PROBE:CREATE_PROCESS_WITH_TOKEN:RESUME_COUNT_UNEXPECTED','UNAVAILABLE_LAUNCH_UNAVAILABLE:DRIVER:RESUME_THREAD:5','UNAVAILABLE_LAUNCH_UNAVAILABLE:PROBE:CREATE_PROCESS_WITH_TOKEN:OTHER private','UNAVAILABLE_TOKEN_UNAVAILABLE:PRIVATE','UNAVAILABLE_TOKEN_UNAVAILABLE:OWN_TOKEN_OPEN private','UNAVAILABLE_TOKEN_UNAVAILABLE private','ADMITTED_LINKED\nprivate','PORTABLE_CONTRACT\r',' UNVERIFIED','CLEANUP_UNVERIFIED\0'])expect(mediumAdmissionResult(value)).toBe('UNVERIFIED');
});
test('Windows required gate uses complete standard context and retains unconditional owned recovery',async()=>{
  const workflow=Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/checks.yml',import.meta.url)).text()) as any;
  const steps=workflow.jobs['native-desktop'].steps;
  expect(workflow.jobs['native-desktop']['continue-on-error']).toBeUndefined();
  expect(steps.find((step:any)=>step.id==='windows_restricted')).toBeUndefined();
  for(const id of ['native_build','credential_check','windows_package','windows_installer','windows_gui']){
    const step=steps.find((step:any)=>step.id===id);expect(step['continue-on-error']).toBeUndefined();
    expect(step.if).toBe(id.startsWith('windows_')?"runner.os == 'Windows'":undefined);
  }
  const contracts=steps.find((step:any)=>step.name==='Verify owned Windows launch contracts without creating accounts');
  expect(contracts.if).toBe("runner.os == 'Windows'");expect(contracts.env.LAZYSH_TEST_WINDOWS_GUI).toBe('1');expect(contracts['continue-on-error']).toBeUndefined();
  for(const owner of ['Windows launch portable contracts without process creation','owned UIA candidate contract','Windows standard broker portable'])expect(contracts.run).toContain(owner);
  const gui=steps.find((step:any)=>step.id==='windows_gui');expect(gui.env.LAZYSH_TEST_WINDOWS_HIGH_EVIDENCE).toBeUndefined();expect(gui['timeout-minutes']).toBe(12);
  const recovery=steps.find((step:any)=>step.run==='bun .changeset/windows-standard-user.ts --recover');expect(recovery.if).toBe("${{ always() && runner.os == 'Windows' }}");expect(recovery['continue-on-error']).toBeUndefined();
});

test('HIGH evidence continuation requires the complete safe-denial wire record',()=>{
  const lines=[counterprobePrefix+'RESTRICTED:DENIED:ACCESS_DENIED',daclPrefix+'RESTRICTED:'+Array(5).fill('ALLOWS').join(':'),asUserPrefix+'RESTRICTED:DENIED:PRIVILEGE_NOT_HELD',probeDenial];
  const complete=lines.join('\n');expect(highGuiEvidenceEligible(complete)).toBe(true);
  for(const index of lines.keys())expect(highGuiEvidenceEligible(lines.filter((_,i)=>i!==index).join('\n'))).toBe(false);
  for(const invalid of [undefined,null,{},complete+'\nprivate',complete+'\n'+probeDenial,complete.replaceAll('RESTRICTED','LINKED'),complete.replace('DENIED:ACCESS_DENIED','CREATED_RETIRED'),complete.replace('DENIED:PRIVILEGE_NOT_HELD','CREATED_RETIRED'),complete.replace('DENIED:PRIVILEGE_NOT_HELD','UNVERIFIED'),complete.replace(probeDenial,'CLEANUP_UNVERIFIED'),complete.replace(probeDenial,'ADMITTED_RESTRICTED')])expect(highGuiEvidenceEligible(invalid)).toBe(false);
  for(let index=0;index<5;index++)for(const value of ['DENIES','UNVERIFIED']){const changed=[...lines],values=Array(5).fill('ALLOWS');values[index]=value;changed[1]=daclPrefix+'RESTRICTED:'+values.join(':');expect(highGuiEvidenceEligible(changed.join('\n'))).toBe(false);}
});

test('AsUser comparison never replaces the baseline denial and projects only restricted creation outcomes',()=>{
  const prefix=counterprobePrefix+'RESTRICTED:DENIED:ACCESS_DENIED\n';
  for(const outcome of asUserResults){const result=outcome==='CLEANUP_UNVERIFIED'?'CLEANUP_UNVERIFIED':probeDenial;expect(mediumAdmissionObservation(prefix+asUserPrefix+'RESTRICTED:'+outcome+'\n'+result)).toEqual({result,counterprobe:{kind:'RESTRICTED',outcome:'DENIED:ACCESS_DENIED'},asUser:{kind:'RESTRICTED',outcome}})}
  for(const value of ['PRIVATE','DENIED:5','DENIED:RESUME_COUNT_UNEXPECTED','DENIED:UNVERIFIED','UNAVAILABLE_OTHER','UNAVAILABLE_PRIVATE','CREATED_RETIRED private','CLEANUP_UNVERIFIED'])expect(mediumAdmissionObservation(prefix+asUserPrefix+'RESTRICTED:'+value+'\n'+probeDenial)).toEqual({result:'UNVERIFIED',counterprobe:'UNVERIFIED'});
  for(const value of [prefix.replaceAll('RESTRICTED','LINKED')+asUserPrefix+'LINKED:CREATED_RETIRED',prefix.replace('DENIED:ACCESS_DENIED','CREATED_RETIRED')+asUserPrefix+'RESTRICTED:CREATED_RETIRED',prefix+asUserPrefix+'RESTRICTED:CREATED_RETIRED\n'+asUserPrefix+'RESTRICTED:CREATED_RETIRED'])expect(mediumAdmissionObservation(value+'\n'+probeDenial)).toEqual({result:'UNVERIFIED',counterprobe:'UNVERIFIED'});
  expect(mediumAdmissionObservation(prefix+asUserPrefix+'RESTRICTED:PRIVATE\nCLEANUP_UNVERIFIED')).toEqual({result:'CLEANUP_UNVERIFIED',counterprobe:'UNVERIFIED'});
  expect(mediumAdmissionObservation(counterprobePrefix+'RESTRICTED:CLEANUP_UNVERIFIED\n'+asUserPrefix+'RESTRICTED:CLEANUP_UNVERIFIED\nCLEANUP_UNVERIFIED')).toEqual({result:'CLEANUP_UNVERIFIED',counterprobe:{kind:'RESTRICTED',outcome:'CLEANUP_UNVERIFIED'},asUser:{kind:'RESTRICTED',outcome:'CLEANUP_UNVERIFIED'}});
  const dacl=daclPrefix+'RESTRICTED:'+Array(5).fill('ALLOWS').join(':');
  expect(mediumAdmissionObservation(prefix+dacl+'\n'+asUserPrefix+'RESTRICTED:CREATED_RETIRED\n'+probeDenial)).toMatchObject({result:probeDenial,asUser:{kind:'RESTRICTED',outcome:'CREATED_RETIRED'},dacl:{imageReadExecute:'ALLOWS'}});
});

test('fixed DACL observations retain only the five named checks after paired access denial',()=>{
  const prefix=counterprobePrefix+'RESTRICTED:DENIED:ACCESS_DENIED\n';
  const values=['ALLOWS','DENIES','UNVERIFIED','ALLOWS','DENIES'];
  const line=daclPrefix+'RESTRICTED:'+values.join(':');
  expect(mediumAdmissionObservation(prefix+line+'\n'+probeDenial)).toEqual({result:probeDenial,counterprobe:{kind:'RESTRICTED',outcome:'DENIED:ACCESS_DENIED'},dacl:{kind:'RESTRICTED',...Object.fromEntries(daclNames.map((name,index)=>[name,values[index]]))}});
  for(const invalid of [line+':ALLOWS',line.replace('RESTRICTED','LINKED'),line.replace('DENIES','private'),line.replace('ALLOWS',''),line+'\n'+line,'private'])expect(mediumAdmissionObservation(prefix+invalid+'\n'+probeDenial)).toEqual({result:'UNVERIFIED',counterprobe:'UNVERIFIED'});
  expect(mediumAdmissionObservation(prefix.replace('DENIED:ACCESS_DENIED','CREATED_RETIRED')+line+'\n'+probeDenial)).toEqual({result:'UNVERIFIED',counterprobe:'UNVERIFIED'});
  expect(mediumAdmissionObservation(prefix+line.replace('DENIES','private')+'\nCLEANUP_UNVERIFIED')).toEqual({result:'CLEANUP_UNVERIFIED',counterprobe:'UNVERIFIED'});
});

test('creation-only counterprobe results cannot replace the original denial or conceal cleanup uncertainty',()=>{
  for(const kind of ['LINKED','RESTRICTED'])for(const outcome of counterprobeResults){
    const result=outcome==='CLEANUP_UNVERIFIED'?'CLEANUP_UNVERIFIED':probeDenial;
    expect(mediumAdmissionObservation(counterprobePrefix+kind+':'+outcome+'\n'+result)).toEqual({result,counterprobe:{kind,outcome}});
    expect(['ADMITTED_LINKED','ADMITTED_RESTRICTED']).not.toContain(result);
  }
  for(const value of [counterprobePrefix+'LINKED:CREATED_RETIRED\nADMITTED_RESTRICTED',counterprobePrefix+'LINKED:CLEANUP_UNVERIFIED\n'+probeDenial,counterprobePrefix+'LINKED:PRIVATE\n'+probeDenial,counterprobePrefix+'LINKED:DENIED:5\n'+probeDenial,counterprobePrefix+'LINKED:DENIED:RESUME_COUNT_UNEXPECTED\n'+probeDenial,counterprobePrefix+'LINKED:DENIED:UNVERIFIED\n'+probeDenial,counterprobePrefix+'LINKED:CREATED_RETIRED private\n'+probeDenial,counterprobePrefix+'LINKED:CREATED_RETIRED\n'+counterprobePrefix+'LINKED:CREATED_RETIRED\n'+probeDenial,counterprobePrefix+'PRIVATE:CREATED_RETIRED\n'+probeDenial,counterprobePrefix+'UNVERIFIED:DENIED:ACCESS_DENIED\n'+probeDenial,counterprobePrefix+'linked:CREATED_RETIRED\n'+probeDenial,'private\n'+probeDenial])expect(mediumAdmissionObservation(value)).toEqual({result:'UNVERIFIED',counterprobe:'UNVERIFIED'});
  expect(mediumAdmissionObservation(probeDenial)).toEqual({result:probeDenial});
  expect(mediumAdmissionObservation(counterprobePrefix+'LINKED:PRIVATE\nCLEANUP_UNVERIFIED')).toEqual({result:'CLEANUP_UNVERIFIED',counterprobe:'UNVERIFIED'});
});
const windowsLaunchPortableContracts=String.raw`
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$classify=[OwnedMediumGui].GetMethod('Win32Failure',$flags)
foreach($case in @(@(5,'ACCESS_DENIED'),@(6,'INVALID_HANDLE'),@(87,'INVALID_PARAMETER'),@(1314,'PRIVILEGE_NOT_HELD'),@(2,'FILE_NOT_FOUND'),@(3,'PATH_NOT_FOUND'),@(193,'BAD_EXE_FORMAT'),@(267,'DIRECTORY'),@(0,'OTHER'),@(-1,'OTHER'),@([int]::MaxValue,'OTHER'))){
  if($classify.Invoke($null,@([int]$case[0])).ToString() -cne $case[1]){throw 'launch category not closed'}
}
$resume=[OwnedMediumGui].GetMethod('ResumeFailure',$flags)
foreach($case in @(@([uint32]::MaxValue,5,'ACCESS_DENIED'),@(0,5,'RESUME_COUNT_UNEXPECTED'),@(2,6,'RESUME_COUNT_UNEXPECTED'),@(1,87,'UNVERIFIED'))){
  if($resume.Invoke($null,@([uint32]$case[0],[int]$case[1])).ToString() -cne $case[2]){throw 'stale resume last-error used'}
}
foreach($field in @('launchCall','launchError')){
  $member=[OwnedMediumGui].GetField($field,$flags)
  $member.SetValue($null,[Enum]::Parse($member.FieldType,$(if($field -ceq 'launchCall'){'CREATE_PROCESS_WITH_TOKEN'}else{'ACCESS_DENIED'})))
}
$admission=[OwnedMediumGui].GetMethod('CounterprobeAdmission',$flags)
foreach($case in @(@('LAUNCH_UNAVAILABLE',30000L,'RUN'),@('LAUNCH_UNAVAILABLE',29999L,'NOT_RUN_BUDGET'),@('LAUNCH_UNAVAILABLE',100001L,'NOT_ELIGIBLE'),@('CLEANUP_UNVERIFIED',90000L,'NOT_ELIGIBLE'),@('TOKEN_UNAVAILABLE',90000L,'NOT_ELIGIBLE'))){
  if($admission.Invoke($null,@([string]$case[0],[long]$case[1])) -cne $case[2]){throw 'counterprobe admission changed'}
}
$callField=[OwnedMediumGui].GetField('launchCall',$flags)
$callField.SetValue($null,[Enum]::Parse($callField.FieldType,'RESUME_THREAD'))
if($admission.Invoke($null,@('LAUNCH_UNAVAILABLE',90000L)) -cne 'NOT_ELIGIBLE'){throw 'resume failure admitted counterprobe'}
$callField.SetValue($null,[Enum]::Parse($callField.FieldType,'CREATE_PROCESS_WITH_TOKEN'))
$errorField=[OwnedMediumGui].GetField('launchError',$flags)
$errorField.SetValue($null,[Enum]::Parse($errorField.FieldType,'INVALID_HANDLE'))
if($admission.Invoke($null,@('LAUNCH_UNAVAILABLE',90000L)) -cne 'NOT_ELIGIBLE'){throw 'different creation failure admitted counterprobe'}
# No native call or token exists: the real Start state guard must replace a prior rejection.
$reasonType=[OwnedMediumGui].GetNestedType('TokenReason',[Reflection.BindingFlags]::NonPublic)
$reject=[OwnedMediumGui].GetMethod('TokenReject',[Reflection.BindingFlags]'NonPublic,Static')
$null=$reject.Invoke($null,@([Enum]::Parse($reasonType,'CANDIDATE_ELEVATED')))
$empty=[Runtime.CompilerServices.RuntimeHelpers]::GetUninitializedObject([OwnedMediumGui])
$failed=$false
try {$null=$empty.Start('owned',[string[]]@(),'',[string]::new([char]0,2))}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'TOKEN_UNAVAILABLE'}
if(!$failed -or [OwnedMediumGui]::TokenFailure -cne 'LAUNCHER_STATE' -or [OwnedMediumGui]::LaunchFailure -cne 'UNVERIFIED:UNVERIFIED'){throw 'terminal token reason not preserved'}
$failed=$false
try{$null=$empty.StartProbe('owned',[string[]]@(),'',[string]::new([char]0,2),[Environment]::TickCount64+100000)}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'TOKEN_UNAVAILABLE'}
if(!$failed -or $empty.CounterprobeOutcome -cne 'NOT_ELIGIBLE'){throw 'ineligible probe changed primary failure'}
$failed=$false
try{$null=$empty.StartProbe('owned',[string[]]@(),'',[string]::new([char]0,2),[Environment]::TickCount64+100000)}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'PROBE_REPEATED'}
if(!$failed){throw 'repeated probe admitted'}
$word=[OwnedMediumGui].GetMethod('Word',[Reflection.BindingFlags]'NonPublic,Static')
foreach($kind in @(-1,0,1,2,3,19,25,27,[int]::MaxValue)){
  $failed=$false
  try{$null=$word.Invoke($null,@([IntPtr]::Zero,[int]$kind))}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'TOKEN_UNAVAILABLE'}
  if(!$failed -or [OwnedMediumGui]::TokenFailure -cne 'SCALAR_LAYOUT'){throw 'unsupported scalar class reached native API'}
}
$mapping=[OwnedMediumGui].GetMethod('DaclMapping',$flags)
foreach($case in @(@(1,0x120089,0x120116,0x1200a0,0x1f01ff),@(2,0x20303,0x2001c,0x20060,0xf037f),@(3,0x20041,0x200be,0x20100,0xf01ff))){
  $value=$mapping.Invoke($null,@([int]$case[0]));$index=1
  foreach($name in @('Read','Write','Execute','All')){if($value.$name -ne $case[$index]){throw 'SDK mapping changed'};$index++}
}
foreach($name in @('DaclMapping','DaclMask')){$failed=$false;try{$null=[OwnedMediumGui].GetMethod($name,$flags).Invoke($null,@(-1))}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'DACL_UNVERIFIED'};if(!$failed){throw 'unknown DACL selector admitted'}}
$mask=[OwnedMediumGui].GetMethod('DaclMask',$flags)
$expected=@(0x1200a9,0x20,2,2,0x83)
foreach($index in 0..4){if($mask.Invoke($null,@([int]$index)) -ne $expected[$index]){throw 'fixed DACL mask changed'}}
$result=[OwnedMediumGui].GetMethod('DaclResult',$flags)
foreach($case in @(@($false,$false,'UNVERIFIED'),@($false,$true,'UNVERIFIED'),@($true,$false,'DENIES'),@($true,$true,'ALLOWS'))){if($result.Invoke($null,@([bool]$case[0],[bool]$case[1])) -cne $case[2]){throw 'DACL result projected incorrectly'}}
$eligible=[OwnedMediumGui].GetMethod('DaclEligible',$flags)
foreach($case in @(@('DENIED:ACCESS_DENIED',30000L,$true),@('DENIED:ACCESS_DENIED',29999L,$false),@('DENIED:ACCESS_DENIED',100001L,$false),@('CREATED_RETIRED',90000L,$false),@('CLEANUP_UNVERIFIED',90000L,$false))){if($eligible.Invoke($null,@([string]$case[0],[long]$case[1])) -ne $case[2]){throw 'DACL admission changed'}}
$asAdmission=[OwnedMediumGui].GetMethod('AsUserAdmission',$flags)
foreach($case in @(@('RESTRICTED','DENIED:ACCESS_DENIED',30000L,'RUN'),@('RESTRICTED','DENIED:ACCESS_DENIED',29999L,'NOT_RUN_BUDGET'),@('RESTRICTED','DENIED:ACCESS_DENIED',100001L,'NOT_ELIGIBLE'),@('LINKED','DENIED:ACCESS_DENIED',90000L,'NOT_ELIGIBLE'),@('RESTRICTED','CREATED_RETIRED',90000L,'NOT_ELIGIBLE'),@('RESTRICTED','CLEANUP_UNVERIFIED',90000L,'NOT_ELIGIBLE'))){if($asAdmission.Invoke($null,@([string]$case[0],[string]$case[1],[long]$case[2])) -cne $case[3]){throw 'AsUser gate changed'}}
$launch=[OwnedMediumGui].GetMethod('Launch',[Reflection.BindingFlags]'NonPublic,Instance')
$failed=$false
try{$null=$launch.Invoke($empty,@('owned',[string[]]@(),'',[string]::new([char]0,2),$false,$true))}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'ASUSER_UNVERIFIED'}
if(!$failed){throw 'resumable AsUser mode admitted'}
[OwnedMediumGui].GetProperty('Kind').SetValue($empty,'LINKED')
[OwnedMediumGui].GetProperty('CounterprobeOutcome').SetValue($empty,'DENIED:ACCESS_DENIED')
$compare=[OwnedMediumGui].GetMethod('CompareAsUser',[Reflection.BindingFlags]'NonPublic,Instance')
$compare.Invoke($empty,@('owned',[string[]]@(),'',[string]::new([char]0,2),([Environment]::TickCount64+100000)))
if($empty.AsUserOutcome -cne 'NOT_ELIGIBLE'){throw 'linked token reached AsUser launch'}
[OwnedMediumGui].GetProperty('Kind').SetValue($empty,'RESTRICTED')
$compare.Invoke($empty,@('owned',[string[]]@(),'',[string]::new([char]0,2),[Environment]::TickCount64))
if($empty.AsUserOutcome -cne 'NOT_RUN_BUDGET'){throw 'expired AsUser comparison launched'}
$quotaPresent=[OwnedMediumGui].GetMethod('QuotaPresent',$flags)
foreach($case in @(@($true,0,$true),@($true,2,$true),@($true,4,$false),@($true,6,$false),@($false,0,$false),@($false,2,$false),@($true,[uint32]::MaxValue,$false))){if($quotaPresent.Invoke($null,@([bool]$case[0],[uint32]$case[1])) -ne $case[2]){throw 'removed quota admitted'}}
$asUnavailable=[OwnedMediumGui].GetMethod('AsUserUnavailable',$flags)
foreach($case in @(@('JOB_UNAVAILABLE','UNAVAILABLE_JOB'),@('IDENTITY_UNVERIFIED','UNAVAILABLE_IDENTITY'),@('TOKEN_UNAVAILABLE','UNAVAILABLE_TOKEN'),@('ARGV_BOUND','UNAVAILABLE_INPUT'),@('ENVIRONMENT_BOUND','UNAVAILABLE_INPUT'),@('ASUSER_UNVERIFIED','UNVERIFIED'),@('private','UNVERIFIED'),@('','UNVERIFIED'))){if($asUnavailable.Invoke($null,@([string]$case[0])) -cne $case[1]){throw 'AsUser boundary classification changed'}}
$canonical=[OwnedMediumGui].GetMethod('CanonicalPrivileges',$flags)
$first=$canonical.Invoke($null,@([ulong[]]@(2,1),[uint[]]@(0,2)))
$second=$canonical.Invoke($null,@([ulong[]]@(1,2),[uint[]]@(2,0)))
$changed=$canonical.Invoke($null,@([ulong[]]@(1,2),[uint[]]@(0,0)))
$equal=[OwnedMediumGui].GetMethod('Equal',$flags)
if(!$equal.Invoke($null,@($first,$second)) -or $equal.Invoke($null,@($first,$changed))){throw 'privilege state equality changed'}
foreach($case in @(@([ulong[]]@(1,1),[uint[]]@(0,0)),@([ulong[]]@(1),[uint[]]@()),@([ulong[]](1..257),[uint[]](1..257)))){$failed=$false;try{$null=$canonical.Invoke($null,@($case[0],$case[1]))}catch{$failed=$_.Exception.GetBaseException().Message -ceq 'ASUSER_UNVERIFIED'};if(!$failed){throw 'unbounded privilege snapshot admitted'}}
$quoted=[OwnedMediumGui]::Command('tool',[string[]]@('space value','quote"value','trailing\',''))
foreach ($value in @([string]::new([char]'x',1020),('bad'+[char]0))) {
  $rejected=$false;try {$null=[OwnedMediumGui]::Command('tool',[string[]]@($value))}catch{$rejected=$true};if(!$rejected){throw 'native command bound admitted'}
}
if (!$IsWindows) { [Console]::Out.Write('PORTABLE_CONTRACT');exit 0 }
if ((GuiDebugTransport 'tool').transport -cne 'ABSENT') { throw 'native tokenizer unavailable' }
$parsed=[OwnedGuiArguments]::Parse($quoted)
if ($parsed.Count -ne 5 -or $parsed[1] -cne 'space value' -or $parsed[2] -cne 'quote"value' -or $parsed[3] -cne 'trailing\' -or $parsed[4] -cne '') { throw 'native quoting mismatch' }
`;

const windowsDesktopTokenContract=String.raw`
public sealed partial class OwnedMediumGui {
  public static void AssertDesktopTokenContract(){
    IntPtr credential=IntPtr.Zero,observed=IntPtr.Zero;bool reached=false,rejected=false;
    TokenNeed(OpenProcessToken(GetCurrentProcess(),10,out credential),TokenReason.OWN_TOKEN_OPEN);
    try{
      try{WithDesktopToken(credential,GetCurrentProcess(),token=>{
        observed=token;
        using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())Need(identity.ImpersonationLevel==System.Security.Principal.TokenImpersonationLevel.None,"OWNED_DACL_CONTEXT");
        Need(Word(token,8)==2,"OWNED_DACL_TOKEN");reached=true;throw new InvalidOperationException("OWNED_DACL_REJECTED");
      });}catch(InvalidOperationException failure){rejected=failure.Message=="OWNED_DACL_REJECTED";}
      Need(reached&&rejected&&observed!=IntPtr.Zero,"OWNED_DACL_ORDER");uint value,used;
      Need(!GetTokenUInt(observed,8,out value,4,out used)&&Marshal.GetLastWin32Error()==6,"OWNED_DACL_CLOSE");
    }finally{if(credential!=IntPtr.Zero)Need(CloseHandle(credential),"CLEANUP_UNVERIFIED");}
  }
}
`;

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('Windows launch portable contracts without process creation',async()=>{
  const created=windowsGuiMediumSource.slice(windowsGuiMediumSource.indexOf('long VerifyCreated('),windowsGuiMediumSource.indexOf('public void Stop('));
  const desktop=windowsGuiMediumSource.slice(windowsGuiMediumSource.indexOf('static void WithDesktopToken('),windowsGuiMediumSource.indexOf('long VerifyCreated('));
  expect(desktop).toContain('}});observe(duplicate);');
  expect(desktop).toContain('finally{if(duplicate!=IntPtr.Zero)Need(CloseHandle(duplicate),"CLEANUP_UNVERIFIED");}');
  expect(created).not.toContain('OwnedGuiIntegrity.Query(');
  expect(created).toContain('child.Id>0&&GetProcessId(child.Process)==(uint)child.Id');
  expect(created).toContain('OpenProcessToken(child.Process,8,out childToken)');
  expect(created).toContain('OwnedGuiIntegrity.ReadToken(childToken)');
  expect(created).toContain('if(childToken!=IntPtr.Zero)Need(CloseHandle(childToken),"CLEANUP_UNVERIFIED")');
  const script=windowsGuiDebugTransportScript+String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop
${windowsLaunchPortableContracts}
if($IsWindows){[OwnedMediumGui]::AssertDesktopTokenContract();$self=[Diagnostics.Process]::GetCurrentProcess();try{$session=$self.SessionId;if($session -lt 0){throw 'session precondition unverified'};[Console]::Out.Write('PORTABLE_CONTRACT:SESSION_NONZERO_'+$(if($session -ne 0){'TRUE'}else{'FALSE'}))}finally{$self.Dispose()}}else{[Console]::Out.Write('PORTABLE_CONTRACT')}
`;
  const wire=await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],process.env,30000,windowsGuiMediumSource+windowsDesktopTokenContract);
  if(process.platform==='win32'){const nonzero=windowsGuiSessionNonzero(wire);expect(nonzero).toBeDefined();console.info('Owned Windows current-process session nonzero: '+(nonzero?'TRUE':'FALSE'));}
  else expect(wire).toBe('PORTABLE_CONTRACT');
  await fixture(async root=>{
    const marker=join(root,'unexpected-cleanup'),entered=join(root,'revert-entered');
    const failure=String.raw`$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop;$guard=[OwnedMediumGui].GetMethod('RequireReverted',[Reflection.BindingFlags]'NonPublic,Static');$null=$guard.Invoke($null,@($true));[IO.File]::WriteAllText($env:LAZYSH_REVERT_ENTERED_MARKER,'entered');try{$null=$guard.Invoke($null,@($false))}finally{[IO.File]::WriteAllText($env:LAZYSH_REVERT_CLEANUP_MARKER,'unexpected')}`;
    await expect(native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',failure],{...process.env,LAZYSH_REVERT_CLEANUP_MARKER:marker,LAZYSH_REVERT_ENTERED_MARKER:entered},30000,windowsGuiMediumSource)).rejects.toThrow('Release validation failed: pwsh.exe');
    expect(await Bun.file(entered).text()).toBe('entered');
    expect(await Bun.file(marker).exists()).toBe(false);
  });
},35000);

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows restricted launcher contracts and native admission',async()=>{
  let wire:unknown,observed=mediumAdmissionObservation(undefined);
  const root=await mkdtemp(join(process.env.RUNNER_TEMP??tmpdir(),'lazysh-medium-admission-'));
  try{
    const tools=process.platform==='win32'?windowsGuiToolEnvironment(process.env.LAZYSH_GUI_DRIVER??'',process.env.LAZYSH_GUI_EDGE??''):{};
    if(process.platform==='win32'){
      if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw new Error('Restricted context requires owned Windows CI');
      const receipt=Bun.file(join(tools.LAZYSH_GUI_DRIVER!,'../../.crates2.json'));
      if(receipt.size>65536||!isWindowsGuiDriverReceipt(await receipt.json()))throw new Error('Unverified native driver receipt');
    }
    const probe=String.raw`$ErrorActionPreference='Stop';Add-Type 'using System;using System.Runtime.InteropServices;public class Q{[DllImport("kernel32")]public static extern IntPtr GetStdHandle(int n);[DllImport("kernel32")]public static extern uint GetFileType(IntPtr h);}';foreach($n in -10,-11,-12){if([Q]::GetFileType([Q]::GetStdHandle($n))-ne2){exit 4}};[Console]::OpenStandardOutput().WriteByte(88);[Console]::OpenStandardError().WriteByte(88);if([Console]::OpenStandardInput().ReadByte()-ne -1){exit 5};$w=[IO.File]::Open($env:LAZYSH_MEDIUM_PROOF,[IO.FileMode]::CreateNew);$w.WriteByte(89);$w.Dispose()`;
    const script=windowsInstallerPathsScript+windowsGuiMediumScript+windowsGuiEndpointsScript+windowsGuiHealthOwnershipScript+windowsGuiDebugTransportScript+String.raw`
$ErrorActionPreference='Stop'
$probeDeadline=[Environment]::TickCount64+100000
$guiMediumSource=[Console]::In.ReadToEnd()
Add-Type -TypeDefinition $guiMediumSource -ErrorAction Stop
${windowsLaunchPortableContracts}
$job=$null;$driver=$null;$probe=$null;$edge=$null;$outcome='UNVERIFIED';$launchRole='UNVERIFIED'
try {
  foreach ($path in @($env:LAZYSH_MEDIUM_ROOT,$env:LAZYSH_GUI_DRIVER,$env:LAZYSH_GUI_EDGE)) { Plain $path }
  $signature=Get-AuthenticodeSignature -LiteralPath $env:LAZYSH_GUI_EDGE
  Require ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?:^|, )O=Microsoft Corporation(?:,|$)') 'GUI_TOOLS'
  $job=NewGuiMediumJob
  $tool=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $info=[Diagnostics.ProcessStartInfo]::new($tool);$info.WorkingDirectory=$env:LAZYSH_MEDIUM_ROOT
  $info.Environment['LAZYSH_MEDIUM_PROOF']=Join-Path $env:LAZYSH_MEDIUM_ROOT 'write-proof'
  foreach ($arg in @('-NoProfile','-NonInteractive','-Command',$env:LAZYSH_MEDIUM_PROBE)) { $info.ArgumentList.Add($arg) }
  $launchRole='PROBE';$probe=GuiMediumStart $job $info $probeDeadline;$launchRole='UNVERIFIED'
  Require ($probe.WaitForExit(10000) -and $probe.ExitCode -eq 0) 'GUI_MEDIUM_UNAVAILABLE'
  Require ((Get-Item -LiteralPath $info.Environment['LAZYSH_MEDIUM_PROOF']).Length -eq 1) 'GUI_MEDIUM_UNAVAILABLE'
  $ports=@();$listeners=@()
  try {foreach($n in 1..2){$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$listeners+=$listener;$ports+=$listener.LocalEndpoint.Port}}
  finally{foreach($listener in $listeners){$listener.Stop()}}
  $info=[Diagnostics.ProcessStartInfo]::new($env:LAZYSH_GUI_DRIVER);$info.WorkingDirectory=$env:LAZYSH_MEDIUM_ROOT
  foreach($arg in @('--port',[string]$ports[0],'--native-port',[string]$ports[1],'--native-host','127.0.0.1','--native-driver',$env:LAZYSH_GUI_EDGE)){$info.ArgumentList.Add($arg)}
  $launchRole='DRIVER';$driver=GuiMediumStart $job $info;$launchRole='UNVERIFIED'
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    Require (!$driver.HasExited) 'GUI_START'
    $sockets=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in $ports})
    if(@($ports|Where-Object {$port=$_;@($sockets|Where-Object {$_.LocalPort -eq $port -and $_.LocalAddress -eq '127.0.0.1'}).Count -ne 1}).Count -eq 0){break}
    Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  $rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object {$_.ParentProcessId -eq $driver.Id -and $_.ExecutablePath -eq $env:LAZYSH_GUI_EDGE})
  Require ($rows.Count -eq 1) 'GUI_NATIVE_DRIVER'
  $edge=Get-Process -Id $rows[0].ProcessId;$retained=$edge.SafeHandle
  GuiEndpoints $sockets $ports $driver.Id $edge.Id
  foreach($pair in @(@{Role='DRIVER';Process=$driver},@{Role='EDGE';Process=$edge})){
    $name='LAZYSH_GUI_'+$pair.Role
    [Environment]::SetEnvironmentVariable($name+'_PID',[string]$pair.Process.Id)
    [Environment]::SetEnvironmentVariable($name+'_START',$pair.Process.StartTime.ToUniversalTime().Ticks.ToString())
    [Environment]::SetEnvironmentVariable($name+'_SHA256',(Get-FileHash -LiteralPath ([Environment]::GetEnvironmentVariable($name))).Hash)
    $fact=[OwnedGuiIntegrity]::Query($pair.Process.Id,$pair.Process.StartTime.ToUniversalTime().Ticks.ToString())
    Require ($fact[0] -ceq 'MEDIUM' -and $fact[1] -ceq 'NOT_ELEVATED') 'GUI_MEDIUM_UNAVAILABLE'
  }
  $env:LAZYSH_GUI_PORT=[string]$ports[0];$env:LAZYSH_GUI_NATIVE_PORT=[string]$ports[1]
  GuiHealthOwnership
  $job.Stop([DateTime]::UtcNow.AddSeconds(10).Ticks)
  Require ($driver.WaitForExit(1000) -and $edge.WaitForExit(1000)) 'GUI_CLEANUP'
  $outcome='ADMITTED_'+$job.Kind
} catch {
  $code=$_.Exception.GetBaseException().Message
  if($code -ceq 'CLEANUP_UNVERIFIED'){$outcome='CLEANUP_UNVERIFIED'}elseif($code -ceq 'TOKEN_UNAVAILABLE'){
    $reason=[OwnedMediumGui]::TokenFailure
    $outcome=$(if($reason -cin @(${windowsGuiTokenReasons.map(reason=>"'"+reason+"'").join(',')})) {'UNAVAILABLE_TOKEN_UNAVAILABLE:'+$reason} else {'UNVERIFIED'})
  }elseif($code -ceq 'LAUNCH_UNAVAILABLE'){
    $detail=[OwnedMediumGui]::LaunchFailure
    $outcome=$(if($launchRole -cin @('PROBE','DRIVER') -and $detail -cin @(${launchFailureDetails.map(detail=>"'"+detail+"'").join(',')})) {'UNAVAILABLE_LAUNCH_UNAVAILABLE:'+$launchRole+':'+$detail} else {'UNVERIFIED'})
  }else{$outcome=$(if($code -in @('TOKEN_UNAVAILABLE','DESKTOP_UNAVAILABLE','JOB_UNAVAILABLE','STDIO_UNAVAILABLE','LAUNCH_UNAVAILABLE','ARGV_BOUND','ENVIRONMENT_BOUND','IDENTITY_UNVERIFIED')) {'UNAVAILABLE_'+$code} else {'UNVERIFIED'})}
} finally {
  if($job){try{$job.Stop([DateTime]::UtcNow.AddSeconds(10).Ticks)}catch{$outcome='CLEANUP_UNVERIFIED'}}
  foreach($process in @($driver,$probe,$edge)){if($process){$process.Dispose()}}
}
if($job -and $job.CounterprobeOutcome -and $job.CounterprobeOutcome -cne 'NOT_ELIGIBLE'){
  $counterprobe=$(if($outcome -ceq 'CLEANUP_UNVERIFIED'){'CLEANUP_UNVERIFIED'}else{$job.CounterprobeOutcome})
  [Console]::Out.WriteLine('LAZYSH_MEDIUM_COUNTERPROBE:'+$job.Kind+':'+$counterprobe)
}
if($job -and $job.DaclObservations){[Console]::Out.WriteLine('LAZYSH_MEDIUM_DACL:'+$job.Kind+':'+$job.DaclObservations)}
if($job -and $job.AsUserOutcome -and $job.AsUserOutcome -cne 'NOT_ELIGIBLE'){[Console]::Out.WriteLine('LAZYSH_MEDIUM_ASUSER:'+$job.Kind+':'+$job.AsUserOutcome)}
[Console]::Out.Write($outcome)
`;
    const result=await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{...process.env,...tools,LAZYSH_MEDIUM_ROOT:root,LAZYSH_MEDIUM_PROBE:probe},100000,windowsGuiMediumSource);
    wire=result;observed=mediumAdmissionObservation(result);
    if(observed.counterprobe)console.info('Owned never-resumed creation-only counterprobe: '+JSON.stringify(observed.counterprobe));
    if('asUser' in observed)console.info('Owned never-resumed AsUser comparison: '+JSON.stringify(observed.asUser));
    if('dacl' in observed)console.info('Owned token fixed DACL-only observations: '+JSON.stringify(observed.dacl));
  }finally{await rm(root,{recursive:true,force:true});}
  // This signal follows every native and Bun cleanup; it never makes this denial pass.
  try {
    if(process.platform==='win32'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.LAZYSH_TEST_WINDOWS_HIGH_EVIDENCE==='1'&&process.env.GITHUB_OUTPUT&&highGuiEvidenceEligible(wire))
      await appendFile(process.env.GITHUB_OUTPUT,'high_gui_evidence=safe-denial\n');
  } finally {
    expect(process.platform==='win32'?['ADMITTED_LINKED','ADMITTED_RESTRICTED']:['PORTABLE_CONTRACT']).toContain(observed.result);
  }
},110000);
test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows installed GUI owns its bundled image and native window, then uninstalls', async () => {
  const installer = await exactlyOne('nsis/*.exe', join(import.meta.dir, '../target/release/bundle'));
  const binary = join(import.meta.dir, '../target/release/lazysh.exe');
  const { version } = await Bun.file(join(import.meta.dir, '../apps/client/package.json')).json();
  console.info(await windowsStandardInstallation(installer, binary, version));
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
test('pinned Node WebDriver serializes production GUI capabilities and preserves its timeout contract', async () => {
  const result = await native('node', ['--input-type=module', '-e', String.raw`
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const {windowsGuiCapabilities,windowsGuiSessionResponse,windowsGuiSessionNoResponse}=await import(process.env.LAZYSH_GUI_CONTRACT_MODULE);
const require=createRequire(process.env.LAZYSH_GUI_CONTRACT_MODULE);
if(require(join(dirname(dirname(require.resolve('webdriver'))),'package.json')).version!=='10.1.0')throw new Error('Unexpected WebDriver contract version');
const {remote}=require('webdriverio');
let requests=0,stall=false;const observed=[];
const server=createServer(async(request,response)=>{
  if(request.method!=='POST'||request.url!=='/session'){response.writeHead(404);response.end();return;}
  requests++;
  if(stall){request.resume();return;}
  let classification='UNVERIFIED';
  try {
    let bytes=0;const chunks=[];
    for await(const chunk of request){bytes+=chunk.length;if(bytes>65536)throw new Error('Bounded unit request exceeded');chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),caps=body.capabilities,always=caps?.alwaysMatch,options=always?.['tauri:options'];
    if(Object.keys(body).join(',')==='capabilities'&&Object.keys(caps).sort().join(',')==='alwaysMatch,firstMatch'&&
      JSON.stringify(caps.firstMatch)==='[{}]'&&Object.keys(always).sort().join(',')==='tauri:options,wdio:enforceWebDriverClassic'&&
      always['wdio:enforceWebDriverClassic']===true&&options?.application==='owned-contract-unit-only'){
      if(Object.keys(options).join(',')==='application')classification='AUTOMATIC';
      else if(Object.keys(options).sort().join(',')==='application,webviewOptions'&&Object.keys(options.webviewOptions).join(',')==='additionalBrowserArguments'&&
        JSON.stringify(options.webviewOptions.additionalBrowserArguments)==='["--remote-debugging-port=0"]')classification='EXPLICIT_PORT_ZERO';
    }
  } catch {}
  observed.push(classification);
  response.writeHead(400,{'content-type':'application/json'});
  response.end('{"value":{"error":"invalid argument","message":"owned unit rejection","stacktrace":""}}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
try {
  for(const treatment of ['0','1']){
    let responseCode;
    try {
      await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'silent',connectionRetryCount:0,connectionRetryTimeout:200,
        capabilities:windowsGuiCapabilities('owned-contract-unit-only',treatment),transformResponse:response=>{responseCode=windowsGuiSessionResponse(response);return response;}});
    } catch {if(responseCode!=='ARGUMENT')throw new Error('Finite unit rejection not observed');continue;}
    throw new Error('Unexpected unit session success');
  }
  if(observed.join(',')!=='AUTOMATIC,EXPLICIT_PORT_ZERO'||requests!==2)throw new Error('Production capability serialization mismatch');
  stall=true;
  try {
    await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'silent',connectionRetryCount:0,connectionRetryTimeout:200,
      capabilities:windowsGuiCapabilities('owned-contract-unit-only','0')});
    throw new Error('Unexpected unit endpoint response');
  } catch(error) {
    if(requests!==3||windowsGuiSessionNoResponse(error,port)!=='CLIENT_TIMEOUT')throw new Error('Pinned timeout contract not observed');
  }
  console.info('AUTOMATIC EXPLICIT_PORT_ZERO CLIENT_TIMEOUT');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
`], {...process.env, LAZYSH_GUI_CONTRACT_MODULE: new URL('../.changeset/windows-installed-gui.ts', import.meta.url).href}, 15000);
  expect(result).toBe('AUTOMATIC EXPLICIT_PORT_ZERO CLIENT_TIMEOUT');
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
test('owned frontend evidence remains finite and requires the already observed elevated HIGH lifetime snapshot',()=>{
  for(const frontend of ['EXACT_ABOUT_ACTION_OBSERVED','UNVERIFIED']){
    const snapshot={...startupFixture(),appIntegrity:'HIGH',appElevation:'ELEVATED',frontend};
    expect(parseWindowsGuiStartup(snapshot)).toEqual(snapshot);
    expect(windowsGuiStartupProbe('owned-core\nLAZYSH_WINDOWS_GUI_STARTUP:'+JSON.stringify(snapshot))).toEqual({core:'owned-core',startup:snapshot});
  }
  for(const invalid of [{frontend:'private title'},{frontend:true},{frontend:'EXACT_ABOUT_ACTION_OBSERVED',appIntegrity:'MEDIUM'},{frontend:'EXACT_ABOUT_ACTION_OBSERVED',appElevation:'NOT_ELEVATED'},{frontend:'EXACT_ABOUT_ACTION_OBSERVED',extra:'private path'}])expect(()=>parseWindowsGuiStartup({...startupFixture(),appIntegrity:'HIGH',appElevation:'ELEVATED',...invalid})).toThrow();
  const observed={...startupFixture(),appIntegrity:'HIGH',appElevation:'ELEVATED',frontend:'EXACT_ABOUT_ACTION_OBSERVED',frontendReason:'OBSERVED'};
  for(const frontendReason of windowsGuiFrontendReasons){
    const value={...observed,frontend:frontendReason==='OBSERVED'?'EXACT_ABOUT_ACTION_OBSERVED':'UNVERIFIED',frontendReason,...(frontendReason==='NOT_ADMITTED'?{appIntegrity:'MEDIUM',appElevation:'NOT_ELEVATED'}:{})};
    expect(parseWindowsGuiStartup(value)).toEqual(value);
    expect(windowsGuiStartupProbe('owned-core\nLAZYSH_WINDOWS_GUI_STARTUP:'+JSON.stringify(value))).toEqual({core:'owned-core',startup:value});
  }
  for(const change of [{frontendReason:'private path'},{frontendReason:null},{frontendReason:true},{frontendReason:{}},{frontendReason:'NO_ABOUT\n'},{frontend:undefined},{frontend:'UNVERIFIED'},{frontendReason:'NO_ABOUT'},{frontendReason:'NOT_ADMITTED'},{appIntegrity:'MEDIUM'},{appElevation:'NOT_ELEVATED'}])expect(()=>parseWindowsGuiStartup({...observed,...change})).toThrow();
  expect(()=>parseWindowsGuiStartup({...observed,frontend:'UNVERIFIED',frontendReason:'NO_ABOUT',appIntegrity:'MEDIUM'})).toThrow();
  expect(()=>parseWindowsGuiStartup({available:false,overflow:false,signature:'UNVERIFIED',frontendReason:'SOURCE_REJECTED'})).toThrow();
});

test('Windows English control counts stay finite, source-bound and separate from GUI acceptance',()=>{
  const counts={about:0,checking:1,locked:0,error:2,workspace:0};
  const value={...startupFixture(),appIntegrity:'HIGH',appElevation:'ELEVATED',frontend:'UNVERIFIED',frontendReason:'NO_ABOUT',englishControlCounts:counts};
  expect(parseWindowsGuiStartup(value)).toEqual(value);
  expect(windowsGuiStartupProbe('owned-core\nLAZYSH_WINDOWS_GUI_STARTUP:'+JSON.stringify(value))).toEqual({core:'owned-core',startup:value});
  const labels=windowsGuiAccessibilitySource.replace(/\\u([a-fA-F0-9]{4})/g,(_,code:string)=>String.fromCharCode(parseInt(code,16)));
  for(const key of ['accessCheckingDeviceAccess','accessLazyshIsLocked','accessNativeAppLockStatusIsUnavailable','accessNativeAppLockStatusIsUnavailableRestartLazyshTo','accessNativeAppUnlockCouldNotFinish','appAddAHost','appPreferences'] as const)
    expect(labels).toContain(JSON.stringify(english[key]));
  for(const englishControlCounts of [null,[],{},'private text',{...counts,path:'private'}, {...counts,checking:-1},{...counts,error:3},{...counts,workspace:0.5},{...counts,locked:true},{...counts,about:1}])
    expect(()=>parseWindowsGuiStartup({...value,englishControlCounts})).toThrow();
  for(const change of [{frontend:undefined},{frontendReason:'TIMEOUT'},{frontendReason:'NOT_ADMITTED'},{appIntegrity:'MEDIUM'},{appElevation:'UNVERIFIED'}])
    expect(()=>parseWindowsGuiStartup({...value,...change})).toThrow();
  expect(()=>parseWindowsGuiStartup({...value,frontend:'EXACT_ABOUT_ACTION_OBSERVED',frontendReason:'OBSERVED'})).toThrow();
  expect(parseWindowsGuiStartup({...value,frontend:'EXACT_ABOUT_ACTION_OBSERVED',frontendReason:'OBSERVED',englishControlCounts:{...counts,about:1}})).toMatchObject({englishControlCounts:{about:1}});
  expect(()=>parseWindowsGuiStartup({available:false,overflow:false,signature:'UNVERIFIED',englishControlCounts:counts})).toThrow();
});

test('owned document observations are name-independent, finite and cannot establish frontend acceptance',()=>{
  const value={...startupFixture(),appIntegrity:'HIGH',appElevation:'ELEVATED',frontend:'UNVERIFIED',frontendReason:'NO_ABOUT',englishControlCounts:{about:0,checking:0,locked:0,error:0,workspace:0}};
  for(const ownedDocumentCount of [0,1,2]){
    const snapshot={...value,ownedDocumentCount};
    expect(parseWindowsGuiStartup(snapshot)).toEqual(snapshot);
    expect(windowsGuiStartupProbe('owned-core\nLAZYSH_WINDOWS_GUI_STARTUP:'+JSON.stringify(snapshot))).toEqual({core:'owned-core',startup:snapshot});
    for(const change of [{englishControlCounts:undefined},{frontendReason:'TIMEOUT'},{appIntegrity:'MEDIUM'},{appElevation:'UNVERIFIED'},{frontend:'EXACT_ABOUT_ACTION_OBSERVED'}])
      expect(()=>parseWindowsGuiStartup({...snapshot,...change})).toThrow();
  }
  for(const ownedDocumentCount of [-1,3,0.5,NaN,Infinity,'1',true,null,[],{},'private URL'])
    expect(()=>parseWindowsGuiStartup({...value,ownedDocumentCount})).toThrow();
  expect(()=>parseWindowsGuiStartup({available:false,overflow:false,signature:'UNVERIFIED',ownedDocumentCount:1})).toThrow();
  const query=windowsGuiAccessibilitySource;
  expect(query).toContain('CreatePropertyCondition(30003,50030,out document)');
  expect(query.match(/root\.FindAllBuildCache\(/g)).toHaveLength(1);
  expect(query).toContain('count<=16');
  expect(query).toContain('thread.Join(2000)');
  expect(query).toContain('put_ConnectionTimeout(250)');
  expect(query).toContain('put_TransactionTimeout(250)');
  const documentBranch=query.slice(query.indexOf('if((int)actualType==50030){'),query.indexOf('}else{',query.indexOf('if((int)actualType==50030){')));
  expect(documentBranch).toContain('observed[5]=Math.Min(2,observed[5]+1)');
  expect(documentBranch).not.toMatch(/Cached\(|GetCurrent|GetText|GetValue|Write|Console|30005|30045/);
});

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI!=='1')('owned UIA candidate contract rejects unknown providers, hidden controls and invalid physical rectangles',async()=>{
  const script=windowsGuiStartupScript+String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$about=[OwnedGuiAccessibility].GetMethod('About',$flags)
$base=[object[]]@('About lazysh · 1.1.4','About lazysh · 1.1.4',50000,$true,$false,7,[int[]]@(7,8),[double[]]@(11,12,20,10),[double[]]@(10,10,50,50))
if(!$about.Invoke($null,$base)){throw 'exact bounded candidate rejected'}
foreach($case in @(@(1,'About lazysh · 1.1.5'),@(1,'about lazysh · 1.1.4'),@(2,50001),@(3,$false),@(4,$true),@(5,99),@(6,[int[]]@()),@(6,[int[]](1..34)),@(7,[double[]]@(9,12,20,10)),@(7,[double[]]@(11,12,0,10)),@(7,[double[]]@(11,12,20,-1)),@(7,[double[]]@(11,12,40,10)),@(7,[double[]]@(11,12,20,40)),@(7,[double[]]@([double]::NaN,12,20,10)),@(7,[double[]]@(11,[double]::PositiveInfinity,20,10)),@(7,[double[]]@(11,12,20)),@(8,[double[]]@(10,10,9,50)))){
  $changed=$base.Clone();$changed[$case[0]]=$case[1];if($about.Invoke($null,$changed)){throw 'unverified UIA candidate admitted'}
}
$document=[OwnedGuiAccessibility].GetMethod('Document',$flags)
$documentBase=[object[]]@(50030,$true,$false,7,[int[]]@(7,8),[double[]]@(11,12,20,10),[double[]]@(10,10,50,50))
if(!$document.Invoke($null,$documentBase)){throw 'owned document role rejected'}
foreach($case in @(@(0,50000),@(1,$false),@(2,$true),@(3,99),@(4,[int[]]@()),@(5,[double[]]@(9,12,20,10)),@(5,[double[]]@(11,12,0,10)),@(5,[double[]]@(11,12,40,10)),@(5,[double[]]@([double]::NaN,12,20,10)))){
  $changed=$documentBase.Clone();$changed[$case[0]]=$case[1];if($document.Invoke($null,$changed)){throw 'unverified document admitted'}
}
$category=[OwnedGuiAccessibility].GetMethod('Category',$flags)
$labels=[OwnedGuiAccessibility].GetMethod('Labels',$flags).Invoke($null,@('1.1.4'))
for($index=0;$index -lt $labels.Length;$index++){
  $type=if($index -eq 0 -or $index -ge 6){50000}else{50020}
  $expected=if($index -eq 0){0}elseif($index -le 2){$index}elseif($index -le 5){3}else{4}
  if($category.Invoke($null,@('1.1.4',$labels[$index],$type)) -ne $expected){throw 'exact English control rejected'}
  foreach($bad in @($labels[$index]+' private',$labels[$index].ToUpperInvariant(),'/private/path')){
    if($category.Invoke($null,@('1.1.4',$bad,$type)) -ne -1){throw 'unknown label mapped to a product state'}
  }
  if($category.Invoke($null,@('1.1.4',$labels[$index],50001)) -ne -1){throw 'unknown control role admitted'}
}
foreach($index in 1..2){if($category.Invoke($null,@('1.1.4',$labels[$index],50034)) -ne $index){throw 'heading label rejected'}}
$countFailure=[OwnedGuiAccessibility].GetMethod('CountFailure',$flags)
foreach($case in @(@(1,$null),@(0,'NO_ABOUT'),@(2,'AMBIGUOUS_ABOUT'),@(2147483647,'AMBIGUOUS_ABOUT'),@(-1,'COM_OR_CACHE_UNAVAILABLE'))){if($countFailure.Invoke($null,@($case[0])) -cne $case[1]){throw 'query count changed observation meaning'}}
foreach($case in @(@(0L,7,'1.1.4',[int[]]@(7)),@(1L,0,'1.1.4',[int[]]@(7)),@(1L,7,'private',[int[]]@(7)),@(1L,7,'1.1.4',[int[]]@()),@(4294967296L,7,'1.1.4',[int[]]@(7)))){
  [string]$reason='';[int[]]$counts=$null;if([OwnedGuiAccessibility]::Observe($case[0],$case[1],$case[2],$case[3],[ref]$reason,[ref]$counts) -ne 0 -or $reason -cne 'INPUT_REJECTED' -or $null -ne $counts){throw 'invalid root reached UIA'}
}
$env:LAZYSH_GUI_ACCESSIBILITY_PROBE='0';$notAdmitted=GuiAccessibility @(7)
if($notAdmitted.Count -ne 2 -or $notAdmitted[0] -cne 'UNVERIFIED' -or $notAdmitted[1] -cne 'NOT_ADMITTED'){throw 'unselected observation reached UIA'}
$env:LAZYSH_GUI_ACCESSIBILITY_PROBE='1';$missing=GuiAccessibility @(7)
if($missing.Count -ne 2 -or $missing[0] -cne 'UNVERIFIED' -or $missing[1] -cne 'SOURCE_REJECTED'){throw 'missing observer source reached UIA'}
# Exercise the existing snapshot fences around an optional UIA observation without Win32.
$epoch=[DateTime]::new(2025,1,1,0,0,0,[DateTimeKind]::Utc)
$env:LAZYSH_GUI_DRIVER_PID='1';$env:LAZYSH_GUI_EDGE_PID='2'
$env:LAZYSH_GUI_DRIVER='owned-driver';$env:LAZYSH_GUI_EDGE='owned-edge';$env:LAZYSH_GUI_BINARY='owned-app';$env:LAZYSH_GUI_RUNTIME_VERSION='1.2.3.4'
$env:LAZYSH_GUI_DRIVER_START=$epoch.Ticks.ToString();$env:LAZYSH_GUI_EDGE_START=$epoch.AddTicks(10).Ticks.ToString()
$inventory=@([PSCustomObject]@{ProcessId=1;ParentProcessId=0;Name='driver';ExecutablePath='owned-driver';CreationDate=$epoch},[PSCustomObject]@{ProcessId=2;ParentProcessId=1;Name='edge';ExecutablePath='owned-edge';CreationDate=$epoch.AddTicks(10)},[PSCustomObject]@{ProcessId=3;ParentProcessId=2;Name='app';ExecutablePath='owned-app';CreationDate=$epoch.AddTicks(20)})
$complete=$true;$script:metadataEligible=$true;$script:metadataAppId=3;$script:metadataStart=$epoch.AddTicks(20).Ticks.ToString()
function GuiImageIdentity { return !$script:retired }
function Get-Item { [PSCustomObject]@{VersionInfo=[PSCustomObject]@{ProductVersion='1.2.3.4'}} }
function GuiAppToken { return @($script:testIntegrity,$script:testElevation) }
function GuiAccessibility { $script:observations++;if($script:retireAfter){$script:retired=$true};return @('EXACT_ABOUT_ACTION_OBSERVED','OBSERVED',@{about=1;checking=0;locked=0;error=0;workspace=2},$script:documentCount) }
foreach($script:documentCount in 0..2){
foreach($case in @(@('0','HIGH','ELEVATED',$false,$null,0),@('1','HIGH','ELEVATED',$false,'EXACT_ABOUT_ACTION_OBSERVED',1),@('1','MEDIUM','NOT_ELEVATED',$false,'UNVERIFIED',0),@('1','HIGH','UNVERIFIED',$false,'UNVERIFIED',0),@('1','HIGH','ELEVATED',$true,$null,1))){
  $env:LAZYSH_GUI_ACCESSIBILITY_PROBE=$case[0];$script:testIntegrity=$case[1];$script:testElevation=$case[2];$script:retireAfter=$case[3];$script:retired=$false;$script:observations=0
  $snapshot=GuiStartupSnapshot
  if($script:observations -ne $case[5]){throw 'UIA observation escaped failure/high gate'}
  $expectedReason=if($null -eq $case[4]){$null}elseif($case[4] -ceq 'EXACT_ABOUT_ACTION_OBSERVED'){'OBSERVED'}else{'NOT_ADMITTED'}
  if($case[3]){if($snapshot.available -or $snapshot.frontend -or $snapshot.frontendReason -or $snapshot.englishControlCounts -or $snapshot.ContainsKey('ownedDocumentCount')){throw 'retired lifetime published UIA positive'}}elseif(!$snapshot.available -or $snapshot.frontend -cne $case[4] -or $snapshot.frontendReason -cne $expectedReason){throw 'optional UIA changed snapshot/core semantics'}
  if(!$case[3] -and $case[4] -ceq 'EXACT_ABOUT_ACTION_OBSERVED'){if($snapshot.englishControlCounts.workspace -ne 2 -or !$snapshot.ContainsKey('ownedDocumentCount') -or $snapshot.ownedDocumentCount -ne $script:documentCount){throw 'bounded control/document counts not retained'}}elseif($snapshot.englishControlCounts -or $snapshot.ContainsKey('ownedDocumentCount')){throw 'unadmitted control/document counts retained'}
}
}
[Console]::Out.Write('PORTABLE_UIA_CONTRACT')
`;
  expect(await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],process.env,30000,windowsGuiAccessibilitySource)).toBe('PORTABLE_UIA_CONTRACT');
},35000);

test('Windows startup projection admits only bounded signed runtime group evidence and strict versions',()=>{
  const value=startupFixture();
  expect(parseWindowsGuiStartup(value)).toEqual(value); // Loaded runtime may differ: retain evidence, do not normalize it.
  expect(parseWindowsGuiStartup({available:false,overflow:true,signature:'UNVERIFIED'})).toEqual({available:false,overflow:true,signature:'UNVERIFIED'});
  expect(parseWindowsGuiStartup({...value,observedProcesses:0,observedRootGroups:0,rootImageVersions:[],rootDebugTransports:[],signature:'NONE_OBSERVED'}).available).toBe(true);
  expect(parseWindowsGuiStartup({...value,observedProcesses:32,observedRootGroups:32,rootImageVersions:Array.from({length:32},(_,i)=>'1.0.0.'+(i+1)),rootDebugTransports:Array.from({length:32},()=>({role:'BROWSER_CANDIDATE',transport:'ABSENT'}))}).available).toBe(true);
  for(const transport of ['PIPE','EPHEMERAL_PORT','FIXED_PORT','ABSENT','AMBIGUOUS','UNVERIFIED'])expect(parseWindowsGuiStartup({...value,rootDebugTransports:[{role:'BROWSER_CANDIDATE',transport}]}).available).toBe(true);
  expect(parseWindowsGuiStartup({...value,observedRootGroups:3,rootDebugTransports:[{role:'TYPED_CHILD',transport:'ABSENT'},{role:'BROWSER_CANDIDATE',transport:'PIPE'},{role:'AMBIGUOUS',transport:'UNVERIFIED'}]})).toMatchObject({rootDebugTransports:[{role:'AMBIGUOUS',transport:'UNVERIFIED'},{role:'BROWSER_CANDIDATE',transport:'PIPE'},{role:'TYPED_CHILD',transport:'ABSENT'}]});
  for(const appIntegrity of ['LOW','MEDIUM','HIGH','SYSTEM','UNVERIFIED'])expect(parseWindowsGuiStartup({...value,appIntegrity}).available).toBe(true);
  for(const role of ['BROWSER_CANDIDATE','TYPED_CHILD','AMBIGUOUS','UNVERIFIED'])expect(parseWindowsGuiStartup({...value,rootDebugTransports:[{role,transport:'ABSENT'}]}).available).toBe(true);
  const bad:unknown[]=[null,{},[],{...value,rootDebugTransports:null},{...value,rootDebugTransports:[null]},{...value,rootDebugTransports:'PIPE'},{available:false,overflow:false,signature:'UNVERIFIED',pid:1}];
  for(const change of [{appIntegrity:'ADMIN'},{appIntegrity:'IDENTITY_UNVERIFIED'},{appIntegrity:{sid:'private'}},{appIntegrity:0},{appIntegrity:null},{appIntegrity:'HIGH\n'},{rootDebugTransports:[{role:'renderer',transport:'ABSENT'}]},{rootDebugTransports:[{role:'TYPED_CHILD',transport:'9222'}]},{rootDebugTransports:[{role:'TYPED_CHILD',transport:'ABSENT',type:'renderer'}]},{rootDebugTransports:[{role:'TYPED_CHILD'}]},{rootDebugTransports:[{transport:'PIPE'}]},{rootDebugTransports:[]},{rootDebugTransports:['9222']},{rootDebugTransports:['PIPE','ABSENT']},{rootDebugTransports:['private/path']},{pid:1},{path:'private'},{args:'private'},{profile:'private'},{overflow:true},{observedProcesses:33},{observedProcesses:-1},{observedProcesses:0.5},{observedRootGroups:4},{observedRootGroups:0},{signature:'Valid'},{rootImageVersions:[]},{rootImageVersions:['1.2.3.4','1.2.3.4']},{observerEnvPresence:{...value.observerEnvPresence,userDataFolder:'private'}}])bad.push({...value,...change});
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
  // Both commands execute successfully without the pre-spawn UTF-16 bound on this host.
  for(const command of ["console.log('must-not-execute');"+' '.repeat(32768),"console.log('must-not-execute');/*"+'"'.repeat(17000)+'*/'])await expect(native(tool,['-e',command])).rejects.toThrow('Release validation failed: pwsh.exe');
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

test('Windows standard owner keeps output closed and staging inside its public dependency closure',async()=>{
  for(const code of ['STANDARD_OWNER_PASSED','STANDARD_OWNER_FAILED','CLEANUP_UNVERIFIED','ACCOUNT_COLLISION','DESKTOP_UNAVAILABLE','DESKTOP_SESSION_UNAVAILABLE','DESKTOP_ACCESS_UNAVAILABLE',...windowsGuiDaclFailures,...windowsGuiTokenReasons.map(reason=>'TOKEN_UNAVAILABLE_'+reason)])expect(standardOwnerCode('LAZYSH_STANDARD_OWNER:'+code)).toBe(code);
  expect(standardOwnerCode('LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:STANDARD_LOGON_UNAVAILABLE')).toBe('CLEANUP_UNVERIFIED');
  for(const code of ['DESKTOP_SESSION_UNAVAILABLE','DESKTOP_ACCESS_UNAVAILABLE'])expect(standardOwnerCode('LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:'+code)).toBe('CLEANUP_UNVERIFIED');
  expect(windowsGuiSessionNonzero('PORTABLE_CONTRACT:SESSION_NONZERO_TRUE')).toBe(true);
  expect(windowsGuiSessionNonzero('PORTABLE_CONTRACT:SESSION_NONZERO_FALSE')).toBe(false);
  for(const value of [null,{},42,'PORTABLE_CONTRACT','SESSION_NONZERO_TRUE','PORTABLE_CONTRACT:SESSION_NONZERO_1','PORTABLE_CONTRACT:SESSION_NONZERO_TRUE private','PORTABLE_CONTRACT:SESSION_NONZERO_TRUE\nprivate'])expect(windowsGuiSessionNonzero(value)).toBeUndefined();
  for(const reason of windowsGuiTokenReasons)expect(standardOwnerCode('LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:TOKEN_UNAVAILABLE_'+reason)).toBe('CLEANUP_UNVERIFIED');
  for(const value of ['LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:STANDARD_OWNER_PASSED','LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:private','LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:TOKEN_UNAVAILABLE_PRIVATE','LAZYSH_STANDARD_OWNER:CLEANUP_UNVERIFIED:TOKEN_UNAVAILABLE_CHILD_TOKEN_UNVERIFIED private',null,{},'STANDARD_OWNER_PASSED','LAZYSH_STANDARD_OWNER:private','LAZYSH_STANDARD_OWNER:DESKTOP_ACCESS_UNAVAILABLE private','LAZYSH_STANDARD_OWNER:DESKTOP_SESSION_UNAVAILABLE_PRIVATE','LAZYSH_STANDARD_OWNER:TOKEN_UNAVAILABLE_PRIVATE','LAZYSH_STANDARD_OWNER:TOKEN_UNAVAILABLE_CHILD_TOKEN_UNVERIFIED private','LAZYSH_STANDARD_OWNER:TOKEN_UNAVAILABLE_2147483647','LAZYSH_STANDARD_OWNER:STANDARD_OWNER_PASSED\nprivate'])expect(standardOwnerCode(value)).toBe('UNVERIFIED');
  expect(insideStandardRoot('/owned/public/file','/owned/public')).toBe(true);expect(insideStandardRoot('/owned/private','/owned/public')).toBe(false);
  await fixture(async root=>{const source=join(root,'public'),target=join(root,'copied');await mkdir(source);await writeFile(join(root,'private'),'never copied');await symlink(join(root,'private'),join(source,'foreign'));await expect(copyStandardClosure(source,target,source)).rejects.toThrow('escapes');expect(await Bun.file(join(target,'foreign')).exists()).toBe(false);});
  const configured=Object.fromEntries(['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_SHA','RUNNER_TEMP','TEMP','TMP','PATH','LAZYSH_TEST_WINDOWS_GUI','LAZYSH_GUI_DRIVER','LAZYSH_GUI_EDGE'].map(key=>[key,'synthetic']));
  const selected=standardWorkerEnvironment({USERPROFILE:'fresh-profile',GITHUB_TOKEN:'synthetic-secret',ACTIONS_RUNTIME_TOKEN:'synthetic-secret',SSH_AUTH_SOCK:'synthetic-socket',PATH:'foreign-tools'},configured);
  expect(selected.USERPROFILE).toBe('fresh-profile');expect(selected.PATH).toBe('synthetic');
  for(const key of ['GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','SSH_AUTH_SOCK'])expect(key in selected).toBe(false);
  expect(()=>standardWorkerEnvironment({}, {...configured,GITHUB_TOKEN:'synthetic-secret'})).toThrow();
  const receipt={result:'PASSED',source:'a'.repeat(40),binary:'b'.repeat(64)};
  expect(parseStandardReceipt(receipt,receipt.source,receipt.binary)).toEqual({result:'PASSED'});
  expect(parseStandardReceipt({...receipt,result:'FAILED',failure:'gui:GUI_FRONTEND'},receipt.source,receipt.binary)).toEqual({result:'FAILED',failure:'gui:GUI_FRONTEND'});
  for(const change of [{account:'private'},{source:'c'.repeat(40)},{binary:'c'.repeat(64)},{result:'ADMITTED'},{failure:'gui:GUI_FRONTEND'},{result:'FAILED',failure:'private data'}])expect(()=>parseStandardReceipt({...receipt,...change},receipt.source,receipt.binary)).toThrow();
  expect(windowsStandardUserSource.match(/CreateProcessWithLogonW\(name,/g)).toHaveLength(1);
  expect(windowsStandardUserSource).toContain('IntPtr.Zero,root,ref startup,out child)');
  expect(windowsStandardUserSource).toContain('LogonUserW(name,".",password,2,0,out credential)&&credential!=IntPtr.Zero');
  expect(windowsStandardUserSource).toContain('TokenSid(credential)==actual[0]');
  const sessionGuard=windowsStandardUserSource.indexOf('Need(session!=0,"DESKTOP_SESSION_UNAVAILABLE")'),logon=windowsStandardUserSource.indexOf('Need(LogonUserW(name,');
  expect(sessionGuard).toBeGreaterThan(0);expect(sessionGuard).toBeLessThan(logon);
  expect(windowsStandardUserSource.indexOf('impersonation,3,4)=="ALLOWS",StandardDesktopFailure())')).toBeGreaterThan(logon);
  expect(windowsStandardUserSource).toContain('ObjectName(GetThreadDesktop(GetCurrentThreadId()))=="Default","DESKTOP_UNAVAILABLE")');
  expect(windowsStandardUserSource).toContain('owned.VerifyCreated(child,image,credential)');
  expect(windowsStandardUserSource).toContain('InspectAs(credential,()=>StandardToken(child.Process,actual[0],session))');
  expect(windowsStandardUserSource).toContain('Need(credentialClosed,"CLEANUP_UNVERIFIED");var data=Capsule(root)');
  expect(windowsStandardUserSource).toContain('Need(data[4]!="INTENT","CLEANUP_UNVERIFIED")');
  expect(windowsStandardUserSource).not.toMatch(/AdjustTokenPrivileges|ChangeServiceConfig|StartService|SwitchDesktop|SetUserObjectSecurity|LOGON_NETCREDENTIALS_ONLY/);
});
for(const invalidSource of [false,true])test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI!=='1')(`Windows standard broker portable contracts reject orphan-gap cleanup before any account API${invalidSource?' (invalid source)':''}`,async()=>{
  await fixture(async root=>{
    const capsule=join(root,'account.owner');await writeFile(capsule,['lshci0123456789ab','S-1-5-21-1-2-3-1001','0'.repeat(32),'1','INTENT','a'.repeat(64),'123','C:\\Users\\lshci0123456789ab'].join('\n'));
    const script=String.raw`$ErrorActionPreference='Stop';$contractStage='PARSE';$contractCodes=@('CLEANUP_UNVERIFIED','ACCOUNT_IDENTITY','FIXTURE_IDENTITY','PROFILE_IDENTITY');try{$tokens=$null;$parseErrors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($env:LAZYSH_STANDARD_CONTRACT_SCRIPT,[ref]$tokens,[ref]$parseErrors);if($parseErrors.Count){throw 'actual standard broker PowerShell syntax rejected'};$contractStage='COMPILE';Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop;$flags=[Reflection.BindingFlags]'NonPublic,Static';$contractStage='TOKEN';$primaryFailure=[OwnedMediumGui].GetMethod('StandardPrimaryFailure',$flags);$tokenNeed=[OwnedMediumGui].GetMethod('TokenNeed',$flags);$reasonType=$tokenNeed.GetParameters()[1].ParameterType;foreach($case in @(@('CHILD_TOKEN_UNVERIFIED','TOKEN_UNAVAILABLE_CHILD_TOKEN_UNVERIFIED'),@('QUERY_READ_FAILED','TOKEN_UNAVAILABLE_QUERY_READ_FAILED'),@('STANDARD_TOKEN_OPEN','TOKEN_UNAVAILABLE_STANDARD_TOKEN_OPEN'),@('STANDARD_TOKEN_IDENTITY','TOKEN_UNAVAILABLE_STANDARD_TOKEN_IDENTITY'),@('STANDARD_ADMIN_GROUP_ENABLED','TOKEN_UNAVAILABLE_STANDARD_ADMIN_GROUP_ENABLED'),@('STANDARD_USERS_GROUP_MISSING','TOKEN_UNAVAILABLE_STANDARD_USERS_GROUP_MISSING'),@('STANDARD_TOKEN_INTEGRITY','TOKEN_UNAVAILABLE_STANDARD_TOKEN_INTEGRITY'),@('STANDARD_TOKEN_CONTEXT','TOKEN_UNAVAILABLE_STANDARD_TOKEN_CONTEXT'),@('2147483647','UNVERIFIED'))){$reason=[Enum]::Parse($reasonType,$case[0]);$rejected=$false;try{$tokenNeed.Invoke($null,@($false,$reason))}catch{$rejected=$_.Exception.GetBaseException().Message -ceq 'TOKEN_UNAVAILABLE'};if(!$rejected -or [OwnedMediumGui]::StandardTokenFailure() -cne $case[1]){throw 'token rejection reason escaped its finite boundary'};$primary=$primaryFailure.Invoke($null,@('TOKEN_UNAVAILABLE'));try{$tokenNeed.Invoke($null,@($false,([Enum]::Parse($reasonType,'2147483647'))))}catch{};try{throw [InvalidOperationException]::new('CLEANUP_UNVERIFIED:'+$primary)}catch{if($_.Exception.GetBaseException().Message -cne ('CLEANUP_UNVERIFIED:'+$case[1])){throw 'cleanup masked the retained primary token reason'}}};if($primaryFailure.Invoke($null,@('private SID path token payload')) -cne 'UNVERIFIED'){throw 'unknown primary failure exposed payload'};foreach($code in @('DESKTOP_UNAVAILABLE','DESKTOP_SESSION_UNAVAILABLE','DESKTOP_ACCESS_UNAVAILABLE')){if($primaryFailure.Invoke($null,@($code)) -cne $code){throw 'desktop boundary lost closed primary'}};foreach($code in @('DESKTOP_ACCESS_UNAVAILABLE private','DESKTOP_SESSION_UNAVAILABLE_PRIVATE')){if($primaryFailure.Invoke($null,@($code)) -cne 'UNVERIFIED'){throw 'desktop boundary exposed private payload'}};$desktopFailure=[OwnedMediumGui].GetMethod('StandardDesktopFailure',$flags);$daclPhase=[OwnedMediumGui].GetField('daclFailure',$flags);foreach($phase in @(${windowsGuiDaclFailures.map(code=>JSON.stringify(code)).join(',')})){$daclPhase.SetValue($null,$phase);if($desktopFailure.Invoke($null,@()) -cne $phase){throw 'DACL phase lost closed primary'}};foreach($phase in @('FILE_DENIED','WINSTA_PRIVATE','DESKTOP_DENIED private SID ACL')){$daclPhase.SetValue($null,$phase);if($desktopFailure.Invoke($null,@()) -cne 'UNVERIFIED'){throw 'DACL phase exposed private data'}};$contractStage='HKEY';$registry=[OwnedMediumGui].GetMethod('RegistryRoot',$flags);if($registry.Invoke($null,@([uint32]2147483651)).ToInt64() -ne -2147483645){throw 'predefined HKEY lost sign extension'};$contractStage='CACHE';$writable=[OwnedMediumGui].GetMethod('WritableFixture',$flags);$fixtureRoot=$env:LAZYSH_STANDARD_CONTRACT_ROOT;$dotRoot=[IO.Path]::Combine($fixtureRoot,'.');foreach($case in @(@([IO.Path]::Combine($fixtureRoot,'work','receipt'),$fixtureRoot,$true),@([IO.Path]::Combine($dotRoot,'work','receipt'),$dotRoot,$true),@([IO.Path]::Combine($fixtureRoot,'work','.','receipt'),$fixtureRoot,$true),@([IO.Path]::Combine($fixtureRoot,'work','..','source.ts'),$fixtureRoot,$false),@([IO.Path]::Combine($fixtureRoot,'node_modules','.vitest-cache','..','vite','source.js'),$fixtureRoot,$false),@([IO.Path]::Combine($fixtureRoot,'work-foreign','receipt'),$fixtureRoot,$false),@([IO.Path]::Combine($fixtureRoot+'-foreign','work','receipt'),$fixtureRoot,$false),@('work/receipt',$fixtureRoot,$false),@([IO.Path]::Combine($fixtureRoot,'work','receipt'),'relative-root',$false),@($null,$fixtureRoot,$false),@([IO.Path]::Combine($fixtureRoot,'work','receipt'),$null,$false),@(($fixtureRoot+[IO.Path]::DirectorySeparatorChar+'work'+[IO.Path]::DirectorySeparatorChar+[char]0),$fixtureRoot,$false))){if($writable.Invoke($null,@($case[0],$case[1])) -ne $case[2]){throw 'canonical cache path or traversal boundary rejected'}};if($IsWindows){$forwardRoot=$fixtureRoot.Replace([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar);$deviceBase=[string]::new([IO.Path]::DirectorySeparatorChar,2);$extendedRoot=$deviceBase+'?'+[IO.Path]::DirectorySeparatorChar+$fixtureRoot;$deviceRoot=$deviceBase+'.'+[IO.Path]::DirectorySeparatorChar+$fixtureRoot;foreach($case in @(@([IO.Path]::Combine($forwardRoot,'node_modules/.vitest-cache/module'),$forwardRoot,$true),@([IO.Path]::Combine($fixtureRoot,'work','receipt').Replace([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar),$fixtureRoot,$true),@(('C:work'+[IO.Path]::DirectorySeparatorChar+'receipt'),$fixtureRoot,$false),@([IO.Path]::Combine($extendedRoot,'work','..','source.ts'),$extendedRoot,$false),@([IO.Path]::Combine($deviceRoot,'work','receipt'),$deviceRoot,$false))){if($writable.Invoke($null,@($case[0],$case[1])) -ne $case[2]){throw 'Windows separator or device boundary rejected'}}};if(!$writable.Invoke($null,@([IO.Path]::Combine($env:LAZYSH_STANDARD_CONTRACT_ROOT,'work','receipt'),$env:LAZYSH_STANDARD_CONTRACT_ROOT)) -or $writable.Invoke($null,@([IO.Path]::Combine($env:LAZYSH_STANDARD_CONTRACT_ROOT,'node_modules','vite','source.js'),$env:LAZYSH_STANDARD_CONTRACT_ROOT))){throw 'source gained generated-cache write access'};if(!$writable.Invoke($null,@([IO.Path]::Combine($env:LAZYSH_STANDARD_CONTRACT_ROOT,'node_modules','.vitest-cache','module'),$env:LAZYSH_STANDARD_CONTRACT_ROOT)) -or $writable.Invoke($null,@([IO.Path]::Combine($env:LAZYSH_STANDARD_CONTRACT_ROOT,'node_modules','.vitest-cache-foreign','module'),$env:LAZYSH_STANDARD_CONTRACT_ROOT))){throw 'Vitest module cache scope rejected'};$contractStage='SID';$sid=[OwnedMediumGui].GetMethod('StandardSid',$flags);foreach($value in @('S-1-5-18','S-1-5-32-544','S-1-5-21-1-2-3-1001 private','')){if($sid.Invoke($null,@($value))){throw 'unknown account SID admitted'}};if(!$sid.Invoke($null,@('S-1-5-21-1-2-3-1001'))){throw 'ordinary SID rejected'};$contractStage='CREDENTIAL';$cleanup=[OwnedMediumGui].GetMethod('CleanupAccount',$flags);$capsule=[IO.Path]::Combine($env:LAZYSH_STANDARD_CONTRACT_ROOT,'account.owner');$original=[IO.File]::ReadAllText($capsule);$setup=[IO.File]::ReadAllLines($capsule);$setup[4]='SETUP';[IO.File]::WriteAllLines($capsule,$setup);$rejected=$false;try{$cleanup.Invoke($null,@($env:LAZYSH_STANDARD_CONTRACT_ROOT,([Environment]::TickCount64+1000),$false))}catch{$rejected=$_.Exception.GetBaseException().Message -ceq 'CLEANUP_UNVERIFIED'};if(!$rejected -or ![IO.File]::Exists($capsule) -or [IO.File]::ReadAllLines($capsule)[4] -cne 'SETUP'){throw 'uncertain credential closure reached account cleanup'};[IO.File]::WriteAllText($capsule,$original);$contractStage='INTENT';$rejected=$false;$cleanupReason='UNVERIFIED';try{$cleanup.Invoke($null,@($env:LAZYSH_STANDARD_CONTRACT_ROOT,([Environment]::TickCount64+1000),$true))}catch{$cleanupReason=$_.Exception.GetBaseException().Message;$rejected=$cleanupReason -ceq 'CLEANUP_UNVERIFIED'};if(!$rejected){if($cleanupReason -cin $contractCodes){throw $cleanupReason};throw 'uncertain launch gap reached account deletion'};$contractStage='HOSTED';if(!$IsWindows){$rejected=$false;try{[OwnedMediumGui]::RunStandard('unowned','unowned','unowned',('a'*64),1)}catch{$rejected=$_.Exception.GetBaseException().Message -ceq 'HOSTED_ONLY'};if(!$rejected){throw 'local native account execution admitted'}};[Console]::Out.Write('STANDARD_PORTABLE_CONTRACT')}catch{$reason=$_.Exception.GetBaseException().Message;if($reason -cnotin $contractCodes){$reason='UNVERIFIED'};[Console]::Out.Write('STANDARD_CONTRACT_FAILED:'+$contractStage+':'+$reason)}`;
    expect(await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{...process.env,LAZYSH_STANDARD_CONTRACT_ROOT:root,LAZYSH_STANDARD_CONTRACT_SCRIPT:standardBrokerScript},30000,windowsStandardUserSource+(invalidSource?'\n#error OWNED_STANDARD_COMPILE_REJECTION\n':''))).toBe(invalidSource?'STANDARD_CONTRACT_FAILED:COMPILE:UNVERIFIED':'STANDARD_PORTABLE_CONTRACT');
  });
},35000);
