# Android device registration

Remote push registration is a separate opt-in control from the connected-host inbox and local notifications. It currently implements Android Firebase Cloud Messaging (FCM) device registration only. iOS APNs registration, relay/account binding, authenticated event ingestion, delivery tests and cold-start session routing remain incomplete in issue #14. Enabling registration does not create those services.

An unconfigured build reports that remote registration is unavailable. The repository contains no Firebase project configuration, provider keys, service-account credentials or default delivery endpoint. A release maintainer must add the Firebase Android application configuration for the actual application ID using the [official Firebase setup](https://firebase.google.com/docs/android/setup). Google Services Gradle processing is not silently enabled; the generated Firebase string resources may instead be supplied through the normal Android resource source set. Never put provider service-account JSON in an Android package.

The plugin uses `com.google.firebase:firebase-messaging:26.0.0`, the version listed by the current [Firebase Android setup documentation](https://firebase.google.com/docs/android/setup), and `play-services-base:18.11.1` for the availability check described in [Google's setup guidance](https://developers.google.com/android/guides/setup). Compatible Google Play services and notification permission are required. The API36 AOSP runtime-test image intentionally has no Google Play services and cannot establish FCM delivery.

Both FCM auto-initialization and analytics collection default to false in the library manifest, following [Firebase's explicit opt-in guidance](https://firebase.google.com/docs/cloud-messaging/android/get-started#prevent-auto-initialization). No Analytics SDK is added. The settings panel explains the external service and requires explicit consent before initial registration. Registration then enables FCM auto-init and requests the current token. The SDK owns token storage; neither Rust command responses nor renderer state contain the token. Only consent and conservative token-presence markers are stored in app-private Android preferences. No SSH metadata, transcripts, prompts or host events are sent by this registration code.

`FirebaseMessagingService.onNewToken` records native rotation without copying or logging the token. Pause immediately disables auto-init and requests `deleteToken()`. If token creation was in flight, deletion waits for its completion; a late token cannot undo pause. Rotation during deletion requires another deletion before the control acknowledges success. A failed deletion keeps a visible retry marker. Native operations serialize register/revoke; another registration cannot race an unfinished revocation. An SDK operation that never finishes can leave the native operation busy; a later app restart and explicit retry may be necessary. Deletion does not remove the Firebase Installation ID or revoke any future relay account binding; no relay exists here. Already-delivered/in-flight notifications may remain visible.

This plugin has no remote payload handler or verified delivery pipeline. Configured Firebase projects must restrict provider access and must not send sensitive notification bodies. Do not infer receipt, authenticated sender validation, cross-device delivery or background execution from a successful token registration.

## Verification

`RegistrationControllerTest` uses standard Gradle JUnit tests and a controllable messaging driver to exercise consent, asynchronous cancellation, late rotation, revocation failure/retry and one-at-a-time operations. The plugin itself compiles against the real FCM Android SDK. These tests do not contact Google or certify device registration. `PushSettingsPanel.test.tsx` uses the client's native Vitest structure to test consent, unavailable configuration, sanitized failures and revocation retry.

After the Tauri Android build has generated plugin metadata, run the package's Android tests through the generated Gradle workspace:

```sh
apps/client/src-tauri/gen/android/gradlew -p apps/client/src-tauri/gen/android :tauri-plugin-lazysh-push:testDebugUnitTest
```

Physical-device registration/rotation/revocation with a dedicated Firebase test project and an actual authenticated sender remain unexecuted. No provider project is created automatically.
