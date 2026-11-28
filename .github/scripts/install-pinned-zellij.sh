#!/bin/sh
# Installs the pinned official Zellij 0.45.1 release outside the checkout and exports it to later steps.
set -eu
zellij_root=$(mktemp -d "$RUNNER_TEMP/lazysh-zellij-0.45.1-XXXXXX")
sh .github/scripts/pinned-download.sh 40bcc2e03f5d5ae8e054e39f676081fe12ab70871506996ba595834c3718eefc "$zellij_root/zellij.tar.gz" --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 120 --max-filesize 18729165 https://github.com/zellij-org/zellij/releases/download/v0.45.1/zellij-x86_64-unknown-linux-musl.tar.gz
printf '%s  %s\n' '40bcc2e03f5d5ae8e054e39f676081fe12ab70871506996ba595834c3718eefc' "$zellij_root/zellij.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file "$zellij_root/zellij.tar.gz" --directory "$zellij_root" --no-same-owner --no-same-permissions zellij
test "$("$zellij_root/zellij" --version)" = 'zellij 0.45.1'
echo "$zellij_root" >> "$GITHUB_PATH"
echo "LAZYSH_TEST_ZELLIJ=$zellij_root/zellij" >> "$GITHUB_ENV"
