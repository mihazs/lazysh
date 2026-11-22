#!/bin/sh
# Usage: native-terminal-switch.sh <workflow input> <repository variable>
# Print on or off: the value of LAZYSH_NATIVE_TERMINAL a release build is made with (the kill switch of #1342, read by the client build and
# by src-tauri/build.rs). A workflow input of on or off wins; an input that is empty or `default` leaves it to the repository variable
# LAZYSH_NATIVE_TERMINAL; with neither the engine is built. Anything else fails here, before a build runs for an hour and ends in build.rs's panic.
set -eu
input=${1-} variable=${2-}
case "$input" in on | off) echo "$input"; exit 0 ;; '' | default) ;; *) echo "native-terminal must be default, on or off, not \"$input\"" >&2; exit 1 ;; esac
case "$variable" in on | off) echo "$variable" ;; '') echo on ;; *) echo "The repository variable LAZYSH_NATIVE_TERMINAL must be on or off, not \"$variable\"" >&2; exit 1 ;; esac
