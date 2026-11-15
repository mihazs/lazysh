#!/usr/bin/env bash
# Usage: external-linux-host.sh <state-directory> <port> <share-directory>
# Start an unprivileged OpenSSH server on 127.0.0.1:<port> with an isolated HOME and a ready tmux,
# Zellij and Herdr, for a client that runs outside this machine's POSIX userland (the Windows job
# runs it inside WSL). The client reads <share-directory>/{key,fingerprint,user}; the server
# keeps running in the background until <state-directory>/sshd.pid is killed.
# Zellij and Herdr are set up only when they are on PATH; Herdr also gets a running server named
# ext-default with one workspace labelled EXT_DEFAULT.
set -euo pipefail
dir=$1 port=$2 share=$3
mkdir -p "$dir/home" "$share"
dir=$(cd "$dir" && pwd -P)
for child in config-home cache-home state-home runtime data-home tmp zellij-sockets; do
  mkdir -p "$dir/$child"
  chmod 700 "$dir/$child"
done
# sshd's SetEnv splits on whitespace, so the paths must be plain tokens.
case $dir in *[!A-Za-z0-9_./-]*) echo "state directory must be a plain path: $dir" >&2; exit 1 ;; esac
# LAZYSH_HOST_PATH puts a private tool directory first when the tools are not installed system-wide.
path=${LAZYSH_HOST_PATH:-/usr/local/bin:/usr/bin:/bin}
# SHELL makes every new tmux pane run /bin/sh, whatever the account's own login shell prints first.
settings="SHELL=/bin/sh HOME=$dir/home ZDOTDIR=$dir/home TMUX_TMPDIR=$dir/tmp PATH=$path XDG_CONFIG_HOME=$dir/config-home XDG_CACHE_HOME=$dir/cache-home XDG_STATE_HOME=$dir/state-home XDG_RUNTIME_DIR=$dir/runtime XDG_DATA_HOME=$dir/data-home TMPDIR=$dir/tmp ZELLIJ_SOCKET_DIR=$dir/zellij-sockets"

ssh-keygen -q -t ed25519 -N '' -f "$dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$dir/user_key"
cp "$dir/user_key.pub" "$dir/authorized_keys"
cp "$dir/user_key" "$share/key"
id -un > "$share/user"
# `ssh-keygen -l` prints `256 SHA256:<digest> comment (ED25519)`.
ssh-keygen -l -f "$dir/host_key.pub" | awk '{print $2}' > "$share/fingerprint"

# Never read the account's own configuration: the first-run screens would intercept input.
config="$dir/home/.config/zellij"
mkdir -p "$config/layouts"
printf '%s\n' 'show_release_notes false' 'show_startup_tips false' 'session_serialization false' 'default_shell "/bin/sh"' 'default_layout "owned"' > "$config/config.kdl"
printf '%s\n' 'layout { pane command="/bin/sh" { args "-c" "echo ZELLIJ-PANE-READY; exec /bin/sh"; }; }' > "$config/layouts/owned.kdl"
for variant in herdr herdr-dev; do
  mkdir -p "$dir/config-home/$variant"
  printf '%s\n' 'onboarding = false' '[terminal]' "default_shell = '/bin/sh'" "shell_mode = 'non_login'" '[update]' 'version_check = false' 'manifest_check = false' > "$dir/config-home/$variant/config.toml"
done

cat > "$dir/sshd_config" <<EOF
ListenAddress 127.0.0.1
Port $port
HostKey $dir/host_key
AuthorizedKeysFile $dir/authorized_keys
PidFile $dir/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
LogLevel ERROR
SetEnv $settings
EOF
# `su` keeps root's PATH, but a restricted one may omit sbin.
sshd=$(command -v sshd || echo /usr/sbin/sshd)
# sshd keeps running after this script: a new session, no inherited terminal.
setsid "$sshd" -D -e -f "$dir/sshd_config" > "$dir/sshd.log" 2>&1 < /dev/null &
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then break; fi
  sleep 0.2
done
(exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || { cat "$dir/sshd.log" >&2; echo "sshd did not listen on $port" >&2; exit 1; }

if command -v herdr > /dev/null; then
  herdr() { env -i $settings TERM=xterm-256color LANG=C.UTF-8 herdr --session ext-default "$@"; }
  setsid env -i $settings TERM=xterm-256color LANG=C.UTF-8 "$(command -v herdr)" --session ext-default server > "$dir/herdr.log" 2>&1 < /dev/null &
  for _ in $(seq 1 100); do
    herdr api snapshot > /dev/null 2>&1 && break
    sleep 0.2
  done
  herdr workspace create --no-focus --label EXT_DEFAULT --cwd "$dir" > /dev/null
fi
echo "external Linux host ready on 127.0.0.1:$port as $(cat "$share/user")"
