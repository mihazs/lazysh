#!/bin/sh
# Builds canvasbench.apk. Usage: build.sh <sdk> <jdk> <out.apk> <assets-dir>   (assets-dir holds layouts/*.lzl from the Rust dump_layout example)
HERE=$(dirname "$0")
exec "$HERE/../android-apk.sh" "$HERE" app.lazysh.canvasbench BenchActivity "$@"
