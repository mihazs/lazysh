# Official Gotify Android acceptance

This opt-in native lane checks what the [Gotify relay destination](notification-relay.md#deliver-through-gotify-without-firebase)
cannot show on its own: that the unchanged official Gotify Android app, signed by its publisher and left in the
background, shows the relay's finite events. Source preparation and compilation are not a passing receipt; a result must
identify its exact checkout and artifacts. Official Gotify Android background delivery stays unqualified until a
`native-android-gotify` run passes (#904).

The `native-android-gotify` job owns a fresh API 36 emulator and a 35-minute budget. It runs for changes to the Gotify
owner, the notification relay and the helpers the owner reuses, and for every push to `main`
(`.github/scripts/native-changes.sh`, [CONTRIBUTING](../CONTRIBUTING.md#which-ci-jobs-a-pull-request-runs)). The emulator's
imagefile camera arguments only reuse the existing emulator-process ownership check; the case never opens a camera.

## What it exercises

[gotify-provenance.json](../apps/client/src-tauri/fixtures/gotify-provenance.json) pins the official Gotify Android 2.10.1
APK and the Gotify 3.1.1 Linux server by release asset digest. The host verifies both downloads, the APK signer and its
package identity, then starts the unmodified server with two loopback listeners:

- **Verified HTTPS** with a generated CA, used by the real relay worker (`apps/notification-service/examples/owned_gotify_android.rs`)
  and for the host's read-back of the server's own message API. Wrong CA and wrong hostname stay rejected.
- **Plain HTTP, no redirect** for the official app only, reached through one owned `adb reverse` pair. The app manifest
  already permits cleartext traffic (`usesCleartextTraffic` and a `base-config` with `cleartextTrafficPermitted=true`).

The native case (`GotifyAndroidTest`) logs in through the app's public UI, grants only the notifications and alarm
permissions the app asks for, sends the app to the background and, for each of `working`, `needs_attention` and `done`,
requires the relay receipt, the server message, the Android notification record, a visible SystemUI card and finally the
app's own message history. Android shows a foreground-service notification only when notification permission preceded the
service start, and the official app starts its service before its own permission prompt, so the case restarts the logged-in
app once after the grant (`am force-stop`, then a public launch) before it checks the app's "Connected" notification.
Installed APKs, UIDs, emulator continuity, the reverse mapping and package cleanup are
checked before and after; a failure keeps only a closed phase label in `failure.json`.

## Why plain HTTP for the client

An earlier version imported the CA through the app's Advanced dialog and Android's DocumentsUI picker. Hosted API 36 runs
never got past it (the last one failed in the picker's Downloads root lookup and click, job 126254933802, without saying which
of the two), and the lane never reached a notification. The app's TLS settings are Gotify's behaviour, not lazysh's, so the lane drops them: lazysh's own hop (relay
to server) keeps strict TLS and hostname verification.

A local run on a Waydroid Android 13 guest confirmed the official 2.10.1 APK logs in to `http://localhost:<port>` through
`adb reverse`, and that a message posted over the HTTPS listener while the app was in the background became an Android
notification record owned by the app. The same guest showed the foreground-service behaviour above: the "Connected"
notification record appeared only after the restart. The guest is not the API 36 target, so this does not replace a passing hosted run.

## Not covered

Doze, survival of a force-stop, reboot, OEM background limits, physical devices, an app-side TLS or private-CA setup and the production
relay CLI's trust of a private CA. Gotify HTTP success still means server acceptance only.
