# Agent inbox and local notifications

Open **Inbox** and enable **Monitor connected hosts** after installing the host companion's lifecycle hooks. Monitoring reads normalized status snapshots over existing, host-key-verified SSH connections. It does not open a listener or upload transcripts. The first snapshot establishes a baseline without producing a burst of old alerts.

**Enable system notifications** explicitly checks or requests the OS notification permission. **Test notification** submits a local test. New `needs_attention` events produce one alert containing the agent name and project directory. Permission denial leaves the inbox usable. **Pause system notifications** stops alerts while collection continues; uncheck monitoring to stop collection too.

Repeated snapshots and multiple connections to the same host do not duplicate an event. The inbox keeps the latest status per agent session, at most 100 rows. Archive or clear removes visible rows while retaining bounded deduplication identifiers; an agent's next changed event can appear again. The device stores status metadata and up to 4,000 hashed identifiers locally. It excludes prompt summaries, transcripts, tool arguments and credentials. Clear the application's data to remove the deduplication history and notification preferences too.

Monitoring considers up to 32 distinct connected hosts, with at most four snapshot requests in flight. Polls run every 15 seconds while the app can execute, without overlapping a previous poll. **Refresh inbox** requests an immediate poll. Unchanged snapshots do not rewrite persistent storage. Notification permission is not checked repeatedly when there are no new alerts.

Selecting an inbox row or a supported OS notification action opens only the exact SSH connection that produced the row, if it is still connected to the same saved host. It never reconnects using a stale notification or sends text to a pane. Inspect or answer the agent through the existing session controls. OS click behavior varies: Windows reports clicks only while its toast is on screen, and desktop delivery depends on the notification server and installed-app identity. See the [Tauri notification API](https://v2.tauri.app/reference/javascript/notification/).

## Background push remains separate

The inbox uses [Tauri's local notification plugin](https://v2.tauri.app/plugin/notification/). A suspended mobile app cannot keep polling SSH or receive new host events through this path. The separate [native device-registration control](push-registration.md) supports explicit Android FCM and iOS APNs registration on configured builds, but it does not connect a remote delivery service or upload inbox events. Actual background host-event push delivery remains incomplete.

Full remote push requires a separate, opt-in delivery service and native registration lifecycle:

- iOS needs the app's push entitlement, device-token registration, token rotation/revocation, and an authenticated provider that sends through [Apple Push Notification service](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server).
- Android needs Firebase project/application configuration, registration-token management and an authenticated provider using [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging/server).
- Host events need authenticated ingestion, bounded notification summaries, delivery deduplication, account/device binding, revocation and separately disclosed external data handling. A generic job webhook must authenticate its inputs independently of SSH.

Those remote services, cross-device delivery, cold-start deep links, native push credentials and physical-device lifecycle tests remain tracked in issue #14. No relay endpoint or account is silently configured by enabling this local inbox.

The optional [single-destination webhook relay](notification-relay.md) provides a separately operated authenticated event path with explicit opt-in companion admission and bounded manual flush. No automatic sender schedule is installed. It does not bind this native app or enable APNs/FCM delivery; mobile delivery remains unavailable in this phase.
