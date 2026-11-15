$ErrorActionPreference = 'Continue'
$ossh = Join-Path $env:SystemRoot 'System32\OpenSSH'
$d = Join-Path $env:RUNNER_TEMP 'disc2'
New-Item -ItemType Directory -Force $d, "$d\bin" | Out-Null
Copy-Item "$env:SystemRoot\System32\whoami.exe" "$d\bin\lazysh-agent.exe"
foreach ($n in 'host_key', 'client_key') { & "$ossh\ssh-keygen.exe" -q -t ed25519 -N '""' -f "$d\$n" }
Copy-Item "$d\client_key.pub" "$d\authorized_keys"
icacls.exe "$d\host_key" /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
$port = 2298
$slash = { param($p) $p.Replace('\', '/') }
$sys = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
@("Port $port", 'ListenAddress 127.0.0.1', "HostKey $(& $slash "$d\host_key")", "AuthorizedKeysFile $(& $slash "$d\authorized_keys")",
  "PidFile $(& $slash "$d\sshd.pid")", 'PasswordAuthentication no', 'StrictModes no', 'LogLevel VERBOSE',
  "SetEnv `"PATH=$d\bin;$sys`"", "SetEnv `"LAZYSH_STATE_DIR=$d\state`"") | Set-Content -Encoding ascii "$d\sshd_config"
Get-Content "$d\sshd_config"
& "$ossh\sshd.exe" -t -f "$d\sshd_config"; "sshd -t exit=$LASTEXITCODE"
$server = Start-Process -FilePath "$ossh\sshd.exe" -ArgumentList '-D', '-E', "$d\sshd.log", '-f', "$d\sshd_config" -PassThru -WindowStyle Hidden
Start-Sleep 3
function Ssh([string]$command) {
  $out = & "$ossh\ssh.exe" -p $port -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o LogLevel=ERROR -o BatchMode=yes -o IdentitiesOnly=yes -i "$d\client_key" "$env:USERNAME@127.0.0.1" $command 2>&1 | Out-String
  "--- [$command] exit=$LASTEXITCODE`n$out"
}
function Probe($label) {
  "=================== $label"
  Ssh 'echo %PATH% %LAZYSH_STATE_DIR%'
  Ssh 'echo $env:PATH $env:LAZYSH_STATE_DIR'
  Ssh 'lazysh-agent /user'
  Ssh 'powershell.exe -NoProfile -NonInteractive -InputFormat None -Command "lazysh-agent /user"'
  Ssh 'sh -c ls'
  Ssh 'sh -c ls 2>&1'
}
Probe 'DefaultShell absent'
New-Item -Path 'HKLM:\SOFTWARE' -Name OpenSSH -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
Probe 'DefaultShell=powershell'
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force
