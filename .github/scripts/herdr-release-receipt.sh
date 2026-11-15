#!/bin/sh
# Usage: herdr-release-receipt.sh <executable> <source-manifest> <receipt>
# Measure the glibc a release-profile managed Herdr needs, fail when it is above the documented
# floor, and write the receipt that binds the exact bytes to their source, feature set and
# toolchains. Nothing is written when the check fails. Only a Linux x86-64 glibc executable is
# measurable: any other file, and one with no glibc symbol version to measure, is refused.
# Environment: HERDR_SOURCE_COMMIT (pinned upstream commit), HERDR_FEATURES (space separated),
# GITHUB_SHA (the lazysh checkout), ZIG (the Zig executable), HERDR_GLIBC_FLOOR (default below),
# HERDR_RUST_TOOLCHAIN (default 1.96.1).
set -eu
export LC_ALL=C
exe=${1:?executable} manifest=${2:?source manifest} receipt=${3:?receipt}
# Ubuntu 22.04's glibc 2.35 is the oldest native consumer and the producer runner. Raise it only
# with the deployment floor stated in packages/herdr-upstream/PROVENANCE.md.
floor=${HERDR_GLIBC_FLOOR:-2.35}
toolchain=${HERDR_RUST_TOOLCHAIN:-1.96.1}
fail() { printf '%s\n' "$*" >&2; exit 1; }

header=$(readelf --file-header "$exe" 2>/dev/null) || fail "$exe is not an ELF executable"
printf '%s\n' "$header" | grep -q 'Class:  *ELF64$' || fail "$exe is not a 64-bit ELF executable"
printf '%s\n' "$header" | grep -q 'Machine:  *Advanced Micro Devices X86-64$' || fail "$exe is not an x86-64 executable"
maximum=$(readelf --version-info --wide "$exe" | sed -n 's/.*Name: GLIBC_\([0-9][0-9.]*\).*/\1/p' | sort -uV | tail -n 1)
[ -n "$maximum" ] || fail "$exe needs no glibc symbol version, so its libc floor cannot be measured"
if [ "$(printf '%s\n%s\n' "$maximum" "$floor" | sort -V | tail -n 1)" != "$floor" ]; then
  fail "$exe needs GLIBC_$maximum, above the documented floor GLIBC_$floor"
fi

commit=${HERDR_SOURCE_COMMIT:?} checkout=${GITHUB_SHA:?} features=${HERDR_FEATURES:?} zig=${ZIG:?}
manifest_digest=$(sha256sum "$manifest" | cut -d ' ' -f 1)
digest=$(sha256sum "$exe" | cut -d ' ' -f 1)
rustc_version=$(rustc "+$toolchain" --version)
cargo_version=$(cargo "+$toolchain" --version)
zig_version=$("$zig" version)
libc_version=$(getconf GNU_LIBC_VERSION)
jq -n \
  --arg commit "$commit" --arg manifest "$manifest_digest" --arg checkout "$checkout" --arg features "$features" \
  --arg digest "$digest" --arg rustc "$rustc_version" --arg cargo "$cargo_version" --arg zig "$zig_version" \
  --arg libc "$libc_version" --arg floor "$floor" --arg maximum "$maximum" \
  '{schemaVersion: 1, target: "x86_64-unknown-linux-gnu", profile: "release", features: ($features | split(" ")),
    sourceCommit: $commit, manifestSha256: $manifest, checkout: $checkout,
    toolchains: {rustc: $rustc, cargo: $cargo, zig: $zig, buildLibc: $libc},
    libc: {floor: $floor, maximum: $maximum}, binarySha256: $digest}' > "$receipt.partial"
mv "$receipt.partial" "$receipt"
