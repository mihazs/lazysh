#!/bin/sh
# Usage: retry-zig-fetch.sh <command...>
# Run <command>, a Cargo build whose build script runs `zig build`, and run it again when
# Zig failed to download or unpack a hash-pinned dependency: at most LAZYSH_FETCH_ATTEMPTS
# runs in all (default 3), LAZYSH_FETCH_DELAY seconds apart (default 20). Any other failure,
# such as a compile error or a package hash mismatch, is returned at once, and every
# attempt's output stays in the log so the original failure remains visible. Zig checks each
# package against its pinned hash on every run, so a retry never weakens that check.
set -u
attempts=${LAZYSH_FETCH_ATTEMPTS:-3} delay=${LAZYSH_FETCH_DELAY:-20}
work=$(mktemp -d) || exit
trap 'rm -rf "$work"' EXIT
transient="HTTP response read failure|invalid HTTP response|bad HTTP response code: '5|unable to connect to server|unable to unpack tarball to temporary directory: ReadFailed"
attempt=1
while :; do
  { "$@" 2>&1; echo $? > "$work/status"; } | tee "$work/log"
  status=$(cat "$work/status")
  if [ "$status" -eq 0 ] || [ "$attempt" -ge "$attempts" ] || ! grep -Eq "$transient" "$work/log"; then exit "$status"; fi
  printf '::warning::Zig dependency download failed on attempt %s of %s; retrying in %s seconds\n' "$attempt" "$attempts" "$delay"
  sleep "$delay"
  attempt=$((attempt + 1))
done
