#!/bin/sh
# Usage: build-official-et.sh   (needs RUNNER_TEMP and GITHUB_ENV; cmake and the ET build libraries installed)
# Builds the pinned official ET 7.0.0 etserver and etterminal outside the checkout and exports
# ET_SERVER_BIN and ET_TERMINAL_BIN to later steps. The native Linux runtime suite and the Android
# SSH parity suite both run their real ET cases against these binaries.
# Release asset digest: https://api.github.com/repos/MisterTea/EternalTerminal/releases/tags/et-v7.0.0
set -eu
et_root=$(mktemp -d "$RUNNER_TEMP/lazysh-et-7.0.0-XXXXXX")
sh .github/scripts/pinned-download.sh 3065d282c552bc40b8f0d455e1cae2089847c9c4f7f9b4ca07b89f7c653af98e "$et_root/et_7.0.0.orig.tar.gz" --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --max-filesize 29021963 https://github.com/MisterTea/EternalTerminal/releases/download/et-v7.0.0/et_7.0.0.orig.tar.gz
test "$(stat -c%s "$et_root/et_7.0.0.orig.tar.gz")" -eq 29021963
printf '%s  %s\n' '3065d282c552bc40b8f0d455e1cae2089847c9c4f7f9b4ca07b89f7c653af98e' "$et_root/et_7.0.0.orig.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file "$et_root/et_7.0.0.orig.tar.gz" --directory "$et_root" --no-same-owner --no-same-permissions
cmake -S "$et_root/MisterTea-EternalTerminal-7656a32" -B "$et_root/build" -DCMAKE_BUILD_TYPE=Release -DDISABLE_VCPKG=ON -DDISABLE_TELEMETRY=ON -DBUILD_TESTING=OFF
cmake --build "$et_root/build" --parallel 4 --target etserver etterminal
test "$("$et_root/build/etserver" --version)" = 'et version 7.0.0'
printf '%s\n' "ET_SERVER_BIN=$et_root/build/etserver" "ET_TERMINAL_BIN=$et_root/build/etterminal" >> "$GITHUB_ENV"
