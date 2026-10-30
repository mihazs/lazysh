import {request} from 'node:http';
import {win32} from 'node:path';

export const windowsGuiRoleRejections = ['ROLE_DATA_UNVERIFIED', 'MAIN_OWNER_MISMATCH', 'MAIN_GEOMETRY_MISMATCH', 'MAIN_STYLE_MISMATCH', 'MAIN_EXSTYLE_MISMATCH', 'TAO_OWNER_MISMATCH', 'TAO_GEOMETRY_MISMATCH', 'TAO_STYLE_CLIPSIBLINGS_ONLY', 'TAO_STYLE_MISMATCH', 'TAO_EXSTYLE_MISMATCH', 'UNKNOWN_CLASS', 'MULTIPLE_ROLE_MISMATCHES'] as const;
export const windowsGuiProbePhases = [...windowsGuiRoleRejections, 'PROBE_UNVERIFIED', 'DRIVER_IDENTITY_UNVERIFIED', 'OWNED_INVENTORY_UNVERIFIED', 'EXPECTED_IMAGE_CANDIDATE_ABSENT', 'IMAGE_IDENTITY_UNVERIFIED', 'WINDOW_UNVERIFIED', 'WINDOW_ENUMERATION_FAILED', 'NO_OWNED_HANDLES_OBSERVED', 'OWNED_HANDLES_INVISIBLE', 'VISIBLE_HANDLES_AMBIGUOUS', 'WINDOW_ROLE_UNVERIFIED', 'UNEXPECTED_VISIBLE_ROLE', 'NO_MAIN_WINDOW_OBSERVED'] as const;
// Bit positions are fixed by this closed list; the aggregate phase is not a concrete role.
export const windowsGuiRoleReasons=windowsGuiRoleRejections.filter(reason=>reason!=='MULTIPLE_ROLE_MISMATCHES');
export function windowsGuiRoleSubset(phase:string,mask:unknown) {
  if(!Number.isInteger(mask)||typeof mask!=='number'||mask<1||mask>=2**windowsGuiRoleReasons.length)return;
  const reasons=windowsGuiRoleReasons.filter((_,index)=>(mask & 2**index)!==0);
  if(phase==='MULTIPLE_ROLE_MISMATCHES'?reasons.length<2:reasons.length!==1||reasons[0]!==phase)return;
  return reasons;
}
type WindowsGuiMetadata={available:false}|{available:true;overflow:boolean;windows:{className:string;style:number;exstyle:number;width:number;height:number;clientWidth:number;clientHeight:number;ownerless:boolean}[]};
export function parseWindowsGuiMetadata(value:unknown):WindowsGuiMetadata {
  const fail=()=>{throw new Error('Invalid owned Windows GUI framework metadata');};
  if(!value||typeof value!=='object')return fail();
  const root=value as Record<string,unknown>;
  if(root.available===false&&Object.keys(root).join(',')==='available')return {available:false};
  if(Object.keys(root).sort().join(',')!=='available,overflow,windows'||root.available!==true||typeof root.overflow!=='boolean'||!Array.isArray(root.windows)||root.windows.length>8||root.overflow&&root.windows.length!==8)return fail();
  const windows=root.windows.map(row=>{
    if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='className,clientHeight,clientWidth,exstyle,height,ownerless,style,width')return fail();
    const {className,style,exstyle,width,height,clientWidth,clientHeight,ownerless}=row;
    if(typeof className!=='string'||className.length<1||className.length>128||/[^\x20-\x7e]/.test(className)||/[\/\\]/.test(className)||typeof ownerless!=='boolean')return fail();
    for(const bits of [style,exstyle])if(typeof bits!=='number'||!Number.isInteger(bits)||bits<0||bits>4294967295)return fail();
    for(const extent of [width,height,clientWidth,clientHeight])if(typeof extent!=='number'||!Number.isInteger(extent)||Math.abs(extent)>100000)return fail();
    return {className,style,exstyle,width,height,clientWidth,clientHeight,ownerless};
  });
  return {available:true,overflow:root.overflow,windows};
}
export function windowsGuiMetadataProjection(stdout:unknown):string|undefined {
  if(typeof stdout!=='string'||stdout.length>2097152)return;
  const lines=stdout.split(/\r?\n/).filter(line=>line.startsWith('LAZYSH_WINDOWS_GUI_METADATA:'));
  if(lines.length!==1||lines[0].length>4096)return;
  try {return JSON.stringify(parseWindowsGuiMetadata(JSON.parse(lines[0].slice('LAZYSH_WINDOWS_GUI_METADATA:'.length))));}catch{return;}
}
// Pinned Chromium remote_debugging_server.cc:85–94 binds the default debug server to loopback.
export function windowsGuiCapabilities(application:string, treatment:string|undefined) {
  if(treatment!=='0'&&treatment!=='1')throw new Error('Invalid installed GUI treatment');
  return {'tauri:options':{application,...(treatment==='1'?{webviewOptions:{additionalBrowserArguments:['--remote-debugging-port=0']}}:{})},'wdio:enforceWebDriverClassic':true as const};
}
export const windowsGuiOverrideNames={browserFolder:'WEBVIEW2_BROWSER_EXECUTABLE_FOLDER',userDataFolder:'WEBVIEW2_USER_DATA_FOLDER',browserArguments:'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',channelSearchKind:'WEBVIEW2_CHANNEL_SEARCH_KIND',releaseChannels:'WEBVIEW2_RELEASE_CHANNELS',waitForScriptDebugger:'WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER',pipeForScriptDebugger:'WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER'} as const;
const startupUnavailable={available:false,overflow:false,signature:'UNVERIFIED'} as const;
export const windowsGuiDebugTransports=['PIPE','EPHEMERAL_PORT','FIXED_PORT','ABSENT','AMBIGUOUS','UNVERIFIED'] as const;
type GuiDebugTransport=typeof windowsGuiDebugTransports[number];
export const windowsGuiRootRoles=['BROWSER_CANDIDATE','TYPED_CHILD','AMBIGUOUS','UNVERIFIED'] as const;
type GuiRootDebug={role:typeof windowsGuiRootRoles[number];transport:GuiDebugTransport};
export const windowsGuiIntegrityLevels=['LOW','MEDIUM','HIGH','SYSTEM','UNVERIFIED'] as const;
type GuiStartup=typeof startupUnavailable|{available:false;overflow:true;signature:'UNVERIFIED'}|{available:true;overflow:false;signature:'MICROSOFT'|'NONE_OBSERVED';observedProcesses:number;observedRootGroups:number;registeredRuntimeVersion:string;edgeDriverVersion:string;rootImageVersions:string[];rootDebugTransports:GuiRootDebug[];appIntegrity:typeof windowsGuiIntegrityLevels[number];appElevation:'ELEVATED'|'NOT_ELEVATED'|'UNVERIFIED';observerEnvPresence:Record<keyof typeof windowsGuiOverrideNames,boolean>;frontend?:'EXACT_ABOUT_ACTION_OBSERVED'|'UNVERIFIED'};
function guiNumericVersion(value:unknown):value is string {
  return typeof value==='string'&&/^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){3}$/.exec(value)?.[0]===value&&value!=='0.0.0.0'&&value.split('.').every(part=>Number(part)<=65535);
}
export function parseWindowsGuiStartup(value:unknown):GuiStartup {
  const fail=()=>{throw new Error('Invalid owned Windows GUI startup snapshot');};
  if(!value||typeof value!=='object')return fail();
  const row=value as Record<string,unknown>;
  if(row.available===false&&typeof row.overflow==='boolean'&&row.signature==='UNVERIFIED'&&Object.keys(row).sort().join(',')==='available,overflow,signature')return {available:false,overflow:row.overflow,signature:'UNVERIFIED'};
  if(row.frontend!==undefined&&!['EXACT_ABOUT_ACTION_OBSERVED','UNVERIFIED'].includes(row.frontend as string))return fail();
  if(row.frontend==='EXACT_ABOUT_ACTION_OBSERVED'&&(row.appIntegrity!=='HIGH'||row.appElevation!=='ELEVATED'))return fail();
  if(Object.keys(row).filter(key=>key!=='frontend').sort().join(',')!=='appElevation,appIntegrity,available,edgeDriverVersion,observedProcesses,observedRootGroups,observerEnvPresence,overflow,registeredRuntimeVersion,rootDebugTransports,rootImageVersions,signature'||row.available!==true||row.overflow!==false)return fail();
  const {observedProcesses,observedRootGroups}=row;
  if(typeof observedProcesses!=='number'||!Number.isInteger(observedProcesses)||observedProcesses<0||observedProcesses>32||typeof observedRootGroups!=='number'||!Number.isInteger(observedRootGroups)||observedRootGroups<0||observedRootGroups>observedProcesses)return fail();
  if(!guiNumericVersion(row.registeredRuntimeVersion)||!guiNumericVersion(row.edgeDriverVersion)||!Array.isArray(row.rootImageVersions)||!row.rootImageVersions.every(guiNumericVersion)||new Set(row.rootImageVersions).size!==row.rootImageVersions.length||row.rootImageVersions.length>observedRootGroups)return fail();
  if(!['ELEVATED','NOT_ELEVATED','UNVERIFIED'].includes(row.appElevation as string))return fail();
  if(!windowsGuiIntegrityLevels.includes(row.appIntegrity as typeof windowsGuiIntegrityLevels[number]))return fail();
  if(!Array.isArray(row.rootDebugTransports)||row.rootDebugTransports.length!==observedRootGroups||!row.rootDebugTransports.every(value=>value&&typeof value==='object'&&Object.keys(value).sort().join(',')==='role,transport'&&windowsGuiRootRoles.includes(value.role)&&windowsGuiDebugTransports.includes(value.transport)))return fail();
  if(observedProcesses===0 ? observedRootGroups!==0||row.rootImageVersions.length!==0||row.signature!=='NONE_OBSERVED' : observedRootGroups===0||row.rootImageVersions.length===0||row.signature!=='MICROSOFT')return fail();
  const presence=row.observerEnvPresence;
  if(!presence||typeof presence!=='object'||Object.keys(presence).sort().join(',')!==Object.keys(windowsGuiOverrideNames).sort().join(','))return fail();
  const observerEnvPresence={} as Record<keyof typeof windowsGuiOverrideNames,boolean>;
  for(const key of Object.keys(windowsGuiOverrideNames) as (keyof typeof windowsGuiOverrideNames)[]){const flag=(presence as Record<string,unknown>)[key];if(typeof flag!=='boolean')return fail();observerEnvPresence[key]=flag;}
  return {available:true,overflow:false,appElevation:row.appElevation as 'ELEVATED'|'NOT_ELEVATED'|'UNVERIFIED',appIntegrity:row.appIntegrity as typeof windowsGuiIntegrityLevels[number],signature:row.signature as 'MICROSOFT'|'NONE_OBSERVED',observedProcesses,observedRootGroups,registeredRuntimeVersion:row.registeredRuntimeVersion,edgeDriverVersion:row.edgeDriverVersion,rootImageVersions:[...row.rootImageVersions].sort(),rootDebugTransports:[...row.rootDebugTransports].sort((a,b)=>(a.role+':'+a.transport).localeCompare(b.role+':'+b.transport)),observerEnvPresence,...(row.frontend!==undefined?{frontend:row.frontend as 'EXACT_ABOUT_ACTION_OBSERVED'|'UNVERIFIED'}:{})};
}
export function windowsGuiStartupProbe(stdout:unknown):{core:string;startup?:GuiStartup} {
  if(typeof stdout!=='string'||stdout.length>2097152)return {core:''};
  const prefix='LAZYSH_WINDOWS_GUI_STARTUP:';
  const lines=stdout.split(/\r?\n/),markers=lines.filter(line=>line.startsWith(prefix));
  const core=lines.filter(line=>!line.startsWith(prefix)).join('\n').trim();
  let startup:GuiStartup|undefined;
  if(markers.length){startup=startupUnavailable;if(markers.length===1&&markers[0].length<=4096)try{startup=parseWindowsGuiStartup(JSON.parse(markers[0].slice(prefix.length)));}catch{}}
  return {core:core.length<=8192?core:'',...(startup?{startup}:{})};
}
export function windowsGuiProbeDiagnostic(stdout:unknown):{phase:typeof windowsGuiProbePhases[number];roleMask?:number;metadata?:WindowsGuiMetadata} {
  const unverified={phase:'PROBE_UNVERIFIED'} as const;
  if(typeof stdout!=='string'||stdout.length>8192)return unverified;
  const lines=stdout.trim().split(/\r?\n/);
  if(lines.length>2||lines.length===2&&!lines[1].startsWith('LAZYSH_WINDOWS_GUI_METADATA:'))return unverified;
  const projected=windowsGuiMetadataProjection(stdout);
  const metadata=lines.length===2?(projected?parseWindowsGuiMetadata(JSON.parse(projected)):{available:false} as const):undefined;
  const match=/^LAZYSH_WINDOWS_GUI_PROBE:([A-Z_]+)(?::ROLES_([1-9][0-9]{0,3}))?$/.exec(lines[0]);
  const phase=windowsGuiProbePhases.find(phase=>phase===match?.[1]);
  if(!phase)return unverified;
  if(!match?.[2])return metadata?{phase,metadata}:{phase};
  const roleMask=Number(match[2]);
  return windowsGuiRoleSubset(phase,roleMask)?{phase,roleMask,...(metadata?{metadata}:{})}:unverified;
}

export const windowsGuiSessionOutcomes = ['CLIENT_TIMEOUT', 'NO_RESPONSE', 'NOT_CREATED', 'ARGUMENT', 'REMOTE_ERROR', 'SERVER_TIMEOUT', 'RESPONSE'] as const;
export const windowsGuiSessionGuards = windowsGuiSessionOutcomes.flatMap(outcome =>
  ['VERIFIED', 'UNVERIFIED'].map(window => `GUI_SESSION_${outcome}_WINDOW_${window}`));
export function windowsGuiSessionResponse(response:unknown):typeof windowsGuiSessionOutcomes[number] {
  const code=(response as {body?:{value?:{error?:unknown}}}|null)?.body?.value?.error;
  switch(code) {
    case 'session not created':return 'NOT_CREATED';
    case 'invalid argument':return 'ARGUMENT';
    case 'unknown error':return 'REMOTE_ERROR';
    case 'timeout':return 'SERVER_TIMEOUT';
    default:return 'RESPONSE';
  }
}
export function windowsGuiSessionNoResponse(error:unknown,port:number):typeof windowsGuiSessionOutcomes[number] {
  // Pinned webdriver 10.1.0 request/error.ts emits this exact message; utils.ts preserves
  // the message while wrapping the request error. Node serializes body to a string,
  // so getExecCmdArgs emits no args suffix. Match the entire known message only.
  const expected=`WebDriverError: Request timed out! Consider increasing the "connectionRetryTimeout" option. when running "http://127.0.0.1:${port}/session" with method "POST"`;
  return Number.isInteger(port) && port>0 && port<=65535 && error instanceof Error
    && error.message===expected ? 'CLIENT_TIMEOUT' : 'NO_RESPONSE';
}

// Standard W3C GET /status reports health only; ready=true does not promise NewSession success.
export const windowsGuiHealthStates = ['READY', 'NOT_READY', 'NO_RESPONSE', 'UNVERIFIED'] as const;
type GuiHealth = typeof windowsGuiHealthStates[number];
export async function windowsGuiStatus(port:number):Promise<GuiHealth> {
  if(!Number.isInteger(port)||port<1||port>65535)return 'UNVERIFIED';
  return new Promise(resolve=>{
    let complete=false;
    const finish=(state:GuiHealth)=>{if(!complete){complete=true;clearTimeout(deadline);resolve(state);}};
    const requestStatus=request({hostname:'127.0.0.1',port,path:'/status',method:'GET',agent:false},response=>{
      let bytes=0;const chunks:Buffer[]=[];
      if(response.statusCode!==200){finish('UNVERIFIED');response.destroy();return;}
      response.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(bytes>2048){finish('UNVERIFIED');response.destroy();return;}
        chunks.push(chunk);
      });
      response.on('error',()=>finish('NO_RESPONSE'));
      response.on('end',()=>{
        try {const ready=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.value?.ready;
          finish(ready===true?'READY':ready===false?'NOT_READY':'UNVERIFIED');
        } catch {finish('UNVERIFIED');}
      });
    });
    const deadline=setTimeout(()=>{finish('NO_RESPONSE');requestStatus.destroy();},1000);
    requestStatus.on('error',()=>finish('NO_RESPONSE'));
    requestStatus.end();
  });
}
export async function windowsGuiSessionHealth(ports:readonly number[], verify:()=>Promise<void>) {
  const unverified={proxy:'UNVERIFIED',native:'UNVERIFIED'} as const;
  try {
    if(ports.length!==2||ports[0]===ports[1])return unverified;
    await verify();
    const proxy=await windowsGuiStatus(ports[0]),native=await windowsGuiStatus(ports[1]);
    await verify();
    return {proxy,native};
  } catch {return unverified;}
}

export function windowsGuiToolEnvironment(driver:string,edge:string) {
  if([driver,edge].some(path=>!/^[a-z]:[\\/]/i.test(path) || path.includes('\0')))
    throw new Error('Windows GUI requires absolute tool paths');
  return {LAZYSH_GUI_DRIVER:win32.resolve(driver),LAZYSH_GUI_EDGE:win32.resolve(edge)};
}

export function isWindowsGuiDriverReceipt(receipt: unknown): boolean {
  const installed = (receipt as {installs?: Record<string, {version_req?: unknown; bins?: unknown}>} | null)
    ?.installs?.['tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)'];
  // Cargo tracks installed executable filenames, including the Windows .exe suffix.
  return installed?.version_req === '=2.1.0' && Array.isArray(installed.bins)
    && installed.bins.length === 1 && installed.bins[0] === 'tauri-driver.exe';
}

export const windowsInstallerPathsScript = String.raw`
function Require($condition, $code) {
  if (!$condition) { $script:failure = $code; throw 'Owned Windows acceptance rejected' }
}
function OptionalItem($path) {
  try { Get-Item -Force -LiteralPath $path -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { }
}
function Plain($path) {
  for ($current = $path; $current; $current = Split-Path -Parent $current) {
    $item = OptionalItem $current
    if ($item) { Require (!($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'REPARSE_POINT' }
  }
}
`;

// Exact roles from runtime-wry 2.12.3, Tao 0.37.2 and single-instance 2.5.4; never choose the first HWND.
export const windowsGuiWindowRoleScript = String.raw`
function GuiWindowRole($className, $style, $extended, $ownerless, $width, $height, $clientWidth, $clientHeight) {
  if ($className -isnot [string] -or $style -isnot [long] -or $extended -isnot [long] -or $ownerless -isnot [bool] -or $width -isnot [long] -or $height -isnot [long] -or $clientWidth -isnot [long] -or $clientHeight -isnot [long]) { return 'ROLE_DATA_UNVERIFIED' }
  $bits = $style -band 4294967295L
  $extra = $extended -band 4294967295L
  if ($className -ceq 'Tauri Window') {
    if (!$ownerless) { return 'MAIN_OWNER_MISMATCH' }
    if ($width -le 0 -or $height -le 0 -or $clientWidth -le 0 -or $clientHeight -le 0) { return 'MAIN_GEOMETRY_MISMATCH' }
    if (($bits -band 268435456L) -eq 0 -or ($bits -band 3221225472L) -ne 0 -or ($bits -band 13107200L) -ne 13107200L) { return 'MAIN_STYLE_MISMATCH' }
    if (($extra -band 262144L) -eq 0 -or ($extra -band 128L) -ne 0) { return 'MAIN_EXSTYLE_MISMATCH' }
    return 'MAIN'
  }
  # GetWindowRect may include invisible borders; helper intent is zero client area.
  if ($className -ceq 'Tao Thread Event Target' -or $className -ceq 'app.lazysh.client-sic') {
    if (!$ownerless) { return 'TAO_OWNER_MISMATCH' }
    if ($width -lt 0 -or $height -lt 0 -or $clientWidth -ne 0 -or $clientHeight -ne 0) { return 'TAO_GEOMETRY_MISMATCH' }
    if ($extra -ne 134742176L) { return 'TAO_EXSTYLE_MISMATCH' }
    if ($bits -notin @(2415919104L,2483027968L)) { return 'TAO_STYLE_MISMATCH' }
    return 'TAO_EVENT_HELPER'
  }
  return 'UNKNOWN_CLASS'
}
function GuiMainWindow($handles) {
  $script:roleMask = 0
  $roleReasons = @(${windowsGuiRoleReasons.map(reason=>"'"+reason+"'").join(', ')})
  if (@($handles | Where-Object { $_.Role -eq 'UNVERIFIED' }).Count -gt 0) { $script:phase = 'WINDOW_ROLE_UNVERIFIED'; throw 'window' }
  if (@($handles | Where-Object { $_.Handle -isnot [string] -or $_.Handle -notmatch '^[1-9][0-9]{0,19}$' }).Count -gt 0) { $script:phase = 'UNEXPECTED_VISIBLE_ROLE'; throw 'window' }
  $rejections = @($handles | Where-Object { $_.Role -notin @('MAIN', 'TAO_EVENT_HELPER') } | Select-Object -ExpandProperty Role -Unique)
  if ($rejections.Count -gt 0) {
    if (@($rejections | Where-Object { $_ -notin $roleReasons }).Count -eq 0) {
      for ($index=0; $index -lt $roleReasons.Count; $index++) {
        if ($roleReasons[$index] -in $rejections) { $script:roleMask = $script:roleMask -bor (1 -shl $index) }
      }
    }
    $script:phase = if ($rejections.Count -eq 1 -and $rejections[0] -in @('ROLE_DATA_UNVERIFIED', 'MAIN_OWNER_MISMATCH', 'MAIN_GEOMETRY_MISMATCH', 'MAIN_STYLE_MISMATCH', 'MAIN_EXSTYLE_MISMATCH', 'TAO_OWNER_MISMATCH', 'TAO_GEOMETRY_MISMATCH', 'TAO_STYLE_CLIPSIBLINGS_ONLY', 'TAO_STYLE_MISMATCH', 'TAO_EXSTYLE_MISMATCH', 'UNKNOWN_CLASS', 'MULTIPLE_ROLE_MISMATCHES')) { $rejections[0] } else { 'MULTIPLE_ROLE_MISMATCHES' }
    throw 'window'
  }
  $main = @($handles | Where-Object { $_.Role -eq 'MAIN' })
  if ($main.Count -eq 0) { $script:phase = 'NO_MAIN_WINDOW_OBSERVED'; throw 'window' }
  if ($main.Count -ne 1) { $script:phase = 'VISIBLE_HANDLES_AMBIGUOUS'; throw 'window' }
  return $main[0].Handle
}
`;

// Diagnostic only: retain data only while the originally verified application image stays live.
export const windowsGuiMetadataScript = String.raw`
function GuiImageIdentity($processId, $start, $image, $hash) {
  try {
    $current=Get-Process -Id $processId -ErrorAction Stop
    return ($current.StartTime.ToUniversalTime().Ticks.ToString() -ceq $start -and $current.Path -eq $image -and (Get-FileHash -LiteralPath $current.Path -Algorithm SHA256 -ErrorAction Stop).Hash -eq $hash)
  } catch { return $false }
}
function GuiMetadataImageFence($appId, $start) { return (GuiImageIdentity $appId $start $env:LAZYSH_GUI_BINARY $env:LAZYSH_NSIS_BINARY_SHA256) }
function GuiMetadataSnapshot {
  if (!$script:metadataEligible -or !$script:metadataComplete -or !(GuiMetadataImageFence $script:metadataAppId $script:metadataStart)) { return @{available=$false} }
  return @{available=$true;overflow=$script:metadataOverflow;windows=@($script:metadataWindows)}
}
`;

// Chromium dbeca94f3190b496ceb20437995b29aaf20f5370 base/command_line.cc:
// Windows tokenization, prefixes, ASCII key folding and -- terminator. Presence is not readiness.
export const windowsGuiDebugTransportScript=String.raw`
function GuiDebugArguments($arguments) {
  $unverified=@{role='UNVERIFIED';transport='UNVERIFIED'}
  if ($arguments -isnot [array] -or $arguments.Count -lt 1 -or $arguments.Count -gt 512 -or $arguments[0] -isnot [string]) { return $unverified }
  $transports=@();$types=@();$invalid=$false
  for ($index=1; $index -lt $arguments.Count; $index++) {
    $argument=$arguments[$index]
    if ($argument -isnot [string] -or $argument.Contains([char]0)) { return $unverified }
    # Non-ASCII whitespace has version-dependent trimming rules; do not infer absence from it.
    foreach ($character in $argument.ToCharArray()) {
      if ([int]$character -gt 127 -and ([char]::IsWhiteSpace($character) -or [int]$character -in @(8203,65279))) { return $unverified }
    }
    $arg=$argument.Trim([char[]]@(9,10,11,12,13,32))
    if ($arg -ceq '--') { break }
    if ($arg -cnotmatch '(?s)\A(?:--|-|/)([^=]+)(?:=(.*))?\z') { continue }
    $key=$Matches[1];$hasValue=$Matches.ContainsKey(2);$value=$Matches[2]
    if ($key -cmatch '[^\x00-\x7f]') { continue }
    $key=$key.ToLowerInvariant()
    if ($key -ceq 'single-argument') { return $unverified }
    if ($key -ceq 'type') {
      if ($value -cmatch '[^\x20-\x7e]') { return $unverified }
      $types += [string]$value
    } elseif ($key -ceq 'remote-debugging-pipe') {
      $transports += 'PIPE'
      if ($hasValue) { $invalid=$true }
    } elseif ($key -ceq 'remote-debugging-port') {
      $transports += 'FIXED_PORT'
      [int]$port=0
      if (!$hasValue -or $value -cnotmatch '\A(?:0|[1-9][0-9]{0,4})\z' -or ![int]::TryParse($value,[ref]$port) -or $port -gt 65535) { $invalid=$true }
      elseif ($port -eq 0) { $transports[-1]='EPHEMERAL_PORT' }
    }
  }
  $role=$(if ($types.Count -gt 1) {'AMBIGUOUS'} elseif ($types.Count -eq 1 -and $types[0].Length -gt 0) {'TYPED_CHILD'} else {'BROWSER_CANDIDATE'})
  $transport=$(if ($transports.Count -gt 1) {'AMBIGUOUS'} elseif ($invalid) {'UNVERIFIED'} elseif ($transports.Count -eq 0) {'ABSENT'} else {$transports[0]})
  return @{role=$role;transport=$transport}
}
function GuiDebugTransport($commandLine) {
  $unverified=@{role='UNVERIFIED';transport='UNVERIFIED'}
  try {
    if ($commandLine -isnot [string] -or $commandLine.Length -gt 32767 -or $commandLine.Contains([char]0) -or [string]::IsNullOrWhiteSpace($commandLine)) { return $unverified }
    # Lazy: native parser compilation/failure cannot erase the already emitted core proof.
    if (!('OwnedGuiArguments' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedGuiArguments {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string commandLine) {
    int count; IntPtr memory=CommandLineToArgvW(commandLine,out count);
    if(memory==IntPtr.Zero) throw new InvalidOperationException();
    try {
      if(count<1 || count>512) throw new InvalidOperationException();
      var result=new string[count];
      for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));
      return result;
    } finally { if(LocalFree(memory)!=IntPtr.Zero) throw new InvalidOperationException(); }
  }
}
'@ -ErrorAction Stop
    }
    return GuiDebugArguments ([OwnedGuiArguments]::Parse($commandLine.Trim([char[]]@(9,10,11,12,13,32))))
  } catch { return $unverified }
}
`;

// Query only the retained installed application's mandatory token label, never account/group data.
export const windowsGuiIntegritySource=String.raw`using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class OwnedGuiIntegrity {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint length,out uint required);
  [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] static extern bool GetTokenUInt(IntPtr token,int kind,out uint value,uint length,out uint used);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static string Classify(byte[] sid,int queryError) {
    if(queryError!=0 || sid==null || sid.Length!=12 || sid[0]!=1 || sid[1]!=1) return "UNVERIFIED";
    for(int i=2;i<7;i++) if(sid[i]!=0) return "UNVERIFIED";
    if(sid[7]!=16) return "UNVERIFIED"; // SECURITY_MANDATORY_LABEL_AUTHORITY, S-1-16.
    uint rid=(uint)sid[8]|((uint)sid[9]<<8)|((uint)sid[10]<<16)|((uint)sid[11]<<24);
    switch(rid) {
      case 0x1000:return "LOW";
      case 0x2000:return "MEDIUM";
      case 0x3000:return "HIGH";
      case 0x4000:return "SYSTEM";
      default:return "UNVERIFIED";
    }
  }
  public static string[] ReadToken(IntPtr token) {
    IntPtr memory=IntPtr.Zero;
    try {
      uint elevated,used;
      string elevation=GetTokenUInt(token,20,out elevated,4,out used)&&used==4&&elevated<=1?(elevated==0?"NOT_ELEVATED":"ELEVATED"):"UNVERIFIED";
      uint required;
      if(GetTokenInformation(token,25,IntPtr.Zero,0,out required) || Marshal.GetLastWin32Error()!=122 || required<(uint)(IntPtr.Size+4) || required>4096) return new[]{"UNVERIFIED","UNVERIFIED"};
      uint allocated=required;
      memory=Marshal.AllocHGlobal((int)allocated);
      if(!GetTokenInformation(token,25,memory,allocated,out required)) return new[]{"UNVERIFIED","UNVERIFIED"}; // TokenIntegrityLevel.
      if(required>allocated || required<(uint)(IntPtr.Size+4)) return new[]{"UNVERIFIED","UNVERIFIED"};
      long offset=checked(Marshal.ReadIntPtr(memory).ToInt64()-memory.ToInt64());
      if(offset<0 || offset>(long)required-12) return new[]{"UNVERIFIED","UNVERIFIED"};
      var sid=new byte[12];Marshal.Copy(IntPtr.Add(memory,(int)offset),sid,0,12);
      return new[]{Classify(sid,0),elevation};
    } catch {return new[]{"UNVERIFIED","UNVERIFIED"};}
    finally {if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);}
  }
  public static string[] Query(int processId,string expectedStart) {
    IntPtr process=IntPtr.Zero,token=IntPtr.Zero;
    try {
      long expected;
      if(processId<=0 || !long.TryParse(expectedStart,NumberStyles.None,CultureInfo.InvariantCulture,out expected) || expected<=0) return new[]{"UNVERIFIED","UNVERIFIED"};
      process=OpenProcess(0x1000,false,processId); // PROCESS_QUERY_LIMITED_INFORMATION only.
      if(process==IntPtr.Zero) return new[]{"UNVERIFIED","UNVERIFIED"};
      long created,exited,kernel,user;
      if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) return new[]{"UNVERIFIED","UNVERIFIED"};
      if(DateTime.FromFileTimeUtc(created).Ticks!=expected) return new[]{"IDENTITY_UNVERIFIED","UNVERIFIED"};
      if(!OpenProcessToken(process,0x0008,out token)) return new[]{"UNVERIFIED","UNVERIFIED"}; // TOKEN_QUERY only.
      return ReadToken(token);
    } catch { return new[]{"UNVERIFIED","UNVERIFIED"}; }
    finally {
      bool closed=true;
      if(token!=IntPtr.Zero) closed &= CloseHandle(token);
      if(process!=IntPtr.Zero) closed &= CloseHandle(process);
      if(!closed) throw new InvalidOperationException();
    }
  }
}`;
export const windowsGuiIntegrityScript=String.raw`
function GuiAppToken($appId, $start) {
  try {
    if (!('OwnedGuiIntegrity' -as [type])) {
      Add-Type -TypeDefinition @'
${windowsGuiIntegritySource}
'@ -ErrorAction Stop
    }
    return [OwnedGuiIntegrity]::Query([int]$appId,[string]$start)
  } catch { return @('UNVERIFIED','UNVERIFIED') }
}
function GuiAppIntegrity($appId,$start) { return (GuiAppToken $appId $start)[0] }
`;

// UIAutomationClient.h interface prefixes from microsoft/win32metadata commit
// 64ed9177fb76eb244fc9051c74b8a93fdfe20873, generation/WinSDK/RecompiledIdlHeaders/um.
// Native COM declarations retain every inherited slot through the last used method.
export const windowsGuiAccessibilitySource=String.raw`
using System;
using System.Runtime.InteropServices;
public static class OwnedGuiAccessibility {
  [ComImport,Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IUIAutomation2 {
    [PreserveSig] int CompareElements(IntPtr el1,IntPtr el2,out int areSame);
    [PreserveSig] int CompareRuntimeIds(IntPtr runtimeId1,IntPtr runtimeId2,out int areSame);
    [PreserveSig] int GetRootElement(out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandle(IntPtr hwnd,out IUIAutomationElement element);
    [PreserveSig] int ElementFromPoint(Point pt,out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElement(out IUIAutomationElement element);
    [PreserveSig] int GetRootElementBuildCache(IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement root);
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd,IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement element);
    [PreserveSig] int ElementFromPointBuildCache(Point pt,IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement element);
    [PreserveSig] int GetFocusedElementBuildCache(IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement element);
    [PreserveSig] int CreateTreeWalker(IntPtr pCondition,out IntPtr walker);
    [PreserveSig] int get_ControlViewWalker(out IntPtr walker);
    [PreserveSig] int get_ContentViewWalker(out IntPtr walker);
    [PreserveSig] int get_RawViewWalker(out IntPtr walker);
    [PreserveSig] int get_RawViewCondition(out IntPtr condition);
    [PreserveSig] int get_ControlViewCondition(out IntPtr condition);
    [PreserveSig] int get_ContentViewCondition(out IntPtr condition);
    [PreserveSig] int CreateCacheRequest(out IUIAutomationCacheRequest cacheRequest);
    [PreserveSig] int CreateTrueCondition(out IntPtr newCondition);
    [PreserveSig] int CreateFalseCondition(out IntPtr newCondition);
    [PreserveSig] int CreatePropertyCondition(int propertyId,[MarshalAs(UnmanagedType.Struct)] object value,out IntPtr newCondition);
    [PreserveSig] int CreatePropertyConditionEx(int propertyId,[MarshalAs(UnmanagedType.Struct)] object value,int flags,out IntPtr newCondition);
    [PreserveSig] int CreateAndCondition(IntPtr condition1,IntPtr condition2,out IntPtr newCondition);
    [PreserveSig] int CreateAndConditionFromArray(IntPtr conditions,out IntPtr newCondition);
    [PreserveSig] int CreateAndConditionFromNativeArray(IntPtr conditions,int conditionCount,out IntPtr newCondition);
    [PreserveSig] int CreateOrCondition(IntPtr condition1,IntPtr condition2,out IntPtr newCondition);
    [PreserveSig] int CreateOrConditionFromArray(IntPtr conditions,out IntPtr newCondition);
    [PreserveSig] int CreateOrConditionFromNativeArray(IntPtr conditions,int conditionCount,out IntPtr newCondition);
    [PreserveSig] int CreateNotCondition(IntPtr condition,out IntPtr newCondition);
    [PreserveSig] int AddAutomationEventHandler(int eventId,IntPtr element,int scope,IUIAutomationCacheRequest cacheRequest,IntPtr handler);
    [PreserveSig] int RemoveAutomationEventHandler(int eventId,IntPtr element,IntPtr handler);
    [PreserveSig] int AddPropertyChangedEventHandlerNativeArray(IntPtr element,int scope,IUIAutomationCacheRequest cacheRequest,IntPtr handler,IntPtr propertyArray,int propertyCount);
    [PreserveSig] int AddPropertyChangedEventHandler(IntPtr element,int scope,IUIAutomationCacheRequest cacheRequest,IntPtr handler,IntPtr propertyArray);
    [PreserveSig] int RemovePropertyChangedEventHandler(IntPtr element,IntPtr handler);
    [PreserveSig] int AddStructureChangedEventHandler(IntPtr element,int scope,IUIAutomationCacheRequest cacheRequest,IntPtr handler);
    [PreserveSig] int RemoveStructureChangedEventHandler(IntPtr element,IntPtr handler);
    [PreserveSig] int AddFocusChangedEventHandler(IUIAutomationCacheRequest cacheRequest,IntPtr handler);
    [PreserveSig] int RemoveFocusChangedEventHandler(IntPtr handler);
    [PreserveSig] int RemoveAllEventHandlers();
    [PreserveSig] int IntNativeArrayToSafeArray(IntPtr array,int arrayCount,out IntPtr safeArray);
    [PreserveSig] int IntSafeArrayToNativeArray(IntPtr intArray,out IntPtr array,out int arrayCount);
    [PreserveSig] int RectToVariant(Rect rc,[MarshalAs(UnmanagedType.Struct)] out object var);
    [PreserveSig] int VariantToRect([MarshalAs(UnmanagedType.Struct)] object var,out Rect rc);
    [PreserveSig] int SafeArrayToRectNativeArray(IntPtr rects,out IntPtr rectArray,out int rectArrayCount);
    [PreserveSig] int CreateProxyFactoryEntry(IntPtr factory,out IntPtr factoryEntry);
    [PreserveSig] int get_ProxyFactoryMapping(out IntPtr factoryMapping);
    [PreserveSig] int GetPropertyProgrammaticName(int property,out IntPtr name);
    [PreserveSig] int GetPatternProgrammaticName(int pattern,out IntPtr name);
    [PreserveSig] int PollForPotentialSupportedPatterns(IntPtr pElement,out IntPtr patternIds,out IntPtr patternNames);
    [PreserveSig] int PollForPotentialSupportedProperties(IntPtr pElement,out IntPtr propertyIds,out IntPtr propertyNames);
    [PreserveSig] int CheckNotSupported([MarshalAs(UnmanagedType.Struct)] object value,out int isNotSupported);
    [PreserveSig] int get_ReservedNotSupportedValue(out IntPtr notSupportedValue);
    [PreserveSig] int get_ReservedMixedAttributeValue(out IntPtr mixedAttributeValue);
    [PreserveSig] int ElementFromIAccessible(IntPtr accessible,int childId,out IUIAutomationElement element);
    [PreserveSig] int ElementFromIAccessibleBuildCache(IntPtr accessible,int childId,IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement element);
    [PreserveSig] int get_AutoSetFocus(out int autoSetFocus);
    [PreserveSig] int put_AutoSetFocus(int autoSetFocus);
    [PreserveSig] int get_ConnectionTimeout(out uint timeout);
    [PreserveSig] int put_ConnectionTimeout(uint timeout);
    [PreserveSig] int get_TransactionTimeout(out uint timeout);
    [PreserveSig] int put_TransactionTimeout(uint timeout);
  }
  [ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IUIAutomationElement {
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(int scope,IntPtr condition,out IUIAutomationElement found);
    [PreserveSig] int FindAll(int scope,IntPtr condition,out IUIAutomationElementArray found);
    [PreserveSig] int FindFirstBuildCache(int scope,IntPtr condition,IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement found);
    [PreserveSig] int FindAllBuildCache(int scope,IntPtr condition,IUIAutomationCacheRequest cacheRequest,out IUIAutomationElementArray found);
    [PreserveSig] int BuildUpdatedCache(IUIAutomationCacheRequest cacheRequest,out IUIAutomationElement updatedElement);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId,[MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCurrentPropertyValueEx(int propertyId,int ignoreDefaultValue,[MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCachedPropertyValue(int propertyId,[MarshalAs(UnmanagedType.Struct)] out object retVal);
    [PreserveSig] int GetCachedPropertyValueEx(int propertyId,int ignoreDefaultValue,[MarshalAs(UnmanagedType.Struct)] out object retVal);
  }
  [ComImport,Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IUIAutomationCacheRequest {
    [PreserveSig] int AddProperty(int propertyId);
    [PreserveSig] int AddPattern(int patternId);
    [PreserveSig] int Clone(out IUIAutomationCacheRequest clonedRequest);
    [PreserveSig] int get_TreeScope(out int scope);
    [PreserveSig] int put_TreeScope(int scope);
  }
  [ComImport,Guid("14314595-b4bc-4055-95f2-58f2e42c9855"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IUIAutomationElementArray {
    [PreserveSig] int get_Length(out int length);
    [PreserveSig] int GetElement(int index,out IUIAutomationElement element);
  }
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint mode);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out IUIAutomation2 client);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first,IntPtr second);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rectangle);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static void Need(bool value){if(!value)throw new InvalidOperationException();}
  static void Ok(int result){Need(result>=0);}
  static bool Finite(double value){return !double.IsNaN(value)&&!double.IsInfinity(value)&&Math.Abs(value)<=100000;}
  static bool About(string expected,string name,int control,bool enabled,bool offscreen,int provider,int[] owned,double[] bounds,double[] client){
    if(expected==null||!String.Equals(name,expected,StringComparison.Ordinal)||control!=50000||!enabled||offscreen||provider<=0||owned==null||owned.Length==0||owned.Length>33||Array.IndexOf(owned,provider)<0||bounds==null||bounds.Length!=4||client==null||client.Length!=4)return false;
    foreach(double value in bounds)if(!Finite(value))return false;foreach(double value in client)if(!Finite(value))return false;
    return bounds[2]>0&&bounds[3]>0&&client[2]>client[0]&&client[3]>client[1]&&Finite(bounds[0]+bounds[2])&&Finite(bounds[1]+bounds[3])&&bounds[0]>=client[0]&&bounds[1]>=client[1]&&bounds[0]+bounds[2]<=client[2]&&bounds[1]+bounds[3]<=client[3];
  }
  static double[] Client(IntPtr window,int process){uint owner;Need(GetWindowThreadProcessId(window,out owner)!=0&&owner==process&&IsWindowVisible(window)&&GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())==2&&GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window))==2);Rect rectangle;Need(GetClientRect(window,out rectangle)&&rectangle.Left==0&&rectangle.Top==0&&rectangle.Right>0&&rectangle.Bottom>0);var top=new Point();var bottom=new Point{X=rectangle.Right,Y=rectangle.Bottom};Need(ClientToScreen(window,ref top)&&ClientToScreen(window,ref bottom));return new double[]{top.X,top.Y,bottom.X,bottom.Y};}
  static object Cached(IUIAutomationElement element,int property){object value;Ok(element.GetCachedPropertyValueEx(property,1,out value));if(value!=null&&Marshal.IsComObject(value)){Release(value);throw new InvalidOperationException();}return value;}
  static void Remember(int status,IntPtr condition,System.Collections.Generic.List<IntPtr> conditions){if(condition!=IntPtr.Zero)conditions.Add(condition);Ok(status);Need(condition!=IntPtr.Zero);}
  static bool Release(object value){try{if(value!=null)Marshal.FinalReleaseComObject(value);return true;}catch{return false;}}
  static int Inspect(IntPtr window,int process,string version,int[] owned){
    IUIAutomation2 client=null;IUIAutomationCacheRequest cache=null;IUIAutomationElement root=null,button=null;IUIAutomationElementArray found=null;var conditions=new System.Collections.Generic.List<IntPtr>();IntPtr previous=IntPtr.Zero;bool initialized=false;int result=0;
    try{Ok(CoInitializeEx(IntPtr.Zero,0));initialized=true;previous=SetThreadDpiAwarenessContext(new IntPtr(-4));Need(previous!=IntPtr.Zero&&GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())==2);var rectangle=Client(window,process);
      var clsid=new Guid("e22ad333-b25f-460c-83d0-0581107395c9");var iid=typeof(IUIAutomation2).GUID;Ok(CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out client));Ok(client.put_ConnectionTimeout(250));Ok(client.put_TransactionTimeout(250));Ok(client.CreateCacheRequest(out cache));
      foreach(int property in new[]{30001,30002,30003,30005,30010,30020,30022})Ok(cache.AddProperty(property));Ok(cache.put_TreeScope(1));Ok(client.ElementFromHandleBuildCache(window,cache,out root));
      object rootProcess=Cached(root,30002),rootWindow=Cached(root,30020);Need(rootProcess is int&&(int)rootProcess==process&&rootWindow is int&&unchecked((uint)(int)rootWindow)==window.ToInt64());
      string expected="About lazysh · "+version;IntPtr name,type,condition;Remember(client.CreatePropertyCondition(30005,expected,out name),name,conditions);Remember(client.CreatePropertyCondition(30003,50000,out type),type,conditions);Remember(client.CreateAndCondition(name,type,out condition),condition,conditions);
      Ok(root.FindAllBuildCache(4,condition,cache,out found));Need(found!=null);int count;Ok(found.get_Length(out count));Need(count==1);Ok(found.GetElement(0,out button));
      object actualName=Cached(button,30005),actualType=Cached(button,30003),enabled=Cached(button,30010),offscreen=Cached(button,30022),provider=Cached(button,30002),bounds=Cached(button,30001);
      Need(actualName is string&&actualType is int&&enabled is bool&&offscreen is bool&&provider is int&&About(expected,(string)actualName,(int)actualType,(bool)enabled,(bool)offscreen,(int)provider,owned,bounds as double[],rectangle));
      var after=Client(window,process);for(int index=0;index<4;index++)Need(after[index]==rectangle[index]);result=(int)provider;
    }catch{result=0;}
    finally{bool clean=true;clean&=Release(button);clean&=Release(found);clean&=Release(root);clean&=Release(cache);foreach(var condition in conditions)try{Need(condition!=IntPtr.Zero);Marshal.Release(condition);}catch{clean=false;}clean&=Release(client);
      if(initialized)try{CoUninitialize();}catch{clean=false;}
      if(previous!=IntPtr.Zero)try{clean&=SetThreadDpiAwarenessContext(previous)!=IntPtr.Zero&&AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),previous);}catch{clean=false;}if(!clean)result=0;
    }return result;
  }
  public static int Observe(long handle,int process,string version,int[] owned){
    if(handle<=0||handle>uint.MaxValue||process<=0||version==null||!System.Text.RegularExpressions.Regex.IsMatch(version,@"\A[0-9]{1,6}(?:\.[0-9]{1,6}){2}\z")||owned==null||owned.Length<1||owned.Length>33)return 0;
    int result=0;var thread=new System.Threading.Thread(()=>{result=Inspect(new IntPtr(handle),process,version,owned);});thread.IsBackground=true;thread.SetApartmentState(System.Threading.ApartmentState.MTA);thread.Start();return thread.Join(2000)?result:0;
  }
}
`;

export const windowsGuiStartupScript=String.raw`
${windowsGuiDebugTransportScript}
${windowsGuiIntegrityScript}
function GuiNumericVersion($value) {
  return ($value -is [string] -and $value -cmatch '\A(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){3}\z' -and $value -cne '0.0.0.0' -and @($value.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count -eq 0)
}
# CIM_DATETIME/MMI represents microseconds (10 .NET ticks); never use a broader allowance.
function GuiCreationTicks($row) {
  if ($row.CreationDate -isnot [DateTime] -or $row.CreationDate.Kind -eq [DateTimeKind]::Unspecified) { throw 'creation' }
  [long]$created=$row.CreationDate.ToUniversalTime().Ticks
  if ($created -le 0 -or $created % 10L -ne 0) { throw 'creation' }
  return $created
}
function GuiInventoryLifetime($row, $start) {
  [long]$ticks=0
  if ($start -isnot [string] -or $start -cnotmatch '\A[1-9][0-9]{0,18}\z' -or ![long]::TryParse($start,[ref]$ticks) -or $ticks -gt [DateTime]::MaxValue.Ticks) { return $false }
  try { return ((GuiCreationTicks $row) -eq ($ticks - ($ticks % 10L))) } catch { return $false }
}
function GuiRuntimeRoots($inventory, $memberIds, $driverId) {
  $rows=@{}
  foreach ($row in $inventory) {
    $id=[int]$row.ProcessId
    if ($id -le 0 -or $rows.ContainsKey($id)) { throw 'inventory' }
    $null=GuiCreationTicks $row
    $rows[$id]=$row
  }
  if (!$rows.ContainsKey([int]$driverId) -or $driverId -in $memberIds -or $memberIds.Count -gt 32 -or @($memberIds | Select-Object -Unique).Count -ne $memberIds.Count) { throw 'members' }
  $roots=@()
  foreach ($memberId in $memberIds) {
    $current=[int]$memberId;$seen=@();$hasRuntimeAncestor=$false
    for ($depth=0; $depth -le 16; $depth++) {
      if ($current -eq $driverId) { break }
      if ($current -in $seen -or !$rows.ContainsKey($current) -or $depth -eq 16) { throw 'ancestry' }
      $seen += $current
      $parent=[int]$rows[$current].ParentProcessId
      if (!$rows.ContainsKey($parent) -or (GuiCreationTicks $rows[$parent]) -gt (GuiCreationTicks $rows[$current])) { throw 'ancestry lifetime' }
      $current=$parent
      if ($current -in $memberIds) { $hasRuntimeAncestor=$true }
    }
    if (!$hasRuntimeAncestor) { $roots += [int]$memberId }
  }
  return $roots
}
function GuiAccessibility($providerIds) {
  try {
    if ($env:LAZYSH_GUI_ACCESSIBILITY_PROBE -cne '1') { return 'UNVERIFIED' }
    $source=[Console]::In.ReadToEnd()
    if (!$source -or [Text.Encoding]::UTF8.GetByteCount($source) -gt 65536) { return 'UNVERIFIED' }
    Add-Type -TypeDefinition $source -ErrorAction Stop
    $provider=[OwnedGuiAccessibility]::Observe([long]$mainHandle,[int]$script:metadataAppId,$env:LAZYSH_VERSION,[int[]]$providerIds)
    if ($provider -gt 0 -and $provider -in $providerIds) { return 'EXACT_ABOUT_ACTION_OBSERVED' }
  } catch { }
  return 'UNVERIFIED'
}
function GuiStartupSnapshot {
  $unverified=@{available=$false;overflow=$false;signature='UNVERIFIED'}
  try {
    if (!$complete -or !$script:metadataEligible -or !$inventory) { return $unverified }
    $fences=@(
      @{Id=[int]$env:LAZYSH_GUI_DRIVER_PID;Start=$env:LAZYSH_GUI_DRIVER_START;Image=$env:LAZYSH_GUI_DRIVER;Hash=$env:LAZYSH_GUI_DRIVER_SHA256},
      @{Id=[int]$env:LAZYSH_GUI_EDGE_PID;Start=$env:LAZYSH_GUI_EDGE_START;Image=$env:LAZYSH_GUI_EDGE;Hash=$env:LAZYSH_GUI_EDGE_SHA256},
      @{Id=$script:metadataAppId;Start=$script:metadataStart;Image=$env:LAZYSH_GUI_BINARY;Hash=$env:LAZYSH_NSIS_BINARY_SHA256}
    )
    foreach ($fence in $fences) {
      $original=@($inventory | Where-Object { [int]$_.ProcessId -eq $fence.Id -and $_.ExecutablePath -eq $fence.Image })
      if ($original.Count -ne 1 -or !(GuiInventoryLifetime $original[0] $fence.Start) -or !(GuiImageIdentity $fence.Id $fence.Start $fence.Image $fence.Hash)) { return $unverified }
    }
    if (@($inventory | Where-Object { !$_.Name -or !$_.ExecutablePath }).Count -gt 0) { return $unverified }
    $members=@($inventory | Where-Object { $_.Name -ieq 'msedgewebview2.exe' })
    if ($members.Count -gt 32) { $unverified.overflow=$true;return $unverified }
    $images=@{};$retained=@{}
    foreach ($member in $members) {
      $process=Get-Process -Id $member.ProcessId -ErrorAction Stop
      $start=$process.StartTime.ToUniversalTime().Ticks.ToString()
      if (!(GuiInventoryLifetime $member $start)) { return $unverified }
      $image=$process.Path
      if ($image -ne $member.ExecutablePath -or [IO.Path]::GetFileName($image) -ine 'msedgewebview2.exe') { return $unverified }
      $hash=(Get-FileHash -LiteralPath $image -Algorithm SHA256 -ErrorAction Stop).Hash
      if (!(GuiImageIdentity $process.Id $start $image $hash)) { return $unverified }
      if (!$images.ContainsKey($image)) {
        $signature=Get-AuthenticodeSignature -LiteralPath $image -ErrorAction Stop
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)') { return $unverified }
        $imageVersion=(Get-Item -LiteralPath $image -ErrorAction Stop).VersionInfo.ProductVersion
        if (!(GuiNumericVersion $imageVersion)) { return $unverified }
        $images[$image]=@{Hash=$hash;Version=$imageVersion}
      }
      if ($images[$image].Hash -ne $hash) { return $unverified }
      $fence=@{Id=$process.Id;Start=$start;Image=$image;Hash=$hash}
      $fences += $fence;$retained[[int]$process.Id]=$fence
    }
    $roots=@(GuiRuntimeRoots $inventory @($members | ForEach-Object { [int]$_.ProcessId }) ([int]$env:LAZYSH_GUI_DRIVER_PID))
    $versions=@($roots | ForEach-Object { $images[$retained[$_].Image].Version } | Sort-Object -Unique)
    $transports=@($roots | ForEach-Object { $rootId=$_;$row=@($inventory | Where-Object { [int]$_.ProcessId -eq $rootId });$line=$null;if ($row[0].PSObject.Properties['CommandLine']) { $line=$row[0].CommandLine };[PSCustomObject](GuiDebugTransport $line) } | Sort-Object role,transport)
    $registered=$env:LAZYSH_GUI_RUNTIME_VERSION
    $edgeVersion=(Get-Item -LiteralPath $env:LAZYSH_GUI_EDGE -ErrorAction Stop).VersionInfo.ProductVersion
    if (!(GuiNumericVersion $registered) -or !(GuiNumericVersion $edgeVersion)) { return $unverified }
    $tokenFact=GuiAppToken $script:metadataAppId $script:metadataStart
    $integrity=$tokenFact[0];$elevation=$tokenFact[1]
    if ($integrity -ceq 'IDENTITY_UNVERIFIED') { return $unverified }
    if ($integrity -cnotin @('LOW','MEDIUM','HIGH','SYSTEM','UNVERIFIED')) { $integrity='UNVERIFIED' }
    if ($elevation -cnotin @('ELEVATED','NOT_ELEVATED','UNVERIFIED')) { $elevation='UNVERIFIED' }
    $frontend=$null
    if ($env:LAZYSH_GUI_ACCESSIBILITY_PROBE -ceq '1') { $frontend='UNVERIFIED';if ($integrity -ceq 'HIGH' -and $elevation -ceq 'ELEVATED') { $frontend=GuiAccessibility (@([int]$script:metadataAppId)+@($retained.Keys)) } }
    foreach ($fence in $fences) { if (!(GuiImageIdentity $fence.Id $fence.Start $fence.Image $fence.Hash)) { return $unverified } }
    # Snapshot groups only: no observed owned runtime does not prove it never started or crashed.
    $snapshot=@{available=$true;overflow=$false;appIntegrity=$integrity;appElevation=$elevation;signature=$(if ($members.Count) {'MICROSOFT'} else {'NONE_OBSERVED'});observedProcesses=$members.Count;observedRootGroups=$roots.Count;registeredRuntimeVersion=$registered;edgeDriverVersion=$edgeVersion;rootImageVersions=$versions;rootDebugTransports=$transports;observerEnvPresence=@{${Object.entries(windowsGuiOverrideNames).map(([key,name])=>key+"=(Test-Path -LiteralPath 'Env:"+name+"')").join(';')}}}
    if ($frontend) { $snapshot.frontend=$frontend }
    return $snapshot
  } catch { return $unverified }
}
`;

// Windows-only installed GUI acceptance. Paths are supplied exclusively through the child environment.
export const windowsGuiOwnerScript = String.raw`
${windowsGuiWindowRoleScript}
${windowsGuiMetadataScript}
${windowsGuiStartupScript}
$ErrorActionPreference = 'Stop'
$phase = 'PROBE_UNVERIFIED'
$script:roleMask = 0
$script:metadataEligible=$false
$script:metadataComplete=$false
$script:metadataOverflow=$false
$script:metadataWindows=@()
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedGuiWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr window, StringBuilder value, int length);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
  $phase = 'DRIVER_IDENTITY_UNVERIFIED'
  $driver = Get-Process -Id ([int]$env:LAZYSH_GUI_DRIVER_PID)
  if ($driver.StartTime.ToUniversalTime().Ticks.ToString() -ne $env:LAZYSH_GUI_DRIVER_START -or $driver.Path -ne $env:LAZYSH_GUI_DRIVER) { throw 'owner' }
  $phase = 'OWNED_INVENTORY_UNVERIFIED'
  $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
  $owned = @([int]$driver.Id)
  $complete = $false
  for ($depth=0; $depth -lt 16; $depth++) {
    $next = @($all | Where-Object { [int]$_.ParentProcessId -in $owned -and [int]$_.ProcessId -notin $owned })
    if (!$next.Count) { $complete = $true; break }
    $owned += @($next | ForEach-Object { [int]$_.ProcessId })
    if ($owned.Count -gt 128) { throw 'bound' }
  }
  $inventory = @($all | Where-Object { [int]$_.ProcessId -in $owned })
  $apps = @($inventory | Where-Object { $_.ExecutablePath -eq $env:LAZYSH_GUI_BINARY })
  if ($apps.Count -eq 0) {
    $retainedDriver = Get-Process -Id $driver.Id
    if ($retainedDriver.StartTime.ToUniversalTime().Ticks.ToString() -eq $env:LAZYSH_GUI_DRIVER_START -and $retainedDriver.Path -eq $env:LAZYSH_GUI_DRIVER -and $complete -and @($inventory | Where-Object { $_.ProcessId -eq $driver.Id -and $_.ExecutablePath -eq $env:LAZYSH_GUI_DRIVER }).Count -eq 1 -and @($inventory | Where-Object { !$_.ExecutablePath }).Count -eq 0) { $phase = 'EXPECTED_IMAGE_CANDIDATE_ABSENT' }
    throw 'application'
  }
  $phase = 'IMAGE_IDENTITY_UNVERIFIED'
  if ($apps.Count -ne 1) { throw 'application' }
  $app = Get-Process -Id $apps[0].ProcessId
  if ($app.Path -ne $env:LAZYSH_GUI_BINARY -or (Get-FileHash -LiteralPath $app.Path -Algorithm SHA256).Hash -ne $env:LAZYSH_NSIS_BINARY_SHA256) { throw 'image' }
  $script:metadataAppId=$app.Id
  $script:metadataStart=$app.StartTime.ToUniversalTime().Ticks.ToString()
  $script:metadataEligible=GuiMetadataImageFence $script:metadataAppId $script:metadataStart
  $script:metadataReadable=$true
  $phase = 'WINDOW_UNVERIFIED'
  $script:windows = @()
  $script:ownedHandles = 0
  $callback = [OwnedGuiWindow+Callback] {
    param($window, $state)
    [uint32]$owner = 0
    $null = [OwnedGuiWindow]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -eq $app.Id) {
      $script:ownedHandles += 1
      if ([OwnedGuiWindow]::IsWindowVisible($window)) {
        $name = [Text.StringBuilder]::new(256)
        $rectangle = [OwnedGuiWindow+Rect]::new()
        $clientRectangle = [OwnedGuiWindow+Rect]::new()
        $role = 'UNVERIFIED'
        if ([OwnedGuiWindow]::GetClassNameW($window, $name, 256) -gt 0 -and [OwnedGuiWindow]::GetWindowRect($window, [ref]$rectangle) -and [OwnedGuiWindow]::GetClientRect($window, [ref]$clientRectangle) -and $clientRectangle.Left -eq 0 -and $clientRectangle.Top -eq 0) {
          $className=$name.ToString()
          $style=[OwnedGuiWindow]::GetWindowLongPtrW($window, -16).ToInt64()
          $extended=[OwnedGuiWindow]::GetWindowLongPtrW($window, -20).ToInt64()
          $ownerless=([OwnedGuiWindow]::GetWindow($window, 4) -eq [IntPtr]::Zero)
          [long]$width=[long]$rectangle.Right - $rectangle.Left
          [long]$height=[long]$rectangle.Bottom - $rectangle.Top
          [long]$clientWidth=$clientRectangle.Right
          [long]$clientHeight=$clientRectangle.Bottom
          $role = GuiWindowRole $className $style $extended $ownerless $width $height $clientWidth $clientHeight
          [uint32]$retainedOwner=0
          $retainedThread=[OwnedGuiWindow]::GetWindowThreadProcessId($window,[ref]$retainedOwner)
          if ($retainedThread -eq 0 -or $retainedOwner -ne $app.Id -or ![OwnedGuiWindow]::IsWindowVisible($window)) { $script:metadataReadable=$false }
          if ($className -cnotmatch '\A[\x20-\x7e]{1,128}\z' -or $className -match '[/\\]' -or [Math]::Abs($width) -gt 100000 -or [Math]::Abs($height) -gt 100000 -or [Math]::Abs($clientWidth) -gt 100000 -or [Math]::Abs($clientHeight) -gt 100000) { $script:metadataReadable=$false }
          elseif ($script:metadataWindows.Count -lt 8) { $script:metadataWindows += @{className=$className;style=($style -band 4294967295L);exstyle=($extended -band 4294967295L);width=$width;height=$height;clientWidth=$clientWidth;clientHeight=$clientHeight;ownerless=$ownerless} }
          else { $script:metadataOverflow=$true }
        } else { $script:metadataReadable=$false }
        $script:windows += [PSCustomObject]@{Handle=$window.ToInt64().ToString();Role=$role}
      }
    }
    return $true
  }
  if (![OwnedGuiWindow]::EnumWindows($callback, [IntPtr]::Zero)) { $phase = 'WINDOW_ENUMERATION_FAILED'; throw 'window' }
  $script:metadataComplete=$script:metadataReadable
  if ($script:ownedHandles -eq 0) { $phase = 'NO_OWNED_HANDLES_OBSERVED'; throw 'window' }
  if ($script:windows.Count -eq 0) { $phase = 'OWNED_HANDLES_INVISIBLE'; throw 'window' }
  $mainHandle = GuiMainWindow $script:windows
  [Console]::Out.WriteLine((@{pid=$app.Id;start=$app.StartTime.ToUniversalTime().Ticks.ToString();window=$mainHandle;sha256=$env:LAZYSH_NSIS_BINARY_SHA256} | ConvertTo-Json -Compress))
} catch {
  $label = 'LAZYSH_WINDOWS_GUI_PROBE:' + $phase
  if ($script:roleMask -gt 0) { $label += ':ROLES_' + $script:roleMask }
  [Console]::Out.WriteLine($label)
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_METADATA:' + ((GuiMetadataSnapshot) | ConvertTo-Json -Depth 4 -Compress))
  exit 1
} finally {
  if ($env:LAZYSH_GUI_STARTUP_PROBE -eq '1') { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_STARTUP:' + ((GuiStartupSnapshot) | ConvertTo-Json -Depth 4 -Compress)) }
}
`;

export function parseWindowsGuiOwner(value:string, expectedHash:string) {
  if(value.length>1024)throw new Error('Invalid owned Windows GUI identity');
  const parsed=JSON.parse(value);
  if(!parsed || Object.keys(parsed).sort().join(',')!=='pid,sha256,start,window'
    || !Number.isSafeInteger(parsed.pid) || parsed.pid<=0
    || typeof parsed.start!=='string' || typeof parsed.window!=='string'
    || !/^[1-9][0-9]{0,19}$/.test(parsed.start) || !/^[1-9][0-9]{0,19}$/.test(parsed.window)
    || !/^[a-f0-9]{64}$/.test(expectedHash) || parsed.sha256!==expectedHash)
    throw new Error('Invalid owned Windows GUI identity');
  return parsed as {pid:number;start:string;window:string;sha256:string};
}

export const windowsGuiEndpointsScript = String.raw`
function GuiEndpoints($sockets, $ports, $driverId, $nativeId) {
  Require ($ports.Count -eq 2 -and $ports[0] -ne $ports[1] -and $sockets.Count -ge 2 -and $sockets.Count -le 4) 'GUI_ENDPOINT'
  Require (@($sockets | Where-Object { $_.LocalPort -notin $ports -or $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -eq 0) 'GUI_LISTENER_ADDRESS'
  Require (@($sockets | Group-Object -Property LocalPort, LocalAddress | Where-Object { $_.Count -ne 1 }).Count -eq 0) 'GUI_ENDPOINT'
  foreach ($port in $ports) {
    Require (@($sockets | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -eq '127.0.0.1' }).Count -eq 1) 'GUI_IPV4_REQUIRED'
    $expectedId = if ($port -eq $ports[0]) { $driverId } else { $nativeId }
    Require (@($sockets | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -ne $expectedId }).Count -eq 0) 'GUI_ENDPOINT'
  }
}
`;
export const windowsGuiHealthOwnershipScript = String.raw`
function GuiHealthOwnership {
  foreach ($role in @('DRIVER','EDGE')) {
    $image=[Environment]::GetEnvironmentVariable('LAZYSH_GUI_'+$role)
    $process=Get-Process -Id ([int][Environment]::GetEnvironmentVariable('LAZYSH_GUI_'+$role+'_PID'))
    if ($process.Path -ne $image -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne [Environment]::GetEnvironmentVariable('LAZYSH_GUI_'+$role+'_START') -or (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash -ne [Environment]::GetEnvironmentVariable('LAZYSH_GUI_'+$role+'_SHA256')) { throw 'identity' }
  }
  $ports=@([int]$env:LAZYSH_GUI_PORT,[int]$env:LAZYSH_GUI_NATIVE_PORT)
  $sockets=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in $ports })
  GuiEndpoints $sockets $ports ([int]$env:LAZYSH_GUI_DRIVER_PID) ([int]$env:LAZYSH_GUI_EDGE_PID)
}
`;
export const windowsGuiHealthOwnerScript = String.raw`
${windowsInstallerPathsScript}
${windowsGuiEndpointsScript}
${windowsGuiHealthOwnershipScript}
$ErrorActionPreference='Stop'
try { GuiHealthOwnership; [Console]::Out.Write('VERIFIED') } catch { exit 1 }
`;

export const windowsGuiMediumScript=String.raw`
function NewGuiMediumJob {
  Require ($guiMediumSource -is [string] -and $guiMediumSource.Length -gt 0 -and $guiMediumSource.Length -le 65536) 'GUI_MEDIUM_UNAVAILABLE'
  if (!('OwnedMediumGui' -as [type])) { Add-Type -TypeDefinition $guiMediumSource -ErrorAction Stop }
  return [OwnedMediumGui]::new()
}
function GuiMediumStart($job,$info,$probeDeadline=0) {
  $entries=@($info.Environment.Keys | Sort-Object | ForEach-Object { $_+'='+$info.Environment[$_] })
  $block=[string]::Join([char]0,$entries)+[char]0+[char]0
  if ($probeDeadline -gt 0) { return $job.StartProbe($info.FileName,[string[]]@($info.ArgumentList),$info.WorkingDirectory,$block,[long]$probeDeadline) }
  return $job.Start($info.FileName,[string[]]@($info.ArgumentList),$info.WorkingDirectory,$block)
}
`;

export const windowsInstalledGuiScript = String.raw`
${windowsGuiEndpointsScript}
${windowsGuiMediumScript}
function GuiProcess($file, $arguments, $counterfactual = $false, $medium = $false) {
  Plain $file
  $info = [Diagnostics.ProcessStartInfo]::new($file)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WorkingDirectory = $env:LAZYSH_GUI_CLIENT_ROOT
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  if ($file -eq $env:LAZYSH_GUI_NODE) {
    $info.Environment['LAZYSH_GUI_COUNTERFACTUAL'] = $(if ($counterfactual -and !$medium) {'1'} else {'0'})
    $info.Environment['LAZYSH_GUI_MEDIUM_ARM'] = $(if ($medium) {'1'} else {'0'})
    if ($medium) { $info.Environment['LAZYSH_GUI_MEDIUM_ROOTS']=(@($roaming,$local,$directory) | ConvertTo-Json -Compress) }
  }
  foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
  if ($medium) { return GuiMediumStart $mediumJob $info }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  Require ($process.Start()) 'GUI_START'
  $null = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $null = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  return $process
}
function GuiDirectory($path) {
  Plain $path
  Require (!(OptionalItem $path)) 'UNEXPECTED_DATA'
  $null = New-Item -ItemType Directory -Path $path
  $sentinel = Join-Path $path $guiSentinel
  $null = New-Item -ItemType File -Path $sentinel -Value $content
  $script:guiRoots += $path
}
function RemoveGuiDirectory($path) {
  Plain $path
  Require ((Get-Content -Raw -LiteralPath (Join-Path $path $guiSentinel)) -ceq $content) 'GUI_DATA'
  $items = @(Get-ChildItem -LiteralPath $path -Force -Recurse)
  Require ($items.Count -le 4096) 'GUI_DATA'
  foreach ($item in $items) { Plain $item.FullName }
  Remove-Item -LiteralPath $path -Recurse
}
function GuiCounterfactual($baselineFailure) {
  try {
    if ($baselineFailure -cnotmatch '\AGUI_SESSION_[A-Z_]+_WINDOW_VERIFIED:HEALTH_(READY|NOT_READY|NO_RESPONSE|UNVERIFIED)_NATIVE_(READY|NOT_READY|NO_RESPONSE|UNVERIFIED)\z') { return }
    if (!$guiCleanupVerified) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:NOT_RUN_CLEANUP');return }
    # Same 600-second parent: reserve 420 seconds for client/startup, owned cleanup and native uninstall.
    $elapsed=[Environment]::TickCount64-$guiParentStarted
    if ($elapsed -lt 0 -or $elapsed -gt 180000) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:NOT_RUN_BUDGET');return }
    $script:failure='UNEXPECTED'
    Installed
    foreach ($tool in @(@{Path=$env:LAZYSH_GUI_DRIVER;Hash=$env:LAZYSH_GUI_DRIVER_SHA256},@{Path=$env:LAZYSH_GUI_EDGE;Hash=$env:LAZYSH_GUI_EDGE_SHA256})) {
      Plain $tool.Path
      Require ((Get-FileHash -LiteralPath $tool.Path -Algorithm SHA256).Hash -eq $tool.Hash) 'GUI_TOOLS'
    }
    $script:capCleanupVerified=$false
    try { ExerciseInstalledGui -counterfactual } catch { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:gui:' + $script:failure) }
    if ($script:capCleanupVerified) { GuiMediumCounterfactual }
  } catch { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:gui:' + $script:failure) }
  finally { $script:failure=$baselineFailure }
}
function GuiMediumCounterfactual {
  if ([Environment]::TickCount64-$guiParentStarted -gt 180000) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM:NOT_RUN_BUDGET');return }
  $script:mediumAdmitted=$false
  try { Installed;ExerciseInstalledGui -counterfactual -medium }
  catch {
    if (!$script:mediumAdmitted -and $script:failure -eq 'GUI_MEDIUM_UNAVAILABLE') { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM:NOT_AVAILABLE');return }
    [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM:gui:'+$script:failure)
  }
}
function ExerciseInstalledGui([switch]$counterfactual,[switch]$medium) {
  $script:stage = 'gui'
  Require ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -ne 0) 'GUI_INTERACTIVE'
  foreach ($file in @($env:LAZYSH_GUI_DRIVER, $env:LAZYSH_GUI_EDGE, $env:LAZYSH_GUI_NODE, $env:LAZYSH_GUI_VITEST)) { Plain $file; Require (Test-Path -LiteralPath $file -PathType Leaf) 'GUI_TOOLS' }
  $signature = Get-AuthenticodeSignature -LiteralPath $env:LAZYSH_GUI_EDGE
  Require ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?:^|, )O=Microsoft Corporation(?:,|$)') 'GUI_TOOLS'
  $edgeVersion = (Get-Item -LiteralPath $env:LAZYSH_GUI_EDGE).VersionInfo.ProductVersion
  Require (($edgeVersion.Split('.')[0..2] -join '.') -eq ($runtime.Split('.')[0..2] -join '.')) 'GUI_RUNTIME'
  $script:guiRoots = @()
  $guiSentinel = 'gui-acceptance-' + [Guid]::NewGuid().ToString('N')
  $driver = $null
  $client = $null
  $primaryFailure = $null
  $mediumJob = $null
  $guiCleanupVerified = $false
  try {
    if ($medium) { $script:failure='GUI_MEDIUM_UNAVAILABLE';$mediumJob=NewGuiMediumJob }
    GuiDirectory $roaming
    GuiDirectory $local
    $ports = @()
    $listeners = @()
    try {
      foreach ($index in 1..2) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start(); $listeners += $listener
        $ports += $listener.LocalEndpoint.Port
      }
    } finally { foreach ($listener in $listeners) { $listener.Stop() } }
    $env:LAZYSH_GUI_RECEIPT = Join-Path $directory $(if ($medium) {'gui-medium-receipt.json'} elseif ($counterfactual) {'gui-counterfactual-receipt.json'} else {'gui-receipt.json'})
    Require (!(OptionalItem $env:LAZYSH_GUI_RECEIPT)) 'EXISTING_PATH'
    $env:LAZYSH_GUI_BINARY = $installed
    $env:LAZYSH_GUI_PORT = [string]$ports[0]
    $env:LAZYSH_GUI_NATIVE_PORT = [string]$ports[1]
    $env:LAZYSH_GUI_RUNTIME_VERSION = [string]$runtime
    if ($medium) { $script:failure='GUI_MEDIUM_UNAVAILABLE' }
    $driver = GuiProcess $env:LAZYSH_GUI_DRIVER @('--port', [string]$ports[0], '--native-port', [string]$ports[1], '--native-host', '127.0.0.1', '--native-driver', $env:LAZYSH_GUI_EDGE) $false $medium
    $env:LAZYSH_GUI_DRIVER_PID = [string]$driver.Id
    $env:LAZYSH_GUI_DRIVER_START = $driver.StartTime.ToUniversalTime().Ticks.ToString()
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Require (!$driver.HasExited) 'GUI_START'
      $sockets = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports })
      if (@($ports | Where-Object { $port=$_; @($sockets | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -eq '127.0.0.1' }).Count -ne 1 }).Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    $nativeDriver = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $_.ParentProcessId -eq $driver.Id -and $_.ExecutablePath -eq $env:LAZYSH_GUI_EDGE })
    Require ($nativeDriver.Count -eq 1) 'GUI_NATIVE_DRIVER'
    GuiEndpoints $sockets $ports $driver.Id $nativeDriver[0].ProcessId
    $edgeProcess = Get-Process -Id $nativeDriver[0].ProcessId
    Require ($edgeProcess.Path -eq $env:LAZYSH_GUI_EDGE) 'GUI_NATIVE_DRIVER'
    $env:LAZYSH_GUI_EDGE_PID = [string]$edgeProcess.Id
    $env:LAZYSH_GUI_EDGE_START = $edgeProcess.StartTime.ToUniversalTime().Ticks.ToString()
    $env:LAZYSH_GUI_EDGE_SHA256 = (Get-FileHash -LiteralPath $env:LAZYSH_GUI_EDGE -Algorithm SHA256).Hash
    $env:LAZYSH_GUI_DRIVER_SHA256 = (Get-FileHash -LiteralPath $env:LAZYSH_GUI_DRIVER -Algorithm SHA256).Hash
    if ($medium) { $script:failure='GUI_MEDIUM_UNAVAILABLE' }
    $client = GuiProcess $env:LAZYSH_GUI_NODE @($env:LAZYSH_GUI_VITEST, 'run', '--config', 'vitest.native-gui.config.ts', 'native-e2e/windows/installed.spec.ts') $counterfactual $medium
    if ($medium) { $script:mediumAdmitted=$true }
    Require ($client.WaitForExit(120000)) 'GUI_TIMEOUT'
    if ($client.ExitCode -ne 0) {
      Plain $env:LAZYSH_GUI_RECEIPT
      if ((Test-Path -LiteralPath $env:LAZYSH_GUI_RECEIPT -PathType Leaf) -and (Get-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT).Length -le 8192) {
        $rejected = Get-Content -Raw -LiteralPath $env:LAZYSH_GUI_RECEIPT | ConvertFrom-Json
        if ($rejected.failure -eq 'GUI_SESSION') {
          Require ($rejected.session -in @('CLIENT_TIMEOUT', 'NO_RESPONSE', 'NOT_CREATED', 'ARGUMENT', 'REMOTE_ERROR', 'SERVER_TIMEOUT', 'RESPONSE') -and $rejected.ownedWindow -in @('VERIFIED', 'UNVERIFIED')) 'GUI_CLIENT'
          $sessionCode = 'GUI_SESSION_' + $rejected.session + '_WINDOW_' + $rejected.ownedWindow
          if ($rejected.ownedWindow -eq 'UNVERIFIED') {
            Require ($rejected.probe -in @('PROBE_UNVERIFIED', 'DRIVER_IDENTITY_UNVERIFIED', 'OWNED_INVENTORY_UNVERIFIED', 'EXPECTED_IMAGE_CANDIDATE_ABSENT', 'IMAGE_IDENTITY_UNVERIFIED', 'WINDOW_UNVERIFIED', 'WINDOW_ENUMERATION_FAILED', 'NO_OWNED_HANDLES_OBSERVED', 'OWNED_HANDLES_INVISIBLE', 'VISIBLE_HANDLES_AMBIGUOUS', 'WINDOW_ROLE_UNVERIFIED', 'UNEXPECTED_VISIBLE_ROLE', 'NO_MAIN_WINDOW_OBSERVED', 'ROLE_DATA_UNVERIFIED', 'MAIN_OWNER_MISMATCH', 'MAIN_GEOMETRY_MISMATCH', 'MAIN_STYLE_MISMATCH', 'MAIN_EXSTYLE_MISMATCH', 'TAO_OWNER_MISMATCH', 'TAO_GEOMETRY_MISMATCH', 'TAO_STYLE_CLIPSIBLINGS_ONLY', 'TAO_STYLE_MISMATCH', 'TAO_EXSTYLE_MISMATCH', 'UNKNOWN_CLASS', 'MULTIPLE_ROLE_MISMATCHES')) 'GUI_CLIENT'
            $sessionCode += ':' + $rejected.probe
          }
          if ($null -ne $rejected.roleMask) {
            Require ($rejected.ownedWindow -eq 'UNVERIFIED' -and ($rejected.roleMask -is [long] -or $rejected.roleMask -is [int]) -and $rejected.roleMask -gt 0 -and $rejected.roleMask -lt ${2**windowsGuiRoleReasons.length}) 'GUI_CLIENT'
            $sessionCode += ':ROLES_' + $rejected.roleMask
          }
          Require ($rejected.proxyHealth -in @('READY','NOT_READY','NO_RESPONSE','UNVERIFIED') -and $rejected.nativeHealth -in @('READY','NOT_READY','NO_RESPONSE','UNVERIFIED')) 'GUI_CLIENT'
          $sessionCode += ':HEALTH_' + $rejected.proxyHealth + '_NATIVE_' + $rejected.nativeHealth
          if ($null -ne $rejected.metadata) { [Console]::Out.WriteLine($(if ($medium) {'LAZYSH_WINDOWS_GUI_MEDIUM_METADATA:'} elseif ($counterfactual) {'LAZYSH_WINDOWS_GUI_COUNTERFACTUAL_METADATA:'} else {'LAZYSH_WINDOWS_GUI_METADATA:'}) + ($rejected.metadata | ConvertTo-Json -Depth 4 -Compress)) }
          if ($null -ne $rejected.startup) { [Console]::Out.WriteLine($(if ($medium) {'LAZYSH_WINDOWS_GUI_MEDIUM_STARTUP:'} elseif ($counterfactual) {'LAZYSH_WINDOWS_GUI_COUNTERFACTUAL_STARTUP:'} else {'LAZYSH_WINDOWS_GUI_STARTUP:'}) + ($rejected.startup | ConvertTo-Json -Depth 4 -Compress)) }
          Require $false $sessionCode
        }
        if ($medium -and $null -ne $rejected.startup) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM_STARTUP:' + ($rejected.startup | ConvertTo-Json -Depth 4 -Compress)) }
        if ($rejected.failure -in @('GUI_FRONTEND', 'GUI_VERSION', 'GUI_OWNER', 'GUI_MEDIUM_UNAVAILABLE')) { Require $false $rejected.failure }
      }
      Require $false 'GUI_CLIENT'
    }
    Plain $env:LAZYSH_GUI_RECEIPT
    Require ((Get-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT).Length -le $(if ($medium) {8192} else {1024})) 'GUI_CLIENT'
    $receipt = Get-Content -Raw -LiteralPath $env:LAZYSH_GUI_RECEIPT | ConvertFrom-Json
    Require ($receipt.source -eq $env:GITHUB_SHA -and $receipt.version -eq $env:LAZYSH_VERSION -and $receipt.sha256 -eq $env:LAZYSH_NSIS_BINARY_SHA256 -and $receipt.pid -gt 0 -and $receipt.start -match '^[1-9][0-9]{0,19}$' -and $receipt.window -match '^[1-9][0-9]{0,19}$') 'GUI_CLIENT'
    if (!$counterfactual) { [Console]::Out.WriteLine((@{source=$receipt.source;version=$receipt.version;sha256=$receipt.sha256;pid=$receipt.pid;start=$receipt.start;window=$receipt.window;webview=$runtime;edgeDriver=$edgeVersion} | ConvertTo-Json -Compress)) }
    if ($medium) {
      Require ($receipt.startup.available -eq $true -and $receipt.startup.appIntegrity -ceq 'MEDIUM' -and $receipt.startup.appElevation -ceq 'NOT_ELEVATED') 'GUI_MEDIUM_UNAVAILABLE'
      [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM_STARTUP:' + ($receipt.startup | ConvertTo-Json -Depth 4 -Compress))
    }
    Installed
  } catch {
    if ($medium -and $_.Exception.GetBaseException().Message -ceq 'CLEANUP_UNVERIFIED') { $script:failure='GUI_CLEANUP' }
    $primaryFailure = $script:failure
  } finally {
    $script:failure = 'GUI_CLEANUP'
    $cleanupFailed = $false
    $mediumDeadline=[DateTime]::UtcNow.AddSeconds(10)
    if ($mediumJob) { try { $mediumJob.Stop($mediumDeadline.Ticks) } catch { $cleanupFailed=$true } }
    try { if ($client) { if (!$client.HasExited) { $client.Kill($true); Require ($client.WaitForExit(10000)) 'GUI_CLEANUP' }; $client.Dispose() } } catch { $cleanupFailed = $true }
    try { if ($driver) {
      # Pinned tauri-driver owns its descendants with its kill-on-close Job Object.
      $members = @([int]$driver.Id)
      try {
      $inventory = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
      for ($depth=0; $depth -lt 16; $depth++) {
        $next = @($inventory | Where-Object { [int]$_.ParentProcessId -in $members -and [int]$_.ProcessId -notin $members })
        if (!$next.Count) { break }; $members += @($next | ForEach-Object { [int]$_.ProcessId })
        Require ($members.Count -le 128) 'GUI_CLEANUP'
      }
      $identities = @($inventory | Where-Object { [int]$_.ProcessId -in $members } | Select-Object ProcessId, CreationDate)
      } finally {
        if (!$driver.HasExited) { $driver.Kill(); Require ($driver.WaitForExit(10000)) 'GUI_CLEANUP' }
        $driver.Dispose()
      }
      $deadline = $(if ($medium) {$mediumDeadline} else {[DateTime]::UtcNow.AddSeconds(10)})
      do {
        $remaining = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $candidate=$_; @($identities | Where-Object { $_.ProcessId -eq $candidate.ProcessId -and $_.CreationDate -eq $candidate.CreationDate }).Count -gt 0 })
        if (!$remaining.Count) { break }; Start-Sleep -Milliseconds 100
      } while ([DateTime]::UtcNow -lt $deadline)
      Require (!$remaining.Count) 'GUI_CLEANUP'
    }
    } catch { $cleanupFailed = $true }
    if ($env:LAZYSH_GUI_RECEIPT -and (OptionalItem $env:LAZYSH_GUI_RECEIPT)) { try { Plain $env:LAZYSH_GUI_RECEIPT; Remove-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT } catch { $cleanupFailed = $true } }
    if (!$cleanupFailed) { foreach ($path in $script:guiRoots) { try { RemoveGuiDirectory $path } catch { $cleanupFailed = $true } } }
    if ($cleanupFailed) {
      if ($primaryFailure) { [Console]::Out.WriteLine($(if ($medium) {'LAZYSH_WINDOWS_GUI_MEDIUM:gui:'} elseif ($counterfactual) {'LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:gui:'} else {'LAZYSH_WINDOWS_INSTALLER:gui:'}) + $primaryFailure) }
      Require $false 'GUI_CLEANUP'
    }
    $guiCleanupVerified = $true
    if ($counterfactual -and !$medium) { $script:capCleanupVerified=$true }
  }
  if ($primaryFailure) {
    if (!$counterfactual) {
      [Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:' + $primaryFailure)
      $script:guiBaselineEmitted=$true
      GuiCounterfactual $primaryFailure
    }
    # The original automatic-launch failure remains primary even if the treatment passes.
    Require $false $primaryFailure
  }
  if ($medium) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_MEDIUM:PASSED');return }
  if ($counterfactual) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_COUNTERFACTUAL:PASSED');return }
  $script:failure = 'UNEXPECTED'
  [Console]::Out.WriteLine('Windows installed GUI bundled version, source, image and owned window passed')
}
`;

export const windowsGuiTokenReasons=[
  'UNVERIFIED','ARCHITECTURE','OWN_TOKEN_OPEN','QUERY_SIZE_REJECTED',
  'QUERY_READ_FAILED','QUERY_LENGTH_REJECTED','SID_LAYOUT','SCALAR_LAYOUT',
  'GROUP_LAYOUT','PRIVILEGE_LOOKUP','PRIVILEGE_LAYOUT','PRIVILEGE_ABSENT',
  'PRIVILEGE_NOT_ENABLED','DUPLICATE_FAILED','RESTRICTED_CREATE_FAILED','RESTRICTED_SET_INTEGRITY_FAILED',
  'NO_ENABLED_ADMIN_GROUP','LINKED_LAYOUT','CANDIDATE_NOT_PRIMARY','CANDIDATE_ELEVATED',
  'CANDIDATE_UIACCESS','CANDIDATE_SESSION_MISMATCH','CANDIDATE_USER_MISMATCH','CANDIDATE_INTEGRITY_UNVERIFIED',
  'CANDIDATE_NOT_MEDIUM','CANDIDATE_ELEVATION_UNVERIFIED','CANDIDATE_ADMIN_NOT_DENY_ONLY','CANDIDATE_EXPECTED_GROUP_NOT_DENY_ONLY',
  'LAUNCHER_STATE','CHILD_TOKEN_UNVERIFIED','CHILD_NOT_MEDIUM','CHILD_ELEVATED',
] as const;
export const windowsGuiLaunchErrors=['ACCESS_DENIED','INVALID_HANDLE','INVALID_PARAMETER','PRIVILEGE_NOT_HELD','FILE_NOT_FOUND','PATH_NOT_FOUND','BAD_EXE_FORMAT','DIRECTORY','OTHER'] as const;
export const windowsGuiMediumSource=windowsGuiIntegritySource+String.raw`
public sealed class OwnedMediumGui : System.IDisposable {
  enum TokenReason { ${windowsGuiTokenReasons.join(',')} }
  enum LaunchCall { UNVERIFIED,CREATE_PROCESS_WITH_TOKEN,CREATE_PROCESS_AS_USER,RESUME_THREAD }
  enum LaunchError { UNVERIFIED,RESUME_COUNT_UNEXPECTED,${windowsGuiLaunchErrors.join(',')} }
  static LaunchCall launchCall;
  static LaunchError launchError;
  public static string LaunchFailure {get{return launchCall+":"+launchError;}}
  static LaunchError Win32Failure(int error){switch(error){case 5:return LaunchError.ACCESS_DENIED;case 6:return LaunchError.INVALID_HANDLE;case 87:return LaunchError.INVALID_PARAMETER;case 1314:return LaunchError.PRIVILEGE_NOT_HELD;case 2:return LaunchError.FILE_NOT_FOUND;case 3:return LaunchError.PATH_NOT_FOUND;case 193:return LaunchError.BAD_EXE_FORMAT;case 267:return LaunchError.DIRECTORY;default:return LaunchError.OTHER;}}
  static LaunchError ResumeFailure(uint count,int error){return count==uint.MaxValue?Win32Failure(error):count==1?LaunchError.UNVERIFIED:LaunchError.RESUME_COUNT_UNEXPECTED;}
  bool probeStarted;
  public string CounterprobeOutcome {get;private set;}
  public string DaclObservations {get;private set;}
  public string AsUserOutcome {get;private set;}
  static string CounterprobeAdmission(string code,long remaining){
    if(code!="LAUNCH_UNAVAILABLE"||launchCall!=LaunchCall.CREATE_PROCESS_WITH_TOKEN||launchError!=LaunchError.ACCESS_DENIED||remaining>100000)return "NOT_ELIGIBLE";
    return remaining<30000?"NOT_RUN_BUDGET":"RUN";
  }
  static TokenReason tokenFailure;
  public static string TokenFailure {get{return tokenFailure.ToString();}}
  static bool TokenReject(TokenReason reason){tokenFailure=reason;return false;}
  static void TokenNeed(bool condition,TokenReason reason){if(!condition){TokenReject(reason);throw new System.InvalidOperationException("TOKEN_UNAVAILABLE");}}
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Length;public IntPtr Descriptor;public bool Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int Size;public string Reserved,Desktop,Title;public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags;public short Show,ReservedSize;public IntPtr ReservedData,Input,Output,Error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr Process,Thread;public int Id,ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime,JobTime;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit Basic;public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low;public int High; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint length,out uint needed);
  [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] static extern bool GetTokenUInt(IntPtr token,int kind,out uint value,uint length,out uint used);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string host,string name,out Luid id);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr source,uint access,IntPtr attributes,int level,int type,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr source,uint flags,uint count,IntPtr disabled,uint deletes,IntPtr privileges,uint restricts,IntPtr sids,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr data,uint length);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string image,System.Text.StringBuilder command,uint flags,IntPtr environment,string directory,ref SI startup,out PI process);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token,string image,System.Text.StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref SI startup,out PI process);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,System.Text.StringBuilder image,ref uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string file,uint access,uint share,ref SA attributes,uint disposition,uint flags,IntPtr template);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,System.Text.StringBuilder name,uint length,out uint needed);
  [StructLayout(LayoutKind.Sequential)] struct Mapping {public uint Read,Write,Execute,All;public Mapping(uint read,uint write,uint execute,uint all){Read=read;Write=write;Execute=execute;All=all;}}
  [StructLayout(LayoutKind.Sequential)] struct FileIdentity {public uint Attributes;public uint CreatedLow,CreatedHigh,AccessedLow,AccessedHigh,WrittenLow,WrittenHigh;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FileIdentity identity);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr handle,System.Text.StringBuilder path,uint length,uint flags);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,int kind,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool IsValidSecurityDescriptor(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr descriptor,IntPtr client,uint desired,ref Mapping mapping,IntPtr privileges,ref uint length,out uint granted,out bool allowed);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  // Fixed SDK masks only; these observations model DACL access, not MIC or process-creation authority.
  static Mapping DaclMapping(int kind){switch(kind){case 1:return new Mapping(0x120089,0x120116,0x1200a0,0x1f01ff);case 2:return new Mapping(0x20303,0x2001c,0x20060,0xf037f);case 3:return new Mapping(0x20041,0x200be,0x20100,0xf01ff);default:throw new System.InvalidOperationException("DACL_UNVERIFIED");}}
  static uint DaclMask(int observation){switch(observation){case 0:return 0x1200a9;case 1:return 0x20;case 2:return 2;case 3:return 2;case 4:return 0x83;default:throw new System.InvalidOperationException("DACL_UNVERIFIED");}}
  static string DaclResult(bool queried,bool allowed){return !queried?"UNVERIFIED":allowed?"ALLOWS":"DENIES";}
  static bool DaclEligible(string counter,long remaining){return counter=="DENIED:ACCESS_DENIED"&&remaining>=30000&&remaining<=100000;}
  static void PlainDaclPath(string path){for(var current=new System.IO.DirectoryInfo(System.IO.Path.GetDirectoryName(path));current!=null;current=current.Parent)Need((current.Attributes&System.IO.FileAttributes.ReparsePoint)==0,"DACL_UNVERIFIED");Need((System.IO.File.GetAttributes(path)&System.IO.FileAttributes.ReparsePoint)==0,"DACL_UNVERIFIED");}
  static IntPtr DaclFile(string path,bool directory){
    PlainDaclPath(path);var attributes=new SA{Length=Marshal.SizeOf(typeof(SA))};IntPtr handle=CreateFile(path,0x20000,7,ref attributes,3,0x02200000,IntPtr.Zero);
    if(handle==IntPtr.Zero||handle==new IntPtr(-1))throw new System.InvalidOperationException("DACL_UNVERIFIED");
    try{FileIdentity identity;var final=new System.Text.StringBuilder(32768);uint length=GetFinalPathNameByHandle(handle,final,32768,0);Need(GetFileInformationByHandle(handle,out identity)&&(identity.Attributes&0x400)==0&&((identity.Attributes&0x10)!=0)==directory&&(directory||identity.SizeHigh!=0||identity.SizeLow!=0)&&length>0&&length<32768&&String.Equals(final.ToString(),"\\\\?\\"+System.IO.Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase),"DACL_UNVERIFIED");PlainDaclPath(path);return handle;}
    catch{Need(CloseHandle(handle),"CLEANUP_UNVERIFIED");throw;}
  }
  static bool DaclFileMatches(IntPtr original,string path,bool directory){IntPtr current=IntPtr.Zero;try{current=DaclFile(path,directory);FileIdentity a,b;return GetFileInformationByHandle(original,out a)&&GetFileInformationByHandle(current,out b)&&(a.IndexHigh!=0||a.IndexLow!=0)&&a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow&&a.SizeHigh==b.SizeHigh&&a.SizeLow==b.SizeLow&&a.WrittenHigh==b.WrittenHigh&&a.WrittenLow==b.WrittenLow;}finally{if(current!=IntPtr.Zero)Need(CloseHandle(current),"CLEANUP_UNVERIFIED");}}
  static string CheckDacl(IntPtr handle,IntPtr client,int kind,int observation){
    IntPtr descriptor=IntPtr.Zero,privileges=IntPtr.Zero,owner,group,dacl,sacl;
    try{if(handle==IntPtr.Zero||GetSecurityInfo(handle,kind==1?1:7,7,out owner,out group,out dacl,out sacl,out descriptor)!=0||descriptor==IntPtr.Zero||owner==IntPtr.Zero||group==IntPtr.Zero||!IsValidSecurityDescriptor(descriptor))return "UNVERIFIED";
      uint size=GetSecurityDescriptorLength(descriptor);if(size==0||size>65536)return "UNVERIFIED";
      var mapping=DaclMapping(kind);uint length=4096,granted;bool allowed;privileges=Marshal.AllocHGlobal(4096);
      bool queried=AccessCheck(descriptor,client,DaclMask(observation),ref mapping,privileges,ref length,out granted,out allowed);return DaclResult(queried&&length<=4096,allowed);
    }finally{if(privileges!=IntPtr.Zero)Marshal.FreeHGlobal(privileges);if(descriptor!=IntPtr.Zero)Need(LocalFree(descriptor)==IntPtr.Zero,"CLEANUP_UNVERIFIED");}
  }
  string ObserveDacls(string image,string directory){
    var values=new[]{"UNVERIFIED","UNVERIFIED","UNVERIFIED","UNVERIFIED","UNVERIFIED"};IntPtr client=IntPtr.Zero,file=IntPtr.Zero,cwd=IntPtr.Zero;
    try{if(!DuplicateTokenEx(token,8,IntPtr.Zero,2,2,out client))return String.Join(":",values);
      try{Need(String.Equals(System.IO.Path.GetFullPath(image),System.IO.Path.GetFullPath(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName),StringComparison.OrdinalIgnoreCase),"DACL_UNVERIFIED");file=DaclFile(image,false);values[0]=CheckDacl(file,client,1,0);if(!DaclFileMatches(file,image,false))values[0]="UNVERIFIED";}catch(System.InvalidOperationException e){values[0]="UNVERIFIED";if(e.Message=="CLEANUP_UNVERIFIED")throw;}catch{values[0]="UNVERIFIED";}
      try{cwd=DaclFile(directory,true);values[1]=CheckDacl(cwd,client,1,1);values[2]=CheckDacl(cwd,client,1,2);if(!DaclFileMatches(cwd,directory,true)){values[1]="UNVERIFIED";values[2]="UNVERIFIED";}}catch(System.InvalidOperationException e){values[1]="UNVERIFIED";values[2]="UNVERIFIED";if(e.Message=="CLEANUP_UNVERIFIED")throw;}catch{values[1]="UNVERIFIED";values[2]="UNVERIFIED";}
      // Borrowed current user-object handles are never closed or replaced.
      IntPtr station=GetProcessWindowStation(),desktop=GetThreadDesktop(GetCurrentThreadId());
      if(ObjectName(station)=="WinSta0")values[3]=CheckDacl(station,client,2,3);
      if(ObjectName(desktop)=="Default")values[4]=CheckDacl(desktop,client,3,4);
      return String.Join(":",values);
    }catch(System.InvalidOperationException e){if(e.Message=="CLEANUP_UNVERIFIED")throw;return String.Join(":",values);}catch{return String.Join(":",values);}
    finally{bool closed=true;if(file!=IntPtr.Zero)closed&=CloseHandle(file);if(cwd!=IntPtr.Zero)closed&=CloseHandle(cwd);if(client!=IntPtr.Zero)closed&=CloseHandle(client);Need(closed,"CLEANUP_UNVERIFIED");}
  }
  sealed class Data : System.IDisposable { public IntPtr Pointer;public uint Length;public Data(IntPtr token,int kind) { uint length;bool queried=GetTokenInformation(token,kind,IntPtr.Zero,0,out length);TokenNeed(!queried&&Marshal.GetLastWin32Error()==122,TokenReason.QUERY_SIZE_REJECTED);TokenNeed(length>0&&length<=65536,TokenReason.QUERY_LENGTH_REJECTED);Pointer=Marshal.AllocHGlobal((int)length);Length=length;try {uint used;TokenNeed(GetTokenInformation(token,kind,Pointer,length,out used),TokenReason.QUERY_READ_FAILED);TokenNeed(used<=length,TokenReason.QUERY_LENGTH_REJECTED);Length=used;}catch {Dispose();throw;} } public void Dispose(){if(Pointer!=IntPtr.Zero){Marshal.FreeHGlobal(Pointer);Pointer=IntPtr.Zero;}} }
  sealed class Group { public byte[] Sid;public uint Attributes; }
  IntPtr job,token;
  readonly System.Collections.Generic.List<IntPtr> processes=new System.Collections.Generic.List<IntPtr>();
  public string Kind {get;private set;}
  static void Need(bool condition,string code){if(!condition)throw new System.InvalidOperationException(code);}
  static byte[] SidAt(Data data,int pointerOffset) {
    TokenNeed(pointerOffset>=0&&pointerOffset+IntPtr.Size<=data.Length,TokenReason.SID_LAYOUT);long offset=checked(Marshal.ReadIntPtr(data.Pointer,pointerOffset).ToInt64()-data.Pointer.ToInt64());
    TokenNeed(offset>=0&&offset+8<=data.Length,TokenReason.SID_LAYOUT);int count=Marshal.ReadByte(data.Pointer,(int)offset+1);int length=8+count*4;
    TokenNeed(count<=15&&offset+length<=data.Length,TokenReason.SID_LAYOUT);var sid=new byte[length];Marshal.Copy(IntPtr.Add(data.Pointer,(int)offset),sid,0,length);TokenNeed(sid[0]==1,TokenReason.SID_LAYOUT);return sid;
  }
  static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true;}
  // These SDK classes have exactly one DWORD/32-bit enum; a zero-size probe is unnecessary.
  // dotnet/runtime WindowsIdentity.cs also documents BAD_LENGTH for TokenSessionId probes.
  static uint Word(IntPtr token,int kind){TokenNeed(kind==8||kind==12||kind==18||kind==20||kind==26,TokenReason.SCALAR_LAYOUT);uint value,used;TokenNeed(GetTokenUInt(token,kind,out value,4,out used),TokenReason.QUERY_READ_FAILED);TokenNeed(used==4,TokenReason.SCALAR_LAYOUT);return value;}
  static byte[] User(IntPtr token){using(var data=new Data(token,1))return SidAt(data,0);}
  static Group[] Groups(IntPtr token){using(var data=new Data(token,2)){TokenNeed(data.Length>=4,TokenReason.GROUP_LAYOUT);int count=Marshal.ReadInt32(data.Pointer);int offset=IntPtr.Size,entry=IntPtr.Size*2;TokenNeed(count>=0&&count<=256&&offset+(long)count*entry<=data.Length,TokenReason.GROUP_LAYOUT);var result=new Group[count];for(int i=0;i<count;i++)result[i]=new Group{Sid=SidAt(data,offset+i*entry),Attributes=unchecked((uint)Marshal.ReadInt32(data.Pointer,offset+i*entry+IntPtr.Size))};return result;}}
  static bool Admin(Group group){var s=group.Sid;if((group.Attributes&8)!=0)return true;if(s.Length<16||s[7]!=5)return false;for(int i=2;i<7;i++)if(s[i]!=0)return false;uint first=BitConverter.ToUInt32(s,8),last=BitConverter.ToUInt32(s,s.Length-4);return first==32&&(last==544||(last>=547&&last<=552))||first==21&&(last==512||last==518||last==519||last==520);}
  static bool Candidate(IntPtr candidate,IntPtr caller,Group[] denied){
    if(Word(candidate,8)!=1)return TokenReject(TokenReason.CANDIDATE_NOT_PRIMARY);
    if(Word(candidate,20)!=0)return TokenReject(TokenReason.CANDIDATE_ELEVATED);
    if(Word(candidate,26)!=0)return TokenReject(TokenReason.CANDIDATE_UIACCESS);
    if(Word(candidate,12)!=Word(caller,12))return TokenReject(TokenReason.CANDIDATE_SESSION_MISMATCH);
    if(!Equal(User(candidate),User(caller)))return TokenReject(TokenReason.CANDIDATE_USER_MISMATCH);
    var fact=OwnedGuiIntegrity.ReadToken(candidate);
    if(fact[0]=="UNVERIFIED")return TokenReject(TokenReason.CANDIDATE_INTEGRITY_UNVERIFIED);
    if(fact[0]!="MEDIUM")return TokenReject(TokenReason.CANDIDATE_NOT_MEDIUM);
    if(fact[1]=="UNVERIFIED")return TokenReject(TokenReason.CANDIDATE_ELEVATION_UNVERIFIED);
    if(fact[1]!="NOT_ELEVATED")return TokenReject(TokenReason.CANDIDATE_ELEVATED);
    var groups=Groups(candidate);foreach(var group in groups)if(Admin(group)&&((group.Attributes&0x10)==0||(group.Attributes&4)!=0))return TokenReject(TokenReason.CANDIDATE_ADMIN_NOT_DENY_ONLY);
    foreach(var expected in denied){bool found=false;foreach(var actual in groups)if(Equal(expected.Sid,actual.Sid)){found=(actual.Attributes&0x10)!=0&&(actual.Attributes&4)==0;break;}if(!found)return TokenReject(TokenReason.CANDIDATE_EXPECTED_GROUP_NOT_DENY_ONLY);}return true;
  }
  static bool CanImpersonate(IntPtr caller){Luid wanted;if(!LookupPrivilegeValue(null,"SeImpersonatePrivilege",out wanted))return TokenReject(TokenReason.PRIVILEGE_LOOKUP);using(var data=new Data(caller,3)){TokenNeed(data.Length>=4,TokenReason.PRIVILEGE_LAYOUT);int count=Marshal.ReadInt32(data.Pointer);TokenNeed(count>=0&&count<=256&&4L+12L*count<=data.Length,TokenReason.PRIVILEGE_LAYOUT);for(int i=0;i<count;i++){int at=4+i*12;if(unchecked((uint)Marshal.ReadInt32(data.Pointer,at))==wanted.Low&&Marshal.ReadInt32(data.Pointer,at+4)==wanted.High)return (Marshal.ReadInt32(data.Pointer,at+8)&6)==2||TokenReject(TokenReason.PRIVILEGE_NOT_ENABLED);}return TokenReject(TokenReason.PRIVILEGE_ABSENT);}}
  // Canonical bounded caller privilege state stays in memory; no token changes or privilege-list output.
  static byte[] CanonicalPrivileges(ulong[] ids,uint[] attributes){
    Need(ids.Length==attributes.Length&&ids.Length<=256,"ASUSER_UNVERIFIED");var entries=new System.Collections.Generic.SortedDictionary<ulong,uint>();
    for(int i=0;i<ids.Length;i++){Need(!entries.ContainsKey(ids[i]),"ASUSER_UNVERIFIED");entries.Add(ids[i],attributes[i]);}
    var result=new byte[ids.Length*12];int offset=0;foreach(var entry in entries){Array.Copy(BitConverter.GetBytes(entry.Key),0,result,offset,8);Array.Copy(BitConverter.GetBytes(entry.Value),0,result,offset+8,4);offset+=12;}return result;
  }
  static bool QuotaPresent(bool matching,uint attributes){return matching&&(attributes&4)==0;}
  static byte[] CallerPrivileges(IntPtr caller,Luid quota,out bool present){
    present=false;using(var data=new Data(caller,3)){Need(data.Length>=4,"ASUSER_UNVERIFIED");int count=Marshal.ReadInt32(data.Pointer);Need(count>=0&&count<=256&&4L+12L*count==data.Length,"ASUSER_UNVERIFIED");var ids=new ulong[count];var attributes=new uint[count];
      for(int i=0;i<count;i++){int at=4+12*i;uint low=unchecked((uint)Marshal.ReadInt32(data.Pointer,at)),high=unchecked((uint)Marshal.ReadInt32(data.Pointer,at+4));ids[i]=((ulong)high<<32)|low;attributes[i]=unchecked((uint)Marshal.ReadInt32(data.Pointer,at+8));if(QuotaPresent(low==quota.Low&&high==unchecked((uint)quota.High),attributes[i]))present=true;}return CanonicalPrivileges(ids,attributes);}
  }
  static string AsUserAdmission(string kind,string counter,long remaining){if(kind!="RESTRICTED"||counter!="DENIED:ACCESS_DENIED"||remaining>100000)return "NOT_ELIGIBLE";return remaining<30000?"NOT_RUN_BUDGET":"RUN";}
  static string AsUserUnavailable(string code){switch(code){case "JOB_UNAVAILABLE":return "UNAVAILABLE_JOB";case "IDENTITY_UNVERIFIED":return "UNAVAILABLE_IDENTITY";case "TOKEN_UNAVAILABLE":return "UNAVAILABLE_TOKEN";case "ARGV_BOUND":case "ENVIRONMENT_BOUND":return "UNAVAILABLE_INPUT";default:return "UNVERIFIED";}}
  void CompareAsUser(string image,string[] arguments,string directory,string environment,long deadline){
    AsUserOutcome=AsUserAdmission(Kind,CounterprobeOutcome,deadline-Environment.TickCount64);if(AsUserOutcome!="RUN")return;
    var originalCall=launchCall;var originalError=launchError;var originalToken=tokenFailure;
    try{using(var retired=Launch(image,arguments,directory,environment,true,true)){AsUserOutcome="CREATED_RETIRED";}}
    catch(System.InvalidOperationException failure){if(failure.Message=="CLEANUP_UNVERIFIED"){AsUserOutcome="CLEANUP_UNVERIFIED";throw;}AsUserOutcome=failure.Message=="ASUSER_QUOTA_ABSENT"?"NOT_RUN_QUOTA":failure.Message=="LAUNCH_UNAVAILABLE"&&launchCall==LaunchCall.CREATE_PROCESS_AS_USER?"DENIED:"+launchError:AsUserUnavailable(failure.Message);}
    catch{AsUserOutcome="CLEANUP_UNVERIFIED";throw new System.InvalidOperationException("CLEANUP_UNVERIFIED");}
    finally{launchCall=originalCall;launchError=originalError;tokenFailure=originalToken;}
  }
  static IntPtr Copy(IntPtr source){IntPtr result;TokenNeed(DuplicateTokenEx(source,0x8b,IntPtr.Zero,2,1,out result),TokenReason.DUPLICATE_FAILED);return result;}
  static IntPtr Restricted(IntPtr caller,Group[] denied){
    IntPtr copy=IntPtr.Zero,result=IntPtr.Zero,array=IntPtr.Zero;var allocated=new System.Collections.Generic.List<IntPtr>();
    try {copy=Copy(caller);int entry=IntPtr.Size*2;array=Marshal.AllocHGlobal(entry*denied.Length);for(int i=0;i<denied.Length;i++){IntPtr sid=Marshal.AllocHGlobal(denied[i].Sid.Length);allocated.Add(sid);Marshal.Copy(denied[i].Sid,0,sid,denied[i].Sid.Length);Marshal.WriteIntPtr(array,i*entry,sid);Marshal.WriteInt32(array,i*entry+IntPtr.Size,0);}
      TokenNeed(CreateRestrictedToken(copy,5,(uint)denied.Length,array,0,IntPtr.Zero,0,IntPtr.Zero,out result),TokenReason.RESTRICTED_CREATE_FAILED);
      byte[] medium={1,1,0,0,0,0,0,16,0,32,0,0};int header=IntPtr.Size*2;IntPtr label=Marshal.AllocHGlobal(header+12);
      try {Marshal.Copy(new byte[header+12],0,label,header+12);Marshal.Copy(medium,0,IntPtr.Add(label,header),12);Marshal.WriteIntPtr(label,IntPtr.Add(label,header));Marshal.WriteInt32(label,IntPtr.Size,32);TokenNeed(SetTokenInformation(result,25,label,(uint)(header+12)),TokenReason.RESTRICTED_SET_INTEGRITY_FAILED);}finally{Marshal.FreeHGlobal(label);}
      IntPtr owned=result;result=IntPtr.Zero;return owned;
    }finally{if(result!=IntPtr.Zero)CloseHandle(result);if(copy!=IntPtr.Zero)CloseHandle(copy);if(array!=IntPtr.Zero)Marshal.FreeHGlobal(array);foreach(var sid in allocated)Marshal.FreeHGlobal(sid);}
  }
  static string ObjectName(IntPtr handle){var text=new System.Text.StringBuilder(128);uint needed;Need(handle!=IntPtr.Zero&&GetUserObjectInformation(handle,2,text,256,out needed)&&needed<=256,"DESKTOP_UNAVAILABLE");return text.ToString();}
  public OwnedMediumGui(){tokenFailure=TokenReason.UNVERIFIED;IntPtr caller=IntPtr.Zero,linked=IntPtr.Zero;try{
    TokenNeed(Environment.Is64BitProcess,TokenReason.ARCHITECTURE);TokenNeed(OpenProcessToken(GetCurrentProcess(),0xa,out caller),TokenReason.OWN_TOKEN_OPEN);Need(CanImpersonate(caller),"TOKEN_UNAVAILABLE");
    Need(ObjectName(GetProcessWindowStation())=="WinSta0"&&ObjectName(GetThreadDesktop(GetCurrentThreadId()))=="Default","DESKTOP_UNAVAILABLE");
    var disabled=new System.Collections.Generic.List<Group>();foreach(var group in Groups(caller))if(Admin(group)&&(group.Attributes&4)!=0)disabled.Add(group);TokenNeed(disabled.Count>0,TokenReason.NO_ENABLED_ADMIN_GROUP);
    if(Word(caller,18)==2){try{using(var data=new Data(caller,19)){TokenNeed(data.Length==IntPtr.Size,TokenReason.LINKED_LAYOUT);linked=Marshal.ReadIntPtr(data.Pointer);}IntPtr copy=Copy(linked);try{if(Candidate(copy,caller,disabled.ToArray())){token=copy;copy=IntPtr.Zero;Kind="LINKED";}}finally{if(copy!=IntPtr.Zero)CloseHandle(copy);}}catch{}finally{if(linked!=IntPtr.Zero){CloseHandle(linked);linked=IntPtr.Zero;}}}
    if(token==IntPtr.Zero){tokenFailure=TokenReason.UNVERIFIED;token=Restricted(caller,disabled.ToArray());Need(Candidate(token,caller,disabled.ToArray()),"TOKEN_UNAVAILABLE");Kind="RESTRICTED";}
    job=CreateJobObject(IntPtr.Zero,null);Need(job!=IntPtr.Zero,"JOB_UNAVAILABLE");var limits=new Limits();limits.Basic.Flags=0x2000;Need(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"JOB_UNAVAILABLE");
  }catch{Dispose();throw;}finally{if(caller!=IntPtr.Zero)CloseHandle(caller);}}
  public static string Command(string image,string[] arguments){var output=new System.Text.StringBuilder();foreach(string value in new[]{image})output.Append(Quote(value));foreach(string value in arguments)output.Append(' ').Append(Quote(value));Need(output.Length+1<=1024,"ARGV_BOUND");return output.ToString();}
  static string Quote(string value){Need(value!=null&&value.IndexOf('\0')<0,"ARGV_BOUND");var output=new System.Text.StringBuilder("\"");int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='\"'){output.Append('\\',slashes*2+1).Append(c);slashes=0;continue;}output.Append('\\',slashes).Append(c);slashes=0;}output.Append('\\',slashes*2).Append('"');return output.ToString();}
  public System.Diagnostics.Process StartProbe(string image,string[] arguments,string directory,string environment,long deadline){
    Need(!probeStarted,"PROBE_REPEATED");probeStarted=true;CounterprobeOutcome="NOT_ELIGIBLE";
    try{return Start(image,arguments,directory,environment);}
    catch(System.InvalidOperationException original){
      // Start's finally has already verified any partial child/handle cleanup.
      string admission=CounterprobeAdmission(original.Message,deadline-Environment.TickCount64);
      if(admission!="RUN"){CounterprobeOutcome=admission;throw;}
      var originalCall=launchCall;var originalError=launchError;var originalToken=tokenFailure;
      try{
        using(var retired=Launch(image,arguments,directory,environment,true)){CounterprobeOutcome="CREATED_RETIRED";}
      }catch(System.InvalidOperationException counter){
        switch(counter.Message){
          case "CLEANUP_UNVERIFIED":CounterprobeOutcome="CLEANUP_UNVERIFIED";throw;
          case "LAUNCH_UNAVAILABLE":CounterprobeOutcome=launchCall==LaunchCall.CREATE_PROCESS_WITH_TOKEN?"DENIED:"+launchError:"UNAVAILABLE_OTHER";break;
          case "JOB_UNAVAILABLE":CounterprobeOutcome="UNAVAILABLE_JOB";break;
          case "IDENTITY_UNVERIFIED":CounterprobeOutcome="UNAVAILABLE_IDENTITY";break;
          case "TOKEN_UNAVAILABLE":CounterprobeOutcome="UNAVAILABLE_TOKEN";break;
          case "ARGV_BOUND":case "ENVIRONMENT_BOUND":CounterprobeOutcome="UNAVAILABLE_INPUT";break;
          default:CounterprobeOutcome="CLEANUP_UNVERIFIED";throw new System.InvalidOperationException("CLEANUP_UNVERIFIED");
        }
      }catch{CounterprobeOutcome="CLEANUP_UNVERIFIED";throw new System.InvalidOperationException("CLEANUP_UNVERIFIED");}
      finally{launchCall=originalCall;launchError=originalError;tokenFailure=originalToken;}
      if(DaclEligible(CounterprobeOutcome,deadline-Environment.TickCount64))DaclObservations=ObserveDacls(image,directory);
      CompareAsUser(image,arguments,directory,environment,deadline);
      // These experiments cannot replace the original denied probe with a passing fallback.
      throw;
    }
  }
  public System.Diagnostics.Process Start(string image,string[] arguments,string directory,string environment){return Launch(image,arguments,directory,environment,false);}
  System.Diagnostics.Process Launch(string image,string[] arguments,string directory,string environment,bool creationOnly,bool asUser=false){
    Need(!asUser||creationOnly,"ASUSER_UNVERIFIED");
    launchCall=LaunchCall.UNVERIFIED;launchError=LaunchError.UNVERIFIED;tokenFailure=TokenReason.UNVERIFIED;TokenNeed(job!=IntPtr.Zero&&token!=IntPtr.Zero,TokenReason.LAUNCHER_STATE);string command=Command(image,arguments);Need(environment!=null&&environment.Length<=65536&&environment.EndsWith("\0\0",StringComparison.Ordinal),"ENVIRONMENT_BOUND");
    IntPtr block=IntPtr.Zero,nul=IntPtr.Zero,caller=IntPtr.Zero,childToken=IntPtr.Zero;PI child=new PI();bool admitted=false;System.Diagnostics.Process managed=null;
    try {byte[] before=null;var quota=new Luid();Group[] denied=null;
      if(asUser){Need(OpenProcessToken(GetCurrentProcess(),0xe,out caller)&&LookupPrivilegeValue(null,"SeIncreaseQuotaPrivilege",out quota),"ASUSER_UNVERIFIED");bool present;before=CallerPrivileges(caller,quota,out present);Need(present,"ASUSER_QUOTA_ABSENT");var groups=new System.Collections.Generic.List<Group>();foreach(var group in Groups(caller))if(Admin(group)&&(group.Attributes&4)!=0)groups.Add(group);denied=groups.ToArray();Need(denied.Length>0&&Candidate(token,caller,denied),"ASUSER_UNVERIFIED");}
      block=Marshal.StringToHGlobalUni(environment);
      if(!creationOnly){var attributes=new SA{Length=Marshal.SizeOf(typeof(SA)),Inherit=true};nul=CreateFile("NUL",0xc0000000,3,ref attributes,3,0,IntPtr.Zero);Need(nul!=IntPtr.Zero&&nul!=new IntPtr(-1),"STDIO_UNAVAILABLE");}
      var startup=new SI{Size=Marshal.SizeOf(typeof(SI)),Desktop="winsta0\\default",Flags=creationOnly?0:0x100,Input=nul,Output=nul,Error=nul};
      bool createdChild;
      if(asUser){try{createdChild=CreateProcessAsUserW(token,image,new System.Text.StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000404,block,directory,ref startup,out child);if(!createdChild){int error=Marshal.GetLastWin32Error();launchCall=LaunchCall.CREATE_PROCESS_AS_USER;launchError=Win32Failure(error);}}
        finally{bool restored=false;try{bool present;restored=Equal(before,CallerPrivileges(caller,quota,out present));}catch{}Need(restored,"CLEANUP_UNVERIFIED");}}
      else{createdChild=CreateProcessWithTokenW(token,0,image,new System.Text.StringBuilder(command),0x08000404,block,directory,ref startup,out child);if(!createdChild){int error=Marshal.GetLastWin32Error();launchCall=LaunchCall.CREATE_PROCESS_WITH_TOKEN;launchError=Win32Failure(error);}}
      Need(createdChild,"LAUNCH_UNAVAILABLE");
      Need(AssignProcessToJobObject(job,child.Process),"JOB_UNAVAILABLE");long created,exited,kernel,user;Need(GetProcessTimes(child.Process,out created,out exited,out kernel,out user),"IDENTITY_UNVERIFIED");long start=DateTime.FromFileTimeUtc(created).Ticks;var path=new System.Text.StringBuilder(32768);uint length=32768;Need(QueryFullProcessImageName(child.Process,0,path,ref length)&&String.Equals(System.IO.Path.GetFullPath(image),System.IO.Path.GetFullPath(path.ToString()),StringComparison.OrdinalIgnoreCase),"IDENTITY_UNVERIFIED");
      var fact=OwnedGuiIntegrity.Query(child.Id,start.ToString(CultureInfo.InvariantCulture));TokenNeed(fact[0]!="UNVERIFIED"&&fact[0]!="IDENTITY_UNVERIFIED"&&fact[1]!="UNVERIFIED",TokenReason.CHILD_TOKEN_UNVERIFIED);TokenNeed(fact[0]=="MEDIUM",TokenReason.CHILD_NOT_MEDIUM);TokenNeed(fact[1]=="NOT_ELEVATED",TokenReason.CHILD_ELEVATED);
      if(asUser)Need(OpenProcessToken(child.Process,8,out childToken)&&Candidate(childToken,caller,denied),"ASUSER_UNVERIFIED");
      managed=System.Diagnostics.Process.GetProcessById(child.Id);IntPtr retained=managed.SafeHandle.DangerousGetHandle();Need(managed.StartTime.ToUniversalTime().Ticks==start,"IDENTITY_UNVERIFIED");if(creationOnly){Need(TerminateProcess(child.Process,1),"CLEANUP_UNVERIFIED");Need(WaitForSingleObject(child.Process,10000)==0,"CLEANUP_UNVERIFIED");}
      else{uint count=ResumeThread(child.Thread);if(count!=1){int error=count==uint.MaxValue?Marshal.GetLastWin32Error():0;launchCall=LaunchCall.RESUME_THREAD;launchError=ResumeFailure(count,error);}Need(count==1,"LAUNCH_UNAVAILABLE");}
      processes.Add(child.Process);child.Process=IntPtr.Zero;admitted=true;return managed;
    }finally{bool closed=true;if(!admitted&&child.Process!=IntPtr.Zero){closed &= TerminateProcess(child.Process,1);closed &= WaitForSingleObject(child.Process,10000)==0;closed &= CloseHandle(child.Process);if(managed!=null)managed.Dispose();}if(child.Thread!=IntPtr.Zero)closed &= CloseHandle(child.Thread);if(childToken!=IntPtr.Zero)closed &= CloseHandle(childToken);if(caller!=IntPtr.Zero)closed &= CloseHandle(caller);if(nul!=IntPtr.Zero&&nul!=new IntPtr(-1))closed &= CloseHandle(nul);if(block!=IntPtr.Zero)Marshal.FreeHGlobal(block);Need(closed,"CLEANUP_UNVERIFIED");}
  }
  public void Stop(long deadline){if(job==IntPtr.Zero)return;try{Need(TerminateJobObject(job,1),"CLEANUP_UNVERIFIED");IntPtr data=Marshal.AllocHGlobal(48);try{uint length;while(true){Need(QueryInformationJobObject(job,1,data,48,out length)&&length>=44,"CLEANUP_UNVERIFIED");if(Marshal.ReadInt32(data,40)==0)break;Need(DateTime.UtcNow.Ticks<deadline,"CLEANUP_UNVERIFIED");System.Threading.Thread.Sleep(10);}}finally{Marshal.FreeHGlobal(data);}}finally{Dispose();}}
  public void Dispose(){bool closed=true;if(job!=IntPtr.Zero){closed &= CloseHandle(job);job=IntPtr.Zero;}foreach(var process in processes)closed &= CloseHandle(process);processes.Clear();if(token!=IntPtr.Zero){closed &= CloseHandle(token);token=IntPtr.Zero;}Need(closed,"CLEANUP_UNVERIFIED");}
}
`;
