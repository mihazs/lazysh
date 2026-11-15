$ErrorActionPreference = 'Continue'
$ossh = Join-Path $env:SystemRoot 'System32\OpenSSH'
$d = Join-Path $env:RUNNER_TEMP 'disc'
New-Item -ItemType Directory -Force $d, "$d\bin" | Out-Null
"whoami: $(whoami)"; "admin: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))"
"OpenSSH registry before:"; Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue | Format-List | Out-String
"sshd service:"; (Get-Service sshd -ErrorAction SilentlyContinue | Out-String)
& "$ossh\sshd.exe" -V 2>&1 | Out-String
& "$ossh\ssh.exe" -V 2>&1 | Out-String
foreach ($n in 'host_key', 'client_key') { & "$ossh\ssh-keygen.exe" -q -t ed25519 -N '""' -f "$d\$n" }
Copy-Item "$d\client_key.pub" "$d\authorized_keys"
icacls.exe "$d\host_key" /inheritance:r /grant 'SYSTEM:F' /grant 'Administrators:F' | Out-Null
$port = 2299
$slash = { param($p) $p.Replace('\', '/') }
$config = "$d\sshd_config"
@("Port $port", 'ListenAddress 127.0.0.1', "HostKey $(& $slash "$d\host_key")", "AuthorizedKeysFile $(& $slash "$d\authorized_keys")",
  "PidFile $(& $slash "$d\sshd.pid")", 'AuthenticationMethods publickey', 'PasswordAuthentication no', 'StrictModes no', 'LogLevel DEBUG3',
  'SetEnv LAZYSH_SETENV=fromsetenv') | Set-Content -Encoding ascii $config
$env:LAZYSH_ENVPROBE = 'fromparent'
$env:Path = "$d\bin;$env:Path"
$log = "$d\sshd.log"
$server = Start-Process -FilePath "$ossh\sshd.exe" -ArgumentList '-D', '-E', $log, '-f', $config -PassThru -WindowStyle Hidden
Start-Sleep 3
"sshd pid $($server.Id) exited=$($server.HasExited)"
function Ssh([string]$command) {
  $out = & "$ossh\ssh.exe" -p $port -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i "$d\client_key" "$env:USERNAME@127.0.0.1" $command 2>&1 | Out-String
  "--- [$command] exit=$LASTEXITCODE`n$out"
}
function Probe($label) {
  "=================== $label"
  Ssh 'echo %OS% $PSVersionTable.PSVersion.Major'
  Ssh 'echo %CMDCMDLINE%'
  Ssh 'echo %LAZYSH_ENVPROBE% %LAZYSH_SETENV%'
  Ssh 'echo $env:LAZYSH_ENVPROBE $env:LAZYSH_SETENV'
  Ssh 'echo %PATH%'
  Ssh 'echo $env:PATH'
  Ssh '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CommandLine'
  Ssh 'powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABoAGkA'
  Ssh 'powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand ZQB4AGkAdAAgADcA'
  Ssh 'sh -c ls'
  Ssh 'lazysh-agent --version'
}
Probe 'DefaultShell absent'
New-Item -Path 'HKLM:\SOFTWARE' -Name OpenSSH -Force | Out-Null
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $ps -PropertyType String -Force | Out-Null
Probe "DefaultShell=$ps"
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\cmd.exe" -PropertyType String -Force | Out-Null
Probe 'DefaultShell=cmd.exe'
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force
Start-Sleep 1
"=========== sshd log tail"
Get-Content $log -Tail 120 -ErrorAction SilentlyContinue | Out-String
