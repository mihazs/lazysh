#!/bin/sh
# Builds webviewbench.apk, the host of the benchmark page in the Android System WebView. Usage: build.sh <sdk> <jdk> <out.apk>
HERE=$(dirname "$0")
NETWORK=1 exec "$HERE/../android-apk.sh" "$HERE" app.lazysh.webviewbench WebActivity "$@"
