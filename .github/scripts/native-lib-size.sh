#!/bin/sh
# Usage: native-lib-size.sh <abi> [checkout]
# Print the size of the app's native library for one Android ABI (arm64-v8a or x86_64) after `tauri android build`: as the debug build
# leaves it (it keeps its symbols) and stripped with the pinned NDK's llvm-strip ($NDK_HOME), the two figures the migration plan records
# for the terminal core (#2145). The line also goes to the job summary. Fails when the library is not there.
set -eu
abi=$1 root=${2:-.}
lib="$root/apps/client/src-tauri/gen/android/app/src/main/jniLibs/$abi/liblazysh_lib.so"
[ -f "$lib" ] || { echo "No $abi library at $lib" >&2; exit 1; }
copy=$(mktemp)
trap 'rm -f "$copy"' EXIT
"$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-unneeded -o "$copy" "$lib"
line="liblazysh_lib.so $abi: built $(stat -L -c %s "$lib") bytes, stripped $(stat -c %s "$copy") bytes"
echo "$line"
[ -z "${GITHUB_STEP_SUMMARY-}" ] || echo "- $line" >> "$GITHUB_STEP_SUMMARY"
