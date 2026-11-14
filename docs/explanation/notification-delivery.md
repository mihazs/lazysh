# Local notifications and background delivery

The inbox uses [Tauri's local notification plugin](https://v2.tauri.app/plugin/notification/). A suspended mobile app cannot keep polling SSH or receive new host events through this path. The separate [native device-registration control](../push-registration.md) supports explicit Android UnifiedPush (Google and FOSS builds), optional Android FCM and iOS APNs registration on configured builds. Registration alone does not connect a remote delivery service or upload inbox events. Only the Android UnifiedPush path binds the app to a relay you operate; background push delivery on other paths, and on physical devices, remains incomplete.

Full remote push requires a separate, opt-in delivery service and native registration lifecycle:

- iOS needs the app's push entitlement, device-token registration, token rotation/revocation, and an authenticated provider that sends through [Apple Push Notification service](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).
- Android without Firebase (Google and FOSS builds) needs a UnifiedPush distributor such as ntfy, a [private Web Push relay](../web-push-server.md) that you operate, encrypted challenge enrollment and separate local display consent. Follow the [Firebase-free setup](../push-registration.md#firebase-free-android-setup). Owned-emulator acceptance covers enrollment and generic event display; physical-device, OEM Doze and signed-release delivery are not established.
- Android with FCM needs Firebase project/application configuration, registration-token management and an authenticated provider using [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/server). This is a separate path from UnifiedPush and Gotify.
- Host events need authenticated ingestion, bounded notification summaries, delivery deduplication, account/device binding, revocation and separately disclosed external data handling. A generic job webhook must authenticate its inputs independently of SSH.

Those remote services, cross-device delivery, cold-start deep links, native push credentials and physical-device lifecycle tests remain tracked in issue #14. No relay endpoint or account is silently configured by enabling this local inbox.

The optional [single-destination webhook relay](../notification-relay.md) provides a separately operated authenticated event path with explicit opt-in companion admission, bounded manual flush and an explicitly started revision-bound foreground sender. No OS sender service or automatic schedule is installed. Its webhook, [Gotify](../notification-relay.md#deliver-through-gotify-without-firebase) and Apprise destinations do not bind this native app or enable APNs/FCM delivery; Gotify and Apprise reach their own external clients. Only the relay's encrypted Web Push mode binds the app's Android UnifiedPush enrollment.

For local setup, see [agent inbox and local notifications](../notifications.md); its [reference](../reference/inbox.md) describes polling and retention limits.
