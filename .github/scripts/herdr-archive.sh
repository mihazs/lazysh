#!/bin/sh
# Usage: herdr-archive.sh download|admit
# Env: HERDR_CI_ROOT, HERDR_ARCHIVE_NAME; download also HERDR_ARCHIVE_URL; admit also HERDR_PACKAGE_HASH and ZIG.
# download: fetch a pinned archive once into $HERDR_CI_ROOT. admit: stage it in the Zig package cache
# (run in the libghostty-vt directory) only when `zig fetch` reports the unchanged package hash.
set -eu
archive="$HERDR_CI_ROOT/$HERDR_ARCHIVE_NAME.tar.gz"
case "$1" in
  download)
    curl --fail --silent --show-error --location --max-redirs 5 --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --max-filesize 33554432 --output "$archive" --write-out 'archive http=%{http_code} bytes=%{size_download} seconds=%{time_total}\n' "$HERDR_ARCHIVE_URL"
    sha256sum "$archive"
    ;;
  admit)
    timeout --kill-after=5s 20s gzip --test "$archive"
    actual=$(timeout --kill-after=5s 60s "$ZIG" fetch "$archive")
    if [ "$actual" != "$HERDR_PACKAGE_HASH" ]; then
      printf '%s\n' 'Herdr archive package hash mismatch' >&2
      exit 1
    fi
    ;;
  *) echo "usage: $0 download|admit" >&2; exit 2 ;;
esac
