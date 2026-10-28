# Native device registration

Remote push registration is a separate opt-in control from the connected-host inbox and local notifications. Normal Android builds use Firebase Cloud Messaging (FCM); F-Droid builds use UnifiedPush; iOS uses Apple Push Notification service (APNs). All remain off by default. Relay/account binding, authenticated event ingestion, delivery tests and cold-start session routing remain incomplete in issue #14. Enabling registration does not create those services.

## F-Droid UnifiedPush registration

The F-Droid Cargo feature selects a separate native Android module with the official [UnifiedPush connector](https://unifiedpush.org/kdoc/connector/), version 3.3.5. It does not include the Google registration module or an embedded FCM distributor. Install and configure a free-software distributor, such as [ntfy's F-Droid build](https://docs.ntfy.sh/subscribe/phone/), before registering. No lazysh account, subscription, purchase or public-server plan is required. Self-hosted infrastructure and network costs remain the operator's responsibility.

After system notification permission and explicit consent, Register opens the user's default distributor or the OS chooser. The app persists an opaque registration instance and consent in private preferences; the connector owns its cryptographic state. Status exposes only finite registration markers and explanations, never an endpoint, key, message or distributor package identifier. The application disables Android backup. Reading status does not register or contact a push server.

The controller serializes selection and uses operation epochs plus unique registration instances to reject old controls and callbacks. Refresh reuses the current instance. Pause persists disabled state before calling connector unregister. Late selection cannot issue Register; callbacks for retired instances cannot reactivate or remove a newer registration. A local cleanup exception retains an off/retry marker and blocks new registration until cleanup succeeds. SDK unregister removes local connector state and requests distributor unregistration; success does not establish remote-server deletion. Closing this view does not cancel an already admitted registration operation. An OS chooser that never returns can leave selection busy until app restart; no automatic retry or provider fallback is added.

The [current protocol](https://unifiedpush.org/developers/spec/android/) is AND_3.1.0. The published connector source supports legacy plaintext fallback after decryption failure; the registration-only path continues dropping incoming messages. An optional [private native enrollment flow](unifiedpush-enrollment.md) admits only bounded, decrypted, current-instance relay challenges for confirmation; events and notification display remain ignored. A non-exported application PushService receives the connector callbacks; the connector supplies the exported protocol receiver and identity handling. Endpoint callbacks require HTTPS/host/no-userinfo/no-fragment, public-key presence and 1,000-byte checks; temporary endpoints remain unavailable rather than selecting a fallback. Ordinary registration retains only markers; explicit relay enrollment privately uploads and encrypts the original endpoint/key snapshot.

Source provenance: Maven Central's [3.3.5 POM](https://repo.maven.apache.org/maven2/org/unifiedpush/android/connector/3.3.5/connector-3.3.5.pom) declares Apache-2.0, Kotlin 2.2.10 and Tink 1.23.0. Use the matching Apache-2.0 `tink-android:1.23.0` artifact instead of its server-JVM `tink` dependency, following the [connector's Android dependency advice](https://unifiedpush.org/kdoc/connector/) and [Tink Android setup](https://developers.google.com/tink/setup/java). Published connector source JAR SHA-256 is `6a8c5a253102f87bd0c8776d2bb2dedfab066b2980a89eb107679429a03de671`; AAR SHA-256 is `fa017cdfabbdc9af021e1f8c8eff2c8098e701d7a2c599937dce0b4ecf1e929b`. These HTTPS artifact identities establish the inspected inputs, not reproducible-build or device delivery proof. Tink is cryptography, not Firebase/Play Services. Actual resolved dependency/manifest/dex receipts remain required for the F-Droid APK.

Standard Gradle JUnit tests in the selected native module cover selection, disable ordering, stale epochs and instances, duplicate callbacks, cleanup failure/retry, refresh, endpoint bounds and restart without automatic registration. Packaged Android acceptance checks native status through protected IPC plus actual Keystore/ciphertext and strict-parser boundaries on an owned F-Droid APK. It does not register with a real distributor. Actual host-to-server-to-device delivery, distributor interoperability, cross-boundary lifecycle and background behavior remain #344 work; this is not full #14/#333 push parity. See the enrollment document for the current verification boundary.

## iOS APNs

A signed release maintainer must enable the real push entitlement and App ID capability through [Apple's registration setup](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), then explicitly set `plugins.lazysh-push.apnsEnabled` to `true` in that release's Tauri configuration. This flag declares intended configuration; it does not inspect or prove the code-signing entitlement. The default build does not enable it. The app confirms actual registration only after Apple's success callback. No APNs provider key, certificate, delivery endpoint or account is embedded.

The panel discloses Apple contact and requires initial consent. Existing system-notification authorization must be enabled through the inbox first. A single bounded request calls `UIApplication.registerForRemoteNotifications()` and settles from its actual success/failure delegate callback, with a 30-second timeout. The native process retains the token only in memory and never sends it to the renderer or logs it. Apple explicitly discourages caching tokens in local storage, so only consent persists. Previously opted-in installations request a fresh registration after launch; default/off installations do not contact APNs.

Disable clears the local consent, pending request and in-memory token, and calls Apple's [unregisterForRemoteNotifications](https://developer.apple.com/documentation/uikit/uiapplication/unregisterforremotenotifications()). Late callbacks while disabled cannot reactivate registration, and late permission checks cannot start a cancelled request. This removes the local app association, not global token validity or any future server/account binding. Delivered notifications and system notification permission are separate.

Callbacks delivered on main are processed synchronously. An off-main callback captures the synchronized operation epoch and dispatch phase before a main-thread handoff; stale handoffs cannot complete or fail a newer request, and no callback can complete a request before its actual native registration call begins. APNs does not provide request IDs: this guard identifies the app's callback handoff, not the originating OS request. It does not establish future server/account binding.

Tauri 2.12.5's iOS `Plugin` API exposes no APNs delegate callbacks. Its pinned Tao 0.37.2 runtime creates an `AppDelegate` subclass of `UIResponder` before plugin initialization and later passes that class to `UIApplicationMain`. The Swift plugin uses Apple's documented [class_addMethod](https://developer.apple.com/documentation/objectivec/class_addmethod(_:_:_:_:)) to add only the absent success/failure selectors at that point. It never replaces or exchanges existing implementations, changes the application delegate, or replaces the notification-center delegate used by local notifications. Conflicting selectors or an unexpected delegate class leave the capability unavailable. No `UIApplication.shared` access occurs during plugin initialization: Tao requires it not to exist before `UIApplicationMain`. Actual registration checks the live delegate's exact class again. Recheck this source contract when upgrading Tauri/Tao.

The native iOS unit-test scheme `LazyshPushTests` compiles the Foundation state model with XCTest. It exercises real-callback requirements, ephemeral tokens, pause/late-callback refusal, monotonic operation epochs, timeout isolation and rotation/failure. These state tests do not register with Apple or prove delegate delivery/signing. The Swift plugin's UIKit/Tauri compilation and simulator tests require macOS/Xcode; both are unexecuted locally in this Linux workspace. Signed-device registration and actual remote delivery remain acceptance work.

```sh
APPLE_STATUS_SIMULATOR_ID=<dedicated-simulator-uuid> bunx turbo run test:apns --filter=@lazysh/push-registration
```

## Android FCM

An unconfigured build reports that remote registration is unavailable. The repository contains no Firebase project configuration, provider keys, service-account credentials or default delivery endpoint. A release maintainer must add the Firebase Android application configuration for the actual application ID using the [official Firebase setup](https://firebase.google.com/docs/android/setup). Google Services Gradle processing is not silently enabled; the generated Firebase string resources may instead be supplied through the normal Android resource source set. Never put provider service-account JSON in an Android package.

The plugin uses `com.google.firebase:firebase-messaging:26.0.0`, the version listed by the current [Firebase Android setup documentation](https://firebase.google.com/docs/android/setup), and `play-services-base:18.11.1` for the availability check described in [Google's setup guidance](https://developers.google.com/android/guides/setup). Compatible Google Play services and notification permission are required. The API36 AOSP runtime-test image intentionally has no Google Play services and cannot establish FCM delivery.

Both FCM auto-initialization and analytics collection default to false in the library manifest, following [Firebase's explicit opt-in guidance](https://firebase.google.com/docs/cloud-messaging/android/get-started#prevent-auto-initialization). No Analytics SDK is added. The settings panel explains the external service and requires explicit consent before initial registration. Registration then enables FCM auto-init and requests the current token. The SDK owns token storage; neither Rust command responses nor renderer state contain the token. Only consent and conservative token-presence markers are stored in app-private Android preferences. No SSH metadata, transcripts, prompts or host events are sent by this registration code.

`FirebaseMessagingService.onNewToken` records native rotation without copying or logging the token. Pause immediately disables auto-init and requests `deleteToken()`. If token creation was in flight, deletion waits for its completion; a late token cannot undo pause. Rotation during deletion requires another deletion before the control acknowledges success. A failed deletion keeps a visible retry marker. Native operations serialize register/revoke; another registration cannot race an unfinished revocation. An SDK operation that never finishes can leave the native operation busy; a later app restart and explicit retry may be necessary. Deletion does not remove the Firebase Installation ID or revoke any future relay account binding; no relay exists here. Already-delivered/in-flight notifications may remain visible.

This plugin has no remote payload handler or verified delivery pipeline. Configured Firebase projects must restrict provider access and must not send sensitive notification bodies. Do not infer receipt, authenticated sender validation, cross-device delivery or background execution from a successful token registration.

## Verification

The renderer controls, contact/privacy explanations and retained app-owned failures
support English, Brazilian Portuguese and Spanish. Changing interface language
preserves consent and pending native operation/recovery ownership; it never
registers, revokes or requests OS permission by itself. Native `reason` text,
including empty strings, and provider names remain verbatim. Provider errors stay
behind the existing generic failure messages. This does not translate OS permission
sheets or establish provider availability, token validity or delivery.

The native Vitest cases in `i18n/pushLocales.test.tsx` and synthetic desktop/phone
Playwright cases in `e2e/push-locales.spec.ts` exercise these locale transitions,
including a paused registration's late completion and failed revocation recovery.
They do not invoke APNs/FCM or a real OS permission dialog.

`RegistrationControllerTest` uses standard Gradle JUnit tests and a controllable messaging driver to exercise consent, asynchronous cancellation, late rotation, revocation failure/retry and one-at-a-time operations. The plugin itself compiles against the real FCM Android SDK. These tests do not contact Google or certify device registration. `PushSettingsPanel.test.tsx` uses the client's native Vitest structure to test consent, unavailable configuration, sanitized failures and revocation retry.

After the Tauri Android build has generated plugin metadata, run the package's Android tests through the generated Gradle workspace:

```sh
apps/client/src-tauri/gen/android/gradlew -p apps/client/src-tauri/gen/android :tauri-plugin-lazysh-push:testDebugUnitTest
```

Physical-device registration/rotation/revocation with a dedicated Firebase test project and an actual authenticated sender remain unexecuted. No provider project is created automatically.
