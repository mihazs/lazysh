# Local notifications and background delivery

The inbox uses [Tauri's local notification plugin](https://v2.tauri.app/plugin/notification/). A suspended mobile app cannot keep polling SSH or receive new host events through this path. The separate [native device-registration control](../push-registration.md) supports explicit Android FCM and iOS APNs registration on configured builds, but it does not connect a remote delivery service or upload inbox events. Actual background host-event push delivery remains incomplete.

Full remote push requires a separate, opt-in delivery service and native registration lifecycle:

- iOS needs the app's push entitlement, device-token registration, token rotation/revocation, and an authenticated provider that sends through [Apple Push Notification service](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).
- Android needs Firebase project/application configuration, registration-token management and an authenticated provider using [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/server).
- Host events need authenticated ingestion, bounded notification summaries, delivery deduplication, account/device binding, revocation and separately disclosed external data handling. A generic job webhook must authenticate its inputs independently of SSH.

Those remote services, cross-device delivery, cold-start deep links, native push credentials and physical-device lifecycle tests remain tracked in issue #14. No relay endpoint or account is silently configured by enabling this local inbox.

The optional [single-destination webhook relay](../notification-relay.md) provides a separately operated authenticated event path with explicit opt-in companion admission, bounded manual flush and an explicitly started revision-bound foreground sender. No OS sender service or automatic schedule is installed. It does not bind this native app or enable APNs/FCM delivery; mobile delivery remains unavailable in this phase.

For local setup, see [agent inbox and local notifications](../notifications.md); its [reference](../reference/inbox.md) describes polling and retention limits.
