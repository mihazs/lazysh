param([switch]$InstalledGui)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This rehearsal requires a disposable GitHub-hosted Windows desktop.'
}

$narratorKey = 'HKCU:\Software\Microsoft\Narrator\NoRoam'
function Read-NarratorRunning {
  $entry = Get-ItemProperty -LiteralPath $narratorKey -ErrorAction SilentlyContinue
  return ($null -ne $entry -and $entry.RunningState -ne 0 -and $null -ne $entry.RunningState)
}

Add-Type -Namespace LazyshRehearsal -Name Accessibility -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("uiautomationcore.dll")]
public static extern int UiaClientsAreListening();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int SystemParametersInfoW(uint action, uint parameter, out int value, uint flags);
'@

function Write-AccessibilitySample([string]$phase) {
  $legacy = 0
  $legacyAvailable = [LazyshRehearsal.Accessibility]::SystemParametersInfoW(70, 0, [ref]$legacy, 0) -ne 0
  [ordered]@{
    phase = $phase
    narratorRunning = (Read-NarratorRunning)
    uiaListener = ([LazyshRehearsal.Accessibility]::UiaClientsAreListening() -ne 0)
    legacyAvailable = $legacyAvailable
    legacyActive = ($legacyAvailable -and $legacy -ne 0)
  } | ConvertTo-Json -Compress | Write-Output
}

$detector = 'screen_reader::windows_tests::real_narrator_changes_windows_accessibility_detection'
function Assert-Detector([string]$expected) {
  $env:LAZYSH_EXPECT_NARRATOR = $expected
  $result = cargo test --locked -p lazysh --features native-terminal --lib -- --ignored --exact $detector
  if ($LASTEXITCODE -ne 0 -or -not ($result -match '1 passed; 0 failed')) {
    throw "The app detector did not complete the expected $expected assertion: $result"
  }
  Write-Output "App detector matched expected Narrator state $expected."
}

if ((Read-NarratorRunning) -or (Get-Process -Name Narrator -ErrorAction SilentlyContinue)) {
  throw 'The runner already has a Narrator session.'
}
Write-AccessibilitySample 'before'
if (-not $InstalledGui) { Assert-Detector 'false' }

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
  Write-AccessibilitySample 'running'
  if ($InstalledGui) {
    bun test tests/windows-installed-gui.test.ts --test-name-pattern 'observes the real shell cwd'
    if ($LASTEXITCODE -ne 0) { throw 'The installed Narrator fallback test failed.' }
  } else {
    Assert-Detector 'true'
  }
  Start-Sleep -Seconds 2
  if ($reader.HasExited -or -not (Read-NarratorRunning)) {
    throw 'The owned Narrator exited before the stop shortcut.'
  }
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
  Write-AccessibilitySample 'after'
  if (-not $InstalledGui) { Assert-Detector 'false' }
} finally {
  if (-not $reader.HasExited) {
    $reader.Kill()
    if (-not $reader.WaitForExit(5000)) {
      throw 'The task-owned Narrator process did not exit during cleanup.'
    }
  }
}
