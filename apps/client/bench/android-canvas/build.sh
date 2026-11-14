#!/bin/sh
# Builds canvasbench.apk with the Android SDK command-line tools, no Gradle.
# Usage: build.sh <sdk> <jdk> <out.apk> <assets-dir>   (assets-dir holds layouts/*.lzl from the Rust dump_layout example)
set -eu
SDK=$1; JDK=$2; OUT=$3; ASSETS=$4
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1); JAR=$(ls -d "$SDK"/platforms/android-* | sort -V | head -1)/android.jar
HERE=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d)
export PATH="$JDK/bin:$PATH"
"$BT/aapt2" link -o "$W/base.apk" -I "$JAR" --manifest "$HERE/AndroidManifest.xml" --min-sdk-version 31 --target-sdk-version 33 -A "$ASSETS"
mkdir "$W/classes"
javac -source 17 -target 17 -Xlint:-options -cp "$JAR" -d "$W/classes" "$HERE"/src/app/lazysh/canvasbench/*.java
"$BT/d8" --lib "$JAR" --min-api 31 --output "$W" "$W"/classes/app/lazysh/canvasbench/*.class
(cd "$W" && jar --update --no-manifest --file base.apk classes.dex)
"$BT/zipalign" -f 4 "$W/base.apk" "$W/aligned.apk"
[ -f "$W/key.jks" ] || keytool -genkeypair -keystore "$W/key.jks" -storepass android -keypass android -alias bench -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=canvasbench" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$W/key.jks" --ks-pass pass:android --key-pass pass:android --out "$OUT" "$W/aligned.apk"
rm -rf "$W"
