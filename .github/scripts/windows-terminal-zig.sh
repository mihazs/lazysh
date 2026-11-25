#!/bin/sh
# Provision the pinned Windows Zig binary and describe the runner SDK for Ghostty.
set -eu

root=$1
scripts=$(dirname "$0")
mkdir -p "$root"
zig="$root/zig-x86_64-windows-0.16.0/zig.exe"
libc="$root/windows-libc.txt"

archive="$root/zig-x86_64-windows-0.16.0.zip"
LAZYSH_RESUME_PINNED_DOWNLOAD=1 sh "$scripts/pinned-download.sh" 68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e "$archive" --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --speed-limit 1024 --speed-time 30 --max-time 720 https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip
printf '%s  %s\n' '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e' "$archive" | sha256sum --check --strict
pwsh -NoProfile -Command "Expand-Archive -LiteralPath '$archive' -DestinationPath '$root'"
"$zig" version

# Zig 0.16 bundles Clang 21. The runner STL 14.52 requires Clang 22 unless
# _ALLOW_COMPILER_AND_STL_VERSION_MISMATCH is set in a task-owned header copy.
"$zig" libc > "$libc"
msvc_include="$(sed -n 's/^sys_include_dir=//p' "$libc" | tr -d '\r')"
cp -a "$(cygpath -u "$msvc_include")" "$root/msvc-include"
chmod -R u+w "$root/msvc-include"
sed -i '1i #define _ALLOW_COMPILER_AND_STL_VERSION_MISMATCH' "$root/msvc-include/yvals_core.h"
sed -i "s|^sys_include_dir=.*|sys_include_dir=$root/msvc-include|" "$libc"
cat "$libc"
"$zig" libc "$libc"
