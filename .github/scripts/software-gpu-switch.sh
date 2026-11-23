#!/bin/sh
# Usage: software-gpu-switch.sh <present|absent> <liblazysh_lib.so | app.apk>...
# Checks the built artifact, not the source, for the Android debug switch that lets the native terminal draw on a CPU rasterizer
# (native_renderer.rs reads it only in a debug build on Android): every library named, or every liblazysh_lib.so inside an APK, must
# carry the variable's name when `present` and must not when `absent`. `present` on the debug libraries is the control that keeps
# `absent` on the release APK from passing because the name was renamed. Fails when it finds no library.
set -eu
want=$1
shift
name=LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
checked=0
check() { # <label> <file>
  if grep -aqF "$name" "$2"; then found=present; else found=absent; fi
  echo "$1: $found"
  [ "$found" = "$want" ] || { echo "$1: the switch is $found, it must be $want" >&2; exit 1; }
  checked=$((checked + 1))
}
for artifact; do
  case "$artifact" in
    *.apk)
      unzip -Z1 "$artifact" | grep -E '^lib/[^/]+/liblazysh_lib[.]so$' > "$tmp/entries" || true
      while IFS= read -r entry; do
        unzip -p "$artifact" "$entry" > "$tmp/library"
        check "$artifact $entry" "$tmp/library"
      done < "$tmp/entries"
      ;;
    *) [ -f "$artifact" ] || { echo "No library at $artifact" >&2; exit 1; }; check "$artifact" "$artifact" ;;
  esac
done
[ "$checked" -gt 0 ] || { echo "No liblazysh_lib.so to check" >&2; exit 1; }
