#!/bin/sh
# Usage: apt-install.sh [--no-update] [package...]   (run as root)
# Install apt packages without letting a stalled mirror hang the job. It writes network
# timeouts and retries for every later apt run, bounds `apt-get update` and
# `apt-get install -y` with `timeout`, and on a failure or timeout switches the hosted
# runner's Azure mirror to HTTPS archive.ubuntu.com and tries once more.
# With no packages it only refreshes the package lists; with --no-update and no packages it
# only writes the network configuration. LAZYSH_APT_ROOT relocates /etc/apt for tests.
set -u
etc=${LAZYSH_APT_ROOT:-}/etc/apt
update_seconds=${LAZYSH_APT_UPDATE_SECONDS:-300}
install_seconds=${LAZYSH_APT_INSTALL_SECONDS:-900}
refresh=1
if [ "${1:-}" = --no-update ]; then refresh=; shift; fi

mkdir -p "$etc/apt.conf.d"
printf '%s\n' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
  'Acquire::ftp::Timeout "30";' 'Acquire::Retries "5";' > "$etc/apt.conf.d/99lazysh-bounded-network"

bounded() { seconds=$1; shift; timeout --kill-after=30 "$seconds" "$@"; }
update() { bounded "$update_seconds" apt-get update; }
install() { bounded "$install_seconds" apt-get install -y "$@"; }

# Both the one-line (jammy) and deb822 (noble) source formats, and the runner mirror list.
fallback() {
  printf '::warning::%s failed or timed out; retrying against archive.ubuntu.com\n' "$1"
  for file in "$etc/sources.list" "$etc/apt-mirrors.txt" "$etc"/sources.list.d/*.list "$etc"/sources.list.d/*.sources; do
    if [ -f "$file" ]; then sed -i -e 's#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g' -e 's#http://archive\.ubuntu\.com/#https://archive.ubuntu.com/#g' "$file" || return; fi
  done
}

if [ -n "$refresh" ] && ! update; then fallback 'apt-get update' && update || exit; fi
[ "$#" -gt 0 ] || exit 0
install "$@" && exit 0
fallback 'apt-get install' && update && bounded "$install_seconds" dpkg --configure -a && install "$@"
