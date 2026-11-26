$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This rehearsal requires a disposable GitHub-hosted Windows desktop.'
}

$narratorKey = 'HKCU:\Software\Microsoft\Narrator\NoRoam'
function Read-NarratorRunning {
  $entry = Get-ItemProperty -LiteralPath $narratorKey -ErrorAction SilentlyContinue
  return ($null -ne $entry -and $entry.RunningState -ne 0 -and $null -ne $entry.RunningState)
}

if ((Read-NarratorRunning) -or (Get-Process -Name Narrator -ErrorAction SilentlyContinue)) {
  throw 'The runner already has a Narrator session.'
}

$reader = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\Narrator.exe') -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Read-NarratorRunning)) {
    if ($reader.HasExited -or [DateTime]::UtcNow -ge $deadline) {
      throw 'The hosted Narrator never set its running marker.'
    }
    Start-Sleep -Milliseconds 100
  }
  Write-Output 'Narrator running marker observed after startup.'
  # Narrator Home can live in the tray, so the reader need not have a closable
  # main window. Use the documented Windows+Ctrl+Enter stop shortcut.
  Add-Type -Namespace LazyshRehearsal -Name Keyboard -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);
'@
  $keys = @(0x5B, 0x11, 0x0D)
  foreach ($key in $keys) {
    [LazyshRehearsal.Keyboard]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
  }
  [array]::Reverse($keys)
  foreach ($key in $keys) {
    [LazyshRehearsal.Keyboard]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
  }
  if (-not $reader.WaitForExit(10000)) {
    throw 'The task-owned Narrator did not exit after its stop shortcut.'
  }
  if (Read-NarratorRunning) {
    throw 'The Narrator running marker remained set after the process exited.'
  }
  Write-Output 'Narrator running marker cleared after normal shutdown.'
} finally {
  if (-not $reader.HasExited) {
    $reader.Kill()
    if (-not $reader.WaitForExit(5000)) {
      throw 'The task-owned Narrator process did not exit during cleanup.'
    }
  }
}
