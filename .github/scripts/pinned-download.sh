#!/bin/sh
# Usage: pinned-download.sh <sha256> <output> <curl arguments...>
# Copy a pinned download from the job's restored cache when the cached bytes still match
# <sha256>; otherwise download it with the caller's curl arguments and cache only matching
# bytes. The caller still verifies <output> against the same pin before using it.
set -eu
sha=$1 output=$2
shift 2
cache=${LAZYSH_PINNED_DOWNLOADS:-${RUNNER_TEMP:?}/lazysh-pinned-downloads}
matches() { printf '%s  %s\n' "$sha" "$1" | sha256sum --check --strict --status 2>/dev/null; }
if matches "$cache/$sha"; then
  cp "$cache/$sha" "$output"
  printf 'pinned download cache hit %s\n' "$sha"
  exit 0
fi
curl "$@" -o "$output"
if matches "$output"; then
  mkdir -p "$cache"
  cp "$output" "$cache/$sha"
fi
