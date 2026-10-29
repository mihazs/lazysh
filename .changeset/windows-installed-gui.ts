import {win32} from 'node:path';

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

// Windows-only installed GUI acceptance. Paths are supplied exclusively through the child environment.
export const windowsGuiOwnerScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedGuiWindow {
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
  $driver = Get-Process -Id ([int]$env:LAZYSH_GUI_DRIVER_PID)
  if ($driver.StartTime.ToUniversalTime().Ticks.ToString() -ne $env:LAZYSH_GUI_DRIVER_START -or $driver.Path -ne $env:LAZYSH_GUI_DRIVER) { throw 'owner' }
  $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
  $owned = @([int]$driver.Id)
  for ($depth=0; $depth -lt 16; $depth++) {
    $next = @($all | Where-Object { [int]$_.ParentProcessId -in $owned -and [int]$_.ProcessId -notin $owned })
    if (!$next.Count) { break }
    $owned += @($next | ForEach-Object { [int]$_.ProcessId })
    if ($owned.Count -gt 128) { throw 'bound' }
  }
  $apps = @($all | Where-Object { [int]$_.ProcessId -in $owned -and $_.ExecutablePath -eq $env:LAZYSH_GUI_BINARY })
  if ($apps.Count -ne 1) { throw 'application' }
  $app = Get-Process -Id $apps[0].ProcessId
  if ($app.Path -ne $env:LAZYSH_GUI_BINARY -or (Get-FileHash -LiteralPath $app.Path -Algorithm SHA256).Hash -ne $env:LAZYSH_NSIS_BINARY_SHA256) { throw 'image' }
  $script:windows = @()
  $callback = [OwnedGuiWindow+Callback] {
    param($window, $state)
    [uint32]$owner = 0
    $null = [OwnedGuiWindow]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -eq $app.Id -and [OwnedGuiWindow]::IsWindowVisible($window)) { $script:windows += $window.ToInt64().ToString() }
    return $true
  }
  if (![OwnedGuiWindow]::EnumWindows($callback, [IntPtr]::Zero) -or $script:windows.Count -ne 1) { throw 'window' }
  @{pid=$app.Id;start=$app.StartTime.ToUniversalTime().Ticks.ToString();window=$script:windows[0];sha256=$env:LAZYSH_NSIS_BINARY_SHA256} | ConvertTo-Json -Compress
} catch { [Console]::Out.WriteLine('LAZYSH_WINDOWS_INSTALLER:gui:GUI_OWNER'); exit 1 }
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

export const windowsInstalledGuiScript = String.raw`
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
    $driver = GuiProcess $env:LAZYSH_GUI_DRIVER @('--port', [string]$ports[0], '--native-port', [string]$ports[1], '--native-host', '127.0.0.1', '--native-driver', $env:LAZYSH_GUI_EDGE)
    $env:LAZYSH_GUI_DRIVER_PID = [string]$driver.Id
    $env:LAZYSH_GUI_DRIVER_START = $driver.StartTime.ToUniversalTime().Ticks.ToString()
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Require (!$driver.HasExited) 'GUI_START'
      $sockets = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports })
      if ($sockets.Count -eq 2) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($sockets.Count -eq 0) { Require $false 'GUI_LISTENER_NONE' }
    if ($sockets.Count -eq 1) { Require $false 'GUI_LISTENER_ONE' }
    if ($sockets.Count -gt 2) {
      if (@($sockets | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -gt 0) { Require $false 'GUI_LISTENER_EXTRA_OTHER' }
      if (@($sockets | Where-Object { $_.LocalAddress -eq '::1' }).Count -gt 0) { Require $false 'GUI_LISTENER_EXTRA_LOOPBACK_V6' }
      Require $false 'GUI_LISTENER_EXTRA_LOOPBACK_V4'
    }
    Require (@($sockets | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -eq 0) 'GUI_LISTENER_ADDRESS'
    $nativeDriver = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | Where-Object { $_.ParentProcessId -eq $driver.Id -and $_.ExecutablePath -eq $env:LAZYSH_GUI_EDGE })
    Require ($nativeDriver.Count -eq 1) 'GUI_NATIVE_DRIVER'
    Require (@($sockets | Where-Object { $_.OwningProcess -notin @($driver.Id, $nativeDriver[0].ProcessId) }).Count -eq 0) 'GUI_ENDPOINT'
    $client = GuiProcess $env:LAZYSH_GUI_NODE @($env:LAZYSH_GUI_VITEST, 'run', '--config', 'vitest.native-gui.config.ts', 'native-e2e/windows/installed.spec.ts')
    Require ($client.WaitForExit(120000)) 'GUI_TIMEOUT'
    if ($client.ExitCode -ne 0) {
      Plain $env:LAZYSH_GUI_RECEIPT
      if ((Test-Path -LiteralPath $env:LAZYSH_GUI_RECEIPT -PathType Leaf) -and (Get-Item -LiteralPath $env:LAZYSH_GUI_RECEIPT).Length -le 1024) {
        $rejected = Get-Content -Raw -LiteralPath $env:LAZYSH_GUI_RECEIPT | ConvertFrom-Json
        if ($rejected.failure -in @('GUI_SESSION', 'GUI_FRONTEND', 'GUI_VERSION', 'GUI_OWNER')) { Require $false $rejected.failure }
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
