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
function GuiMetadataImageFence($appId, $start) {
  try {
    $current=Get-Process -Id $appId -ErrorAction Stop
    return ($current.StartTime.ToUniversalTime().Ticks.ToString() -ceq $start -and $current.Path -eq $env:LAZYSH_GUI_BINARY -and (Get-FileHash -LiteralPath $current.Path -Algorithm SHA256 -ErrorAction Stop).Hash -eq $env:LAZYSH_NSIS_BINARY_SHA256)
  } catch { return $false }
}
function GuiMetadataSnapshot {
  if (!$script:metadataEligible -or !$script:metadataComplete -or !(GuiMetadataImageFence $script:metadataAppId $script:metadataStart)) { return @{available=$false} }
  return @{available=$true;overflow=$script:metadataOverflow;windows=@($script:metadataWindows)}
}
`;

// Windows-only installed GUI acceptance. Paths are supplied exclusively through the child environment.
export const windowsGuiOwnerScript = String.raw`
${windowsGuiWindowRoleScript}
${windowsGuiMetadataScript}
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
  @{pid=$app.Id;start=$app.StartTime.ToUniversalTime().Ticks.ToString();window=$mainHandle;sha256=$env:LAZYSH_NSIS_BINARY_SHA256} | ConvertTo-Json -Compress
} catch {
  $label = 'LAZYSH_WINDOWS_GUI_PROBE:' + $phase
  if ($script:roleMask -gt 0) { $label += ':ROLES_' + $script:roleMask }
  [Console]::Out.WriteLine($label)
  [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_METADATA:' + ((GuiMetadataSnapshot) | ConvertTo-Json -Depth 4 -Compress))
  exit 1
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

export const windowsInstalledGuiScript = String.raw`
${windowsGuiEndpointsScript}
function GuiProcess($file, $arguments) {
  Plain $file
  $info = [Diagnostics.ProcessStartInfo]::new($file)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WorkingDirectory = $env:LAZYSH_GUI_CLIENT_ROOT
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
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
function ExerciseInstalledGui {
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
  try {
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
    $env:LAZYSH_GUI_RECEIPT = Join-Path $directory 'gui-receipt.json'
    Require (!(OptionalItem $env:LAZYSH_GUI_RECEIPT)) 'EXISTING_PATH'
    $env:LAZYSH_GUI_BINARY = $installed
    $env:LAZYSH_GUI_PORT = [string]$ports[0]
    $env:LAZYSH_GUI_NATIVE_PORT = [string]$ports[1]
    $driver = GuiProcess $env:LAZYSH_GUI_DRIVER @('--port', [string]$ports[0], '--native-port', [string]$ports[1], '--native-host', '127.0.0.1', '--native-driver', $env:LAZYSH_GUI_EDGE)
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
    $client = GuiProcess $env:LAZYSH_GUI_NODE @($env:LAZYSH_GUI_VITEST, 'run', '--config', 'vitest.native-gui.config.ts', 'native-e2e/windows/installed.spec.ts')
    Require ($client.WaitForExit(120000)) 'GUI_TIMEOUT'
    if ($client.ExitCode -ne 0) {
      Plain $env:LAZYSH_GUI_RECEIPT
      if ((Test-Path -LiteralPath $env:LAZYSH_GUI_RECEIPT -PathType Leaf) -and (Get-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT).Length -le 4096) {
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
          if ($null -ne $rejected.metadata) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_GUI_METADATA:' + ($rejected.metadata | ConvertTo-Json -Depth 4 -Compress)) }
          Require $false $sessionCode
        }
        if ($rejected.failure -in @('GUI_FRONTEND', 'GUI_VERSION', 'GUI_OWNER')) { Require $false $rejected.failure }
      }
      Require $false 'GUI_CLIENT'
    }
    Plain $env:LAZYSH_GUI_RECEIPT
    Require ((Get-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT).Length -le 1024) 'GUI_CLIENT'
    $receipt = Get-Content -Raw -LiteralPath $env:LAZYSH_GUI_RECEIPT | ConvertFrom-Json
    Require ($receipt.source -eq $env:GITHUB_SHA -and $receipt.version -eq $env:LAZYSH_VERSION -and $receipt.sha256 -eq $env:LAZYSH_NSIS_BINARY_SHA256 -and $receipt.pid -gt 0 -and $receipt.start -match '^[1-9][0-9]{0,19}$' -and $receipt.window -match '^[1-9][0-9]{0,19}$') 'GUI_CLIENT'
    [Console]::Out.WriteLine((@{source=$receipt.source;version=$receipt.version;sha256=$receipt.sha256;pid=$receipt.pid;start=$receipt.start;window=$receipt.window;webview=$runtime;edgeDriver=$edgeVersion} | ConvertTo-Json -Compress))
    Installed
  } catch {
    $primaryFailure = $script:failure
  } finally {
    $script:failure = 'GUI_CLEANUP'
    $cleanupFailed = $false
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
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
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
      if ($primaryFailure) { [Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:' + $primaryFailure) }
      Require $false 'GUI_CLEANUP'
    }
  }
  if ($primaryFailure) { Require $false $primaryFailure }
  $script:failure = 'UNEXPECTED'
  [Console]::Out.WriteLine('Windows installed GUI bundled version, source, image and owned window passed')
}
`;
