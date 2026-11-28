#!/bin/sh
# Verifies the same-run stock Herdr download and exports its path to later steps as the variable named by $1.
set -eu
cd "$RUNNER_TEMP/lazysh-stock-herdr"
test -f herdr
test -s herdr
test "$(stat -c%s herdr)" -le 536870912
printf '%s  herdr\n' "$STOCK_HERDR_SHA256" | sha256sum --check --strict
bun -e '
const receipt=await Bun.file("source.json").json();
const expected={schemaVersion:1,sourceCommit:"2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01",archiveSha256:"cbd4354f1c44530d9f094c2797380208c50f19b4d6350b6e5206e220133c3168",
  manifestSha256:"c303652ea2d310b78fdc9222cb30b405915890c0522239c9daf734591cb08e8a",sourceFiles:1843,binarySha256:process.env.STOCK_HERDR_SHA256,checkout:process.env.GITHUB_SHA};
if(Object.keys(receipt).length!==Object.keys(expected).length || Object.entries(expected).some(([key,value])=>receipt[key]!==value))throw new Error("Stock Herdr provenance mismatch");'
chmod 700 herdr
printf '%s\n' "$1=$RUNNER_TEMP/lazysh-stock-herdr/herdr" >> "$GITHUB_ENV"
