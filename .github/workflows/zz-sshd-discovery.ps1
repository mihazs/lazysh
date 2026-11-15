$ErrorActionPreference = 'Continue'
$ossh = Join-Path $env:SystemRoot 'System32\OpenSSH'
$root = Join-Path $env:RUNNER_TEMP 'disc3'
New-Item -ItemType Directory -Force $root | Out-Null
$sys = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$slash = { param($p) $p.Replace('\', '/') }
function Run-Config($label, $port, $setenv) {
  "################ $label"
  $d = Join-Path $root $label
  New-Item -ItemType Directory -Force $d, "$d\bin" | Out-Null
  Copy-Item "$env:SystemRoot\System32\whoami.exe" "$d\bin\lazysh-agent.exe"
  foreach ($n in 'host_key', 'client_key') { & "$ossh\ssh-keygen.exe" -q -t ed25519 -N '""' -f "$d\$n" }
  Copy-Item "$d\client_key.pub" "$d\authorized_keys"
  icacls.exe "$d\host_key" /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
  @("Port $port", 'ListenAddress 127.0.0.1', "HostKey $(& $slash "$d\host_key")", "AuthorizedKeysFile $(& $slash "$d\authorized_keys")",
    "PidFile $(& $slash "$d\sshd.pid")", 'PasswordAuthentication no', 'StrictModes no', 'LogLevel DEBUG3') + @(& $setenv $d) | Set-Content -Encoding ascii "$d\sshd_config"
  Get-Content "$d\sshd_config" | Select-Object -Last 3
  $server = Start-Process -FilePath "$ossh\sshd.exe" -ArgumentList '-D', '-E', "$d\sshd.log", '-f', "$d\sshd_config" -PassThru -WindowStyle Hidden
  Start-Sleep 3
  function Ssh([string]$command) {
    $out = & "$ossh\ssh.exe" -p $port -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o LogLevel=ERROR -o BatchMode=yes -o IdentitiesOnly=yes -i "$d\client_key" "$env:USERNAME@127.0.0.1" $command 2>&1 | Out-String
    "--- [$command] exit=$LASTEXITCODE`n$($out.Substring(0, [Math]::Min($out.Length, 700)))"
  }
  Ssh 'echo %PATH% %LAZYSH_STATE_DIR%'
  Ssh 'lazysh-agent /user'
  Ssh 'sh -c ls'
  Stop-Process -Id $server.Id -Force
  "--- sshd log mentioning SetEnv / env"
  Select-String -Path "$d\sshd.log" -Pattern 'SetEnv|setenv|PATH=|LAZYSH' | Select-Object -First 8 | ForEach-Object { $_.Line }
}
Run-Config 'backslash-unquoted' 2297 { param($d) @("SetEnv PATH=$d\bin;$sys LAZYSH_STATE_DIR=$d\state") }
Run-Config 'forward-unquoted' 2296 { param($d) @("SetEnv PATH=$(& $slash "$d\bin");$(& $slash $sys) LAZYSH_STATE_DIR=$(& $slash "$d\state")") }
Run-Config 'two-lines' 2295 { param($d) @("SetEnv PATH=$d\bin;$sys", "SetEnv LAZYSH_STATE_DIR=$d\state") }
