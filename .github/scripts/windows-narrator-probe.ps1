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
  $reader.Refresh()
  if (-not $reader.CloseMainWindow() -or -not $reader.WaitForExit(10000)) {
    throw 'The task-owned Narrator window did not close normally.'
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
