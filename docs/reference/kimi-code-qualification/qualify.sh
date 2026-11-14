#!/bin/sh
# Run qualify.py against an official Kimi Code linux-x64 release inside a network-less bubblewrap sandbox.
# Usage: qualify.sh <kimi-code-linux-x64.tar.gz> [summary.json]
# Needs: bwrap, tmux, python3 and the archive's published .sha256 sidecar next to it. Nothing real is read:
# the sandbox sees /usr read-only, an empty HOME, no network, no host environment and no host tmux.
set -eu
archive=$1
out=$(realpath -m "${2:-summary.json}")
here=$(cd "$(dirname "$0")" && pwd)
[ "$(cut -d' ' -f1 "$archive.sha256")" = "$(sha256sum "$archive" | cut -d' ' -f1)" ] ||
  { echo "refusing $archive: sha256 differs from its published sidecar" >&2; exit 2; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/kimi"
tar -xzf "$archive" -C "$work/kimi"
sys=
for d in /bin /sbin /lib /lib64; do # merged-usr hosts symlink these into /usr
  if [ -L "$d" ]; then sys="$sys --symlink $(readlink "$d") $d"; elif [ -d "$d" ]; then sys="$sys --ro-bind $d $d"; fi
done
# shellcheck disable=SC2086
bwrap --unshare-all --die-with-parent --ro-bind /usr /usr $sys \
  --ro-bind "$work/kimi" /opt/kimi --ro-bind "$here/qualify.py" /qualify.py --bind "$work" /out \
  --proc /proc --dev /dev --tmpfs /tmp --clearenv --setenv PATH /usr/bin:/opt/kimi --setenv HOME /tmp --setenv TERM xterm-256color \
  python3 /qualify.py /out/summary.json && status=0 || status=$?
[ -f "$work/summary.json" ] && cp "$work/summary.json" "$out"
exit "$status"
