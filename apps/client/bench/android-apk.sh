#!/bin/sh
# Builds a throwaway benchmark APK from src/**/*.java with the Android SDK command-line tools, no Gradle (#1323). The manifest is
# generated: one launcher activity; NETWORK=1 adds the INTERNET permission and cleartext traffic (a WebView loading the benchmark server).
# Usage: android-apk.sh <app-dir> <package> <activity> <sdk> <jdk> <out.apk> [assets-dir]
set -eu
APP=$(cd "$1" && pwd); PKG=$2; ACTIVITY=$3; SDK=$4; JDK=$5; OUT=$6; ASSETS=${7:-}
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1); JAR=$(ls -d "$SDK"/platforms/android-* | sort -V | head -1)/android.jar
W=$(mktemp -d)
PERMISSION=''; CLEARTEXT=''
if [ -n "${NETWORK:-}" ]; then PERMISSION='<uses-permission android:name="android.permission.INTERNET" />'; CLEARTEXT='android:usesCleartextTraffic="true"'; fi
export PATH="$JDK/bin:$PATH"
cat > "$W/AndroidManifest.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="$PKG">
    <uses-sdk android:minSdkVersion="31" android:targetSdkVersion="33" />
    $PERMISSION
    <application android:label="${PKG##*.}" android:debuggable="true" android:hardwareAccelerated="true" $CLEARTEXT>
        <activity android:name=".$ACTIVITY" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
XML
"$BT/aapt2" link -o "$W/base.apk" -I "$JAR" --manifest "$W/AndroidManifest.xml" --min-sdk-version 31 --target-sdk-version 33 ${ASSETS:+-A "$ASSETS"}
mkdir "$W/classes"
javac -source 17 -target 17 -Xlint:-options -cp "$JAR" -d "$W/classes" $(find "$APP/src" -name '*.java')
"$BT/d8" --lib "$JAR" --min-api 31 --output "$W" $(find "$W/classes" -name '*.class')
(cd "$W" && jar --update --no-manifest --file base.apk classes.dex)
"$BT/zipalign" -f 4 "$W/base.apk" "$W/aligned.apk"
keytool -genkeypair -keystore "$W/key.jks" -storepass android -keypass android -alias bench -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=bench" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$W/key.jks" --ks-pass pass:android --key-pass pass:android --out "$OUT" "$W/aligned.apk"
rm -rf "$W"
