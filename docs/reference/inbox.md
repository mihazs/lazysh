# Inbox monitoring reference

Repeated snapshots and multiple connections to the same host do not duplicate an event. The inbox keeps the latest status per agent session, at most 100 rows. Archive or clear removes visible rows while retaining bounded deduplication identifiers; an agent's next changed event can appear again. The device stores status metadata and up to 4,000 hashed identifiers locally. It excludes prompt summaries, transcripts, tool arguments and credentials. Clearing the application's data also removes the deduplication history and notification preferences.

Monitoring considers up to 32 distinct connected hosts, with at most four snapshot requests in flight. Polls run every 15 seconds while the app can execute, without overlapping a previous poll. **Refresh inbox** requests an immediate poll. Unchanged snapshots do not rewrite persistent storage. Notification permission is not checked repeatedly when there are no new alerts.

Selecting an inbox row or supported OS notification action opens only the exact producing SSH connection, if it is still connected to the same saved host. It does not reconnect or send input. Windows reports notification clicks only while the toast is on screen; desktop delivery depends on the notification server and installed-app identity.

For setup, see [agent inbox and local notifications](../notifications.md). For delivery boundaries, see [notification delivery](../explanation/notification-delivery.md).
